import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { MeetingReasonDialog } from "./meeting-reason-dialog"

// F-MY-001 거절/취소 사유 다이얼로그 — 키워드 라디오 + 'other'면 자유입력 필수.

describe("MeetingReasonDialog", () => {
  it("거절 모드는 거절 사유 3종을 보여주고, 사유 선택 전엔 제출할 수 없다", async () => {
    const onSubmit = vi.fn()
    render(<MeetingReasonDialog mode="reject" open onOpenChange={() => {}} onSubmit={onSubmit} />)

    expect(screen.getByText("미팅 거절")).toBeInTheDocument()
    expect(screen.getByText("관심 분야 불일치")).toBeInTheDocument()
    expect(screen.getByText("일정 불가")).toBeInTheDocument()
    expect(screen.getByText("기타")).toBeInTheDocument()
    // 취소 전용 사유는 없다.
    expect(screen.queryByText("일정 충돌")).not.toBeInTheDocument()

    expect(screen.getByRole("button", { name: "거절하기" })).toBeDisabled()
  })

  it("일반 사유를 고르면 바로 제출할 수 있다(자유입력 불필요)", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<MeetingReasonDialog mode="reject" open onOpenChange={() => {}} onSubmit={onSubmit} />)

    await user.click(screen.getByText("일정 불가"))
    const submit = screen.getByRole("button", { name: "거절하기" })
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(onSubmit).toHaveBeenCalledWith("schedule_unavailable", undefined)
  })

  it("'기타'를 고르면 자유입력이 채워지기 전까지 제출할 수 없다", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<MeetingReasonDialog mode="cancel" open onOpenChange={() => {}} onSubmit={onSubmit} />)

    await user.click(screen.getByText("기타"))
    const submit = screen.getByRole("button", { name: "취소하기" })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText("자세한 사유"), "내부 일정이 겹쳐요")
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(onSubmit).toHaveBeenCalledWith("other", "내부 일정이 겹쳐요")
  })

  it("취소 모드는 취소 사유 4종(일정충돌/상대요청/내부변경/기타)을 보여준다", () => {
    render(<MeetingReasonDialog mode="cancel" open onOpenChange={() => {}} onSubmit={() => {}} />)
    expect(screen.getByText("미팅 취소")).toBeInTheDocument()
    expect(screen.getByText("일정 충돌")).toBeInTheDocument()
    expect(screen.getByText("상대 요청")).toBeInTheDocument()
    expect(screen.getByText("내부 사정 변경")).toBeInTheDocument()
    expect(screen.getByText("기타")).toBeInTheDocument()
  })

  // QA #D: 취소 사유 카드가 모달 폭을 벗어나 오른쪽으로 삐져나가던 레이아웃 회귀 방지.
  // jsdom엔 실제 레이아웃 엔진이 없어 픽셀 단위 검증은 불가하므로, 카드가 모달 폭 안에
  // 들어오도록 강제하는 클래스(폭 제한 + wrap)가 계속 적용돼 있는지를 고정한다.
  it("취소 사유 카드가 모달 폭을 넘지 않도록 폭 제한·줄바꿈 클래스를 유지한다", () => {
    render(<MeetingReasonDialog mode="cancel" open onOpenChange={() => {}} onSubmit={() => {}} />)
    const scheduleConflictOption = screen.getByText("일정 충돌").closest("button")
    expect(scheduleConflictOption).not.toBeNull()
    expect(scheduleConflictOption?.className).toContain("w-full")
    expect(scheduleConflictOption?.className).toContain("min-w-0")
    expect(scheduleConflictOption?.className).toContain("break-words")

    const dialogContent = screen.getByText("미팅 취소").closest("[data-slot='dialog-content']")
    expect(dialogContent?.className).toContain("max-w-sm")
  })
})
