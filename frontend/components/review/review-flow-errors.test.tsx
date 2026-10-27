// 회의록 화면의 실패 안내 회귀 잠금(동시성 하드닝 1차) — 실 세션(HTTP 클라이언트) 경로에서 fetch만 가짜로
// 바꿔 검증한다(mock 클라이언트는 실패하지 않으므로 이 경로를 못 잡는다).
//
// 잠그는 것:
// - 200MB를 넘는 녹음은 고르는 순간 안내하고, 업로드 요청을 아예 보내지 않는다(2026-10-02 25MB → 200MB).
// - 텍스트 정리 실패가 화면에 보인다: 503(ai_busy)은 "AI 요청이 많아요", 그 밖(502 ai_failed 등)은
//   "회의록 정리에 실패했어요". 예전엔 아무것도 안 떴다.
// - 녹음 업로드가 413/503이면 각각 크기 초과·AI 바쁨 안내를 띄운다.
import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { ReviewFlow } from "./review-flow"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

const TOO_LARGE =
  "녹음 파일이 200MB를 넘어 올릴 수 없어요. 녹음을 나눠 올리거나 ‘직접 입력’ 탭에 메모로 정리해 주세요."
const AI_BUSY = "AI 요청이 많아요. 잠시 후 다시 시도해 주세요."
const STRUCTURE_FAILED = "회의록 정리에 실패했어요. 잠시 후 다시 시도해 주세요."

let seq = 0
function freshMeetingId() {
  seq += 1
  return `review-flow-errors-${seq}`
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// 진입 시 getReview(GET .../review)는 404(=새 회의록)로 답하고, 그 밖의 요청만 테스트가 정한다.
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/review") && (init?.method ?? "GET") === "GET") return new Response("", { status: 404 })
    return handler(url, init)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function audioFile(size: number): File {
  const file = new File(["x"], "meeting.m4a", { type: "audio/m4a" })
  // 실제 200MB를 만들지 않고 크기만 흉내 낸다(화면은 file.size로 판단한다).
  Object.defineProperty(file, "size", { value: size })
  return file
}

async function renderFlow() {
  const view = render(
    <ReviewFlow meetingId={freshMeetingId()} counterpartOrg="풍산" orgId="org-exhibitor" realSession />,
  )
  await screen.findByText("녹음 업로드")
  return view
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

const calledWith = (fetchMock: ReturnType<typeof vi.fn>, part: string) =>
  fetchMock.mock.calls.some(([u]) => String(u).includes(part))

describe("ReviewFlow — 녹음 크기 상한(200MB)", () => {
  beforeEach(() => vi.mocked(toast.error).mockClear())
  afterEach(() => vi.unstubAllGlobals())

  it("200MB를 넘는 녹음은 고르는 순간 안내하고, 업로드 요청을 보내지 않는다", async () => {
    const fetchMock = stubFetch((url) => {
      throw new Error(`요청이 나가면 안 된다: ${url}`)
    })
    const user = userEvent.setup()
    const { container } = await renderFlow()

    await user.upload(fileInput(container), audioFile(200 * 1024 * 1024 + 1))

    expect(toast.error).toHaveBeenCalledWith(TOO_LARGE)
    // 선택 자체를 받지 않았으니 AI 버튼은 비활성 — 전사 업로드 요청은 한 번도 나가지 않았다.
    expect(screen.getByRole("button", { name: "AI로 정리하기" })).toBeDisabled()
    expect(calledWith(fetchMock, "/transcribe")).toBe(false)
  })

  it("업로드 영역에 크기·길이 상한(200MB · 45분)과 빠른 네트워크 권장을 미리 안내한다", async () => {
    stubFetch((url) => {
      throw new Error(`요청이 나가면 안 된다: ${url}`)
    })
    await renderFlow()
    expect(screen.getByText(/최대 200MB · 45분/)).toBeInTheDocument()
    expect(screen.getByText("큰 파일은 Wi-Fi 등 빠른 네트워크에서 올려 주세요.")).toBeInTheDocument()
  })

  it("정확히 200MB는 받아들인다(상한 포함)", async () => {
    stubFetch((url) => {
      throw new Error(`요청이 나가면 안 된다: ${url}`)
    })
    const user = userEvent.setup()
    const { container } = await renderFlow()

    await user.upload(fileInput(container), audioFile(200 * 1024 * 1024))

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "AI로 정리하기" })).toBeEnabled()
  })
})

describe("ReviewFlow — AI 정리 실패 안내", () => {
  beforeEach(() => vi.mocked(toast.error).mockClear())
  afterEach(() => vi.unstubAllGlobals())

  async function runTextStructuring(status: number, body: unknown) {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/review/step2/structure")) return jsonResponse(status, body)
      throw new Error(`예상 못 한 요청: ${url}`)
    })
    const user = userEvent.setup()
    await renderFlow()
    await user.click(screen.getByRole("tab", { name: /직접 입력/ }))
    await user.type(
      screen.getByPlaceholderText(
        "무엇을 논의했고, 무엇을 합의했고, 다음에 무엇을 하기로 했는지 자유롭게 적어주세요.",
      ),
      "사거리 연장 논의",
    )
    await user.click(screen.getByRole("button", { name: "AI로 정리하기" }))
    return fetchMock
  }

  it("텍스트 정리가 503(ai_busy)이면 'AI 요청이 많아요'를 띄우고, 다시 누를 수 있다", async () => {
    const fetchMock = await runTextStructuring(503, {
      detail: { code: "ai_busy", message: "AI 요청이 많아요. 잠시 후 다시 시도해 주세요." },
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AI_BUSY))
    expect(calledWith(fetchMock, "/review/step2/structure")).toBe(true)
    // 무한 "정리하는 중…"으로 굳지 않는다 — 버튼이 다시 활성.
    expect(screen.getByRole("button", { name: "AI로 정리하기" })).toBeEnabled()
  })

  it("텍스트 정리가 그 밖의 이유로 실패하면(502 ai_failed) '회의록 정리에 실패했어요'를 띄운다", async () => {
    await runTextStructuring(502, {
      detail: { code: "ai_failed", message: "회의록 정리에 실패했어요. 잠시 후 다시 시도해 주세요." },
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(STRUCTURE_FAILED))
    expect(toast.error).not.toHaveBeenCalledWith(AI_BUSY)
  })

  it("녹음 업로드가 서버에서 413(audio_too_large)이면 크기 초과 안내를 띄운다", async () => {
    stubFetch((url) => {
      if (url.includes("/review/step2/transcribe")) {
        return jsonResponse(413, { detail: { code: "audio_too_large", message: "녹음 파일이 너무 커요(최대 200MB)." } })
      }
      throw new Error(`예상 못 한 요청: ${url}`)
    })
    const user = userEvent.setup()
    const { container } = await renderFlow()
    await user.upload(fileInput(container), audioFile(1024))
    await user.click(screen.getByRole("button", { name: "AI로 정리하기" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(TOO_LARGE))
  })

  it("녹음 업로드가 503이면 'AI 요청이 많아요'를 띄운다", async () => {
    stubFetch((url) => {
      if (url.includes("/review/step2/transcribe")) return new Response("Service Unavailable", { status: 503 })
      throw new Error(`예상 못 한 요청: ${url}`)
    })
    const user = userEvent.setup()
    const { container } = await renderFlow()
    await user.upload(fileInput(container), audioFile(1024))
    await user.click(screen.getByRole("button", { name: "AI로 정리하기" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AI_BUSY))
  })
})
