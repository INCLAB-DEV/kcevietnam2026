// 회의록 BFF 본문 처리 회귀 잠금 — 녹음 상한 200MB(2026-10-02) 이후로는 본문을 모으지 않고 스트림 그대로
// 백엔드에 흘려보낸다(예전엔 arrayBuffer()로 다 모아 업로드마다 Next 메모리에 파일이 통째로 올라왔다).
//
// 잠그는 것:
// - 본문은 ReadableStream 그대로 백엔드 fetch에 넘어가고(duplex: "half"), 요청의 arrayBuffer()는 부르지 않는다.
//   넘어간 바이트는 원본과 같다.
// - content-length가 상한(201MB = 녹음 200MB + 여유 1MB)을 넘으면 본문을 한 바이트도 읽지 않고 413(audio_too_large) —
//   백엔드와 같은 모양. 백엔드는 부르지 않는다.
// - content-length가 없으면(청크 전송) 흘려보내며 누적 크기를 재다가 상한을 넘는 순간 스트림을 끊고 413 —
//   그 뒤 덩어리는 더 꺼내지 않는다.
// - 상한 초과가 아닌 fetch 실패(백엔드 다운 등)는 예전처럼 그대로 던진다.
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test-session" }) }),
}))

import { GET, POST } from "./route"

const MB = 1024 * 1024
const LIMIT = 201 * MB
const ctx = { params: Promise.resolve({ path: ["meeting-1", "review", "step2", "transcribe"] }) }
const URL_ = "http://localhost/api/reviews/meeting-1/review/step2/transcribe"
// 화면은 code만 본다(문구는 화면 로케일의 카탈로그) — message는 로그용 영문 설명이다.
const TOO_LARGE = {
  detail: { code: "audio_too_large", message: "Recording exceeds the 200MB upload limit" },
}

// 덩어리를 n개 흘려보내는 스트림 — 몇 개를 실제로 꺼내 갔는지 센다(상한에서 멈췄는지 확인용).
// highWaterMark 0: 스트림이 미리 당겨 두지 않고, 읽는 쪽이 읽을 때만 한 덩어리씩 만든다.
function chunkStream(chunks: number, chunkBytes = MB, fill = 0) {
  const pulled = { count: 0 }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled.count >= chunks) {
          controller.close()
          return
        }
        pulled.count += 1
        controller.enqueue(new Uint8Array(chunkBytes).fill(fill))
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, pulled }
}

// undici(fetch)처럼 넘겨받은 본문 스트림을 끝까지 읽는 백엔드 대역 — 읽기가 끊기면 fetch 실패로 던진다.
function drainingBackend(response: () => Response = () => jsonAccepted()) {
  const received = { bytes: 0, chunks: [] as Uint8Array[] }
  const fetchMock = vi.fn(async (_target: string, init: RequestInit) => {
    const body = init.body as ReadableStream<Uint8Array> | undefined
    if (body) {
      const reader = body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received.bytes += value.byteLength
          received.chunks.push(value)
        }
      } catch (cause) {
        throw new TypeError("fetch failed", { cause })
      }
    }
    return response()
  })
  return { fetchMock, received }
}

function jsonAccepted() {
  return new Response(JSON.stringify({ job_id: "job-1", status: "pending" }), {
    status: 202,
    headers: { "content-type": "application/json" },
  })
}

function streamingRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x", ...headers },
    body,
    duplex: "half",
  } as RequestInit)
}

describe("reviews BFF — 본문 스트리밍 + 상한(201MB)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("본문을 모으지 않고 스트림 그대로(duplex half) 백엔드로 넘기며, 바이트는 원본과 같다", async () => {
    const { fetchMock, received } = drainingBackend()
    vi.stubGlobal("fetch", fetchMock)
    const { stream } = chunkStream(3, 1000, 7) // content-length 없음, 3000바이트
    const request = streamingRequest(stream)
    const arrayBuffer = vi.spyOn(request, "arrayBuffer")

    const response = await POST(request, ctx)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ job_id: "job-1", status: "pending" })
    expect(arrayBuffer).not.toHaveBeenCalled() // 요청 본문을 통째로 메모리에 올리지 않는다
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [target, init] = fetchMock.mock.calls[0]
    expect(target).toBe("http://localhost:8000/meetings/meeting-1/review/step2/transcribe")
    expect(init.body).toBeInstanceOf(ReadableStream)
    expect((init as RequestInit & { duplex?: string }).duplex).toBe("half")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("multipart/form-data; boundary=x")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-session")
    expect(received.bytes).toBe(3000)
    expect(received.chunks.every((c) => c.every((b) => b === 7))).toBe(true)
  })

  it("content-length가 상한을 넘으면 본문을 읽지 않고 413, 백엔드는 부르지 않는다", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { stream, pulled } = chunkStream(400)

    const response = await POST(streamingRequest(stream, { "content-length": String(LIMIT + 1) }), ctx)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual(TOO_LARGE)
    expect(pulled.count).toBe(0) // 한 덩어리도 꺼내지 않았다
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("content-length가 없으면 흘려보내며 재다가 상한을 넘는 순간 끊고 413 — 나머지는 꺼내지 않는다", async () => {
    const { fetchMock, received } = drainingBackend()
    vi.stubGlobal("fetch", fetchMock)
    const chunk = 4 * MB
    const { stream, pulled } = chunkStream(100, chunk) // 400MB짜리 청크 전송

    const response = await POST(streamingRequest(stream), ctx)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual(TOO_LARGE)
    // 201MB를 넘긴 51번째 덩어리(204MB)에서 끊었다 — 백엔드로는 상한 안의 덩어리만 넘어갔고, 400MB를 끝까지
    // 당기지 않는다(파이프 내부 버퍼 몫으로 한두 덩어리 더 당겨질 수는 있다).
    expect(received.bytes).toBeLessThanOrEqual(LIMIT)
    expect(pulled.count).toBeGreaterThanOrEqual(51)
    expect(pulled.count).toBeLessThanOrEqual(53)
  })

  it("상한과 같은 content-length는 통과한다", async () => {
    const { fetchMock } = drainingBackend()
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(LIMIT) },
        body: "{}",
      }),
      ctx,
    )

    expect(response.status).toBe(202)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("상한 초과가 아닌 fetch 실패(백엔드 다운)는 그대로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    const { stream } = chunkStream(1, 10)

    await expect(POST(streamingRequest(stream), ctx)).rejects.toThrow("fetch failed")
  })

  it("폴링(GET)은 본문 없이 그대로 통과한다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "pending", draft: null, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const pollCtx = { params: Promise.resolve({ path: ["meeting-1", "review", "step2", "transcribe", "job-1"] }) }

    const response = await GET(new Request(`${URL_}/job-1`), pollCtx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "pending", draft: null, error: null })
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe("http://localhost:8000/meetings/meeting-1/review/step2/transcribe/job-1")
    expect(init.body).toBeUndefined()
  })
})
