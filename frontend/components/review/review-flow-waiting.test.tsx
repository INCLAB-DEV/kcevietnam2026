// 전사 지연 안내 회귀 잠금(동시성 하드닝 1차 후속) — 추적기가 "처음 2분이 지나도 pending"(onWaiting)을
// 알리면 화면은 오류가 아니라 중립 안내(정리 중 — 요청이 많으면 더 걸릴 수 있음)를 띄우고, 끝나면 안내를
// 거두고 초안을 채운다. 백엔드는 대기열 대기와 처리 중을 구분해 주지 않으므로 어느 쪽이든 참인 문구여야 한다.
// 폴링 일정 자체(2분·5초·30분)는 lib/review/transcription-tracker.test.ts가 가짜 시계로 잠근다 — 여기서는
// 추적기를 가로채 그 콜백을 직접 불러 화면 배선만 본다.
import { act, render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { ReviewFlow } from "./review-flow"
import type { StructureDraft, TranscriptionFailure } from "@/lib/review/types"

type Handlers = {
  onWaiting?: () => void
  onDone?: (draft: StructureDraft) => void
  onError?: (failure: TranscriptionFailure) => void
}

const captured: { handlers: Handlers | null } = { handlers: null }

vi.mock("@/lib/review/transcription-tracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/review/transcription-tracker")>()
  return {
    ...actual,
    trackTranscription: vi.fn((_args: unknown, handlers: Handlers) => {
      captured.handlers = handlers
      return () => {}
    }),
  }
})

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

const WAITING = "정리 중이에요. 요청이 많으면 조금 더 걸릴 수 있어요."

const DRAFT: StructureDraft = {
  report: { discussion: ["애니메이션 IP 동남아 배급 논의"], agreements: [], actions: [] },
  fitSuggestion: "good",
  fitReasonSeed: "",
  fitReasonTags: [],
  transcript: "전사 원문",
  transcriptTurns: [],
}

let seq = 0

async function startRecordingTranscription() {
  seq += 1
  const user = userEvent.setup()
  const { container } = render(
    <ReviewFlow meetingId={`review-flow-waiting-${seq}`} counterpartOrg="풍산" orgId="org-exhibitor" />,
  )
  await screen.findByText("녹음 업로드")
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, new File(["x"], "meeting.m4a", { type: "audio/m4a" }))
  await user.click(screen.getByRole("button", { name: "AI로 정리하기" }))
  await waitFor(() => expect(captured.handlers).not.toBeNull())
  return captured.handlers as Handlers
}

describe("ReviewFlow — 전사가 오래 걸릴 때의 안내", () => {
  beforeEach(() => {
    captured.handlers = null
    vi.mocked(toast.error).mockClear()
  })

  it("2분이 지나도 안 끝나면 '조금 더 걸릴 수 있어요'를 띄우고(오류 아님), 끝나면 안내를 거두고 초안을 채운다", async () => {
    const handlers = await startRecordingTranscription()
    // 처음엔 안내가 없다 — 추적기가 2분이 지났다고 알릴 때만 뜬다.
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()

    act(() => handlers.onWaiting?.())
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
    // 정리는 계속 진행 중이다 — 버튼은 여전히 '정리하는 중…'.
    expect(screen.getByRole("button", { name: /정리하는 중/ })).toBeDisabled()

    act(() => handlers.onDone?.(DRAFT))
    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument())
    expect(screen.getByDisplayValue("애니메이션 IP 동남아 배급 논의")).toBeInTheDocument()
  })

  it("30분 상한에 걸려 지연으로 끝나면 안내를 거두고 지연 사유를 띄운다", async () => {
    const handlers = await startRecordingTranscription()
    act(() => handlers.onWaiting?.())
    expect(await screen.findByText(WAITING)).toBeInTheDocument()

    // 추적기는 실패 종류("delayed")만 알리고, 문구는 화면이 카탈로그(review.toast.transcriptionDelayed)에서 뽑는다.
    act(() => handlers.onError?.("delayed"))
    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument())
    expect(toast.error).toHaveBeenCalledWith("전사가 지연되고 있어요. 잠시 후 다시 시도해 주세요.")
  })

  it("녹음 길이 상한 초과로 끝나면 상한(분)과 나눠 올리라는 안내를 띄운다", async () => {
    const handlers = await startRecordingTranscription()

    act(() => handlers.onError?.("audioTooLong"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "녹음이 너무 길어요(최대 45분). 45분 이하로 나눠서 다시 올려 주세요.",
      ),
    )
  })
})
