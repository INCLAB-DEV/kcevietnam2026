// QA 3차 #1 — MeetingDetailPanel의 cancelAction 오버레이. 기본은 참가자 취소(cancelMeeting,
// /api/meetings/{id}/cancel)인데, 운영자 배정 슬라이드(assignment-hub)처럼 운영자가 당사자가
// 아닌 관점에서 이 패널을 재사용하는 화면은 cancelAction prop으로 운영자 전용 취소를 주입한다.
// meeting-timeline.test.tsx와 같은 모킹 패턴(next/navigation, isMeetingHttpMode).

import { render, screen, fireEvent, waitFor } from "@/lib/test/render-with-intl"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { MeetingDetailPanel } from "./meeting-detail-panel"
import type { MeetingPanelView } from "@/lib/meeting/meeting-panel"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}))

const actionMocks = vi.hoisted(() => ({
  cancelMeeting: vi.fn(async () => ({ success: true })),
}))
vi.mock("@/lib/meeting/meeting-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meeting/meeting-actions")>()
  return {
    ...actual,
    isMeetingHttpMode: () => true,
    cancelMeeting: actionMocks.cancelMeeting,
  }
})

function panel(partial: Partial<MeetingPanelView> = {}): MeetingPanelView {
  return {
    meetingId: "m1",
    status: "accepted",
    tone: "green",
    statusLabel: "미팅 예정",
    reviewDone: false,
    direction: "sent",
    directionLabel: "내가 신청",
    time: "10:00",
    endTime: "10:30",
    venue: "비즈니스룸 1",
    actions: ["cancel"],
    counterpart: {
      id: "ex-001",
      name: "한화시스템",
      role: "exhibitor",
      typeLabel: "참가사",
    },
    org: { id: "ex-001", name: "한화시스템", role: "exhibitor", keywords: [] },
    viewerRole: "buyer",
    match: null,
    members: [],
    detailHref: "/discover/ex-001",
    ...partial,
  }
}

async function submitCancel() {
  fireEvent.click(screen.getByRole("button", { name: "취소" }))
  fireEvent.click(await screen.findByRole("button", { name: "일정 충돌" }))
  fireEvent.click(screen.getByRole("button", { name: "취소하기" }))
}

describe("MeetingDetailPanel — cancelAction 오버라이드", () => {
  beforeEach(() => actionMocks.cancelMeeting.mockClear())

  it("cancelAction을 안 주면 기본 참가자 cancelMeeting을 쓴다", async () => {
    render(
      <>
        <MeetingDetailPanel view={panel()} />
        <Toaster />
      </>
    )
    await submitCancel()
    await waitFor(() => expect(actionMocks.cancelMeeting).toHaveBeenCalledWith("m1", "schedule_conflict", undefined))
  })

  it("cancelAction을 주면 기본 cancelMeeting 대신 그 함수를 쓴다(운영자 전용 취소 경로)", async () => {
    const organizerCancel = vi.fn(async () => ({ success: true }))
    render(
      <>
        <MeetingDetailPanel view={panel()} cancelAction={organizerCancel} />
        <Toaster />
      </>
    )
    await submitCancel()
    await waitFor(() => expect(organizerCancel).toHaveBeenCalledWith("m1", "schedule_conflict", undefined))
    expect(actionMocks.cancelMeeting).not.toHaveBeenCalled()
  })
})

// 2026-10-26 발주사 피드백: 승인 전 바이어(탐색 목록 밖)와의 미팅 — org가 null이면 Discover 상세(404)로
// 가는 "기업 상세 보기"를 숨기되 회의록 작성 등 액션은 그대로 보인다.
describe("MeetingDetailPanel — 기업 상세 보기 푸터", () => {
  it("view.org가 있으면 '기업 상세 보기'를 보여준다", () => {
    render(<MeetingDetailPanel view={panel()} />)
    expect(screen.getByRole("link", { name: /기업 상세 보기/ })).toBeInTheDocument()
  })

  it("view.org가 null이면 '기업 상세 보기'를 숨기고 [회의록 작성] 액션은 유지한다", () => {
    render(
      <MeetingDetailPanel
        view={panel({
          org: null,
          actions: ["review"],
          counterpart: { id: "by-reg", name: "미승인 바이어㈜", role: "buyer", typeLabel: "바이어" },
          detailHref: "/discover/by-reg",
        })}
      />
    )
    expect(screen.queryByRole("link", { name: /기업 상세 보기/ })).not.toBeInTheDocument()
    expect(screen.getByText("미승인 바이어㈜")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /회의록 작성/ })).toHaveAttribute("href", "/meetings/m1")
  })
})
