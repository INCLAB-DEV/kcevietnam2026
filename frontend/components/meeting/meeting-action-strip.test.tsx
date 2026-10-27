import { render, screen, fireEvent } from "@/lib/test/render-with-intl"
import { describe, it, expect, vi } from "vitest"
import { MeetingActionStrip } from "./meeting-action-strip"
import type { ActionStripView } from "@/lib/meeting/action-strip"

const empty: ActionStripView = {
  receivedRequests: 0,
  earliestReceivedId: null,
  pendingReview: 0,
  earliestReviewId: null,
}

describe("MeetingActionStrip", () => {
  it("받은 미팅요청·회의록 둘 다 0이면 아무것도 렌더하지 않는다(평소엔 깔끔한 일정)", () => {
    const { container } = render(<MeetingActionStrip view={empty} onJump={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("받은 미팅요청은 건수와 함께 alert 액센트로 띄우고, 탭하면 가장 이른 건으로 점프한다", () => {
    const onJump = vi.fn()
    render(
      <MeetingActionStrip
        view={{ ...empty, receivedRequests: 2, earliestReceivedId: "r1" }}
        onJump={onJump}
      />
    )
    expect(screen.getByText("받은 미팅요청")).toBeInTheDocument()
    expect(screen.getByText("2건")).toBeInTheDocument()
    const row = screen.getByText("받은 미팅요청").closest("button")!
    expect(row.className).toContain("border-destructive/40")
    fireEvent.click(row)
    expect(onJump).toHaveBeenCalledWith("r1")
  })

  it("회의록은 중립 행으로 띄우고, 탭하면 가장 이른 작성 대상으로 점프한다", () => {
    const onJump = vi.fn()
    render(
      <MeetingActionStrip
        view={{ ...empty, pendingReview: 3, earliestReviewId: "c1" }}
        onJump={onJump}
      />
    )
    const row = screen.getByText("회의록").closest("button")!
    expect(row.className).not.toContain("border-destructive/40")
    fireEvent.click(row)
    expect(onJump).toHaveBeenCalledWith("c1")
  })

  it("건수가 있어도 점프 대상 id가 없으면 그 행은 렌더하지 않는다(방어)", () => {
    render(
      <MeetingActionStrip
        view={{ ...empty, receivedRequests: 1, earliestReceivedId: null }}
        onJump={() => {}}
      />
    )
    expect(screen.queryByText("받은 미팅요청")).not.toBeInTheDocument()
  })
})
