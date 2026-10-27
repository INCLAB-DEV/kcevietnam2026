// 준비 상태 헬스체크(/api/health/ready) 회귀 잠금 — 백엔드 /health/ready의 200/503을 그대로 비추고, 백엔드가
// 죽었거나 응답이 늦으면 503으로 끊는다. 생존 확인(/api/health)은 백엔드와 무관하게 그대로 200이다.
import { afterEach, describe, expect, it, vi } from "vitest"

import { GET } from "./route"
import { GET as liveness } from "../route"

describe("GET /api/health/ready", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("백엔드 ready가 200이면 200 ok", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe("http://localhost:8000/health/ready")
    expect(init.signal).toBeInstanceOf(AbortSignal) // 응답 대기 상한이 걸려 있다
  })

  it("백엔드 ready가 503이면 503 unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "unavailable" }), { status: 503 })))

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: "unavailable" })
  })

  it("백엔드에 연결할 수 없으면 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )

    const response = await GET()

    expect(response.status).toBe(503)
  })

  it("백엔드가 응답하지 않으면 1.5초 상한에서 끊고 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          }),
      ),
    )
    const started = Date.now()

    const response = await GET()

    expect(response.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("생존 확인(/api/health)은 백엔드를 부르지 않고 그대로 200", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = liveness()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
