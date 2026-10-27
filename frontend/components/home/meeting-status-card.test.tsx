import { render, screen } from "@/lib/test/render-with-intl"
import { describe, it, expect } from "vitest"
import { MeetingStatusCard } from "./meeting-status-card"
import type { MeetingStatusRollup } from "@/lib/home/meeting-status-rollup"

const rollup: MeetingStatusRollup = {
  upcoming: 5,
  sentRequests: 2,
  receivedRequests: 3,
  completed: 3, // 노쇼 포함(ADR-0010: 노쇼는 completed의 결과 속성)
  pendingReview: 4,
  cancelled: 0,
  rejected: 0,
}

describe("MeetingStatusCard", () => {
  it("4개 타일(미팅 예정·요청한 미팅·받은 미팅요청·미팅 완료)을 건수와 함께 표시한다", () => {
    render(<MeetingStatusCard rollup={rollup} />)
    expect(screen.getByText("미팅 예정").closest("a")).toHaveTextContent("5")
    expect(screen.getByText("요청한 미팅").closest("a")).toHaveTextContent("2")
    expect(screen.getByText("받은 미팅요청").closest("a")).toHaveTextContent("3")
    // 미팅 완료 = completed(3, 노쇼 포함)
    expect(screen.getByText("미팅 완료").closest("a")).toHaveTextContent("3")
  })

  it("노쇼·회의록 작성은 현황에 별도 타일로 두지 않는다", () => {
    render(<MeetingStatusCard rollup={rollup} />)
    expect(screen.queryByText("노쇼")).not.toBeInTheDocument()
    expect(screen.queryByText("회의록 작성")).not.toBeInTheDocument()
  })

  it("상태 타일은 내 미팅(MY-001, /meetings)으로 이동한다", () => {
    render(<MeetingStatusCard rollup={rollup} />)
    expect(screen.getByText("미팅 예정").closest("a")).toHaveAttribute("href", "/meetings")
    expect(screen.getByText("받은 미팅요청").closest("a")).toHaveAttribute("href", "/meetings")
  })

  it("헤더 '전체 보기' CTA로 미팅 목록(/meetings)으로 이동한다", () => {
    render(<MeetingStatusCard rollup={rollup} />)
    expect(screen.getByRole("link", { name: /전체 보기/ })).toHaveAttribute("href", "/meetings")
  })

  it("취소·거절 합이 1 이상이면 제외 안내 문구를 건수와 함께 표시한다", () => {
    render(<MeetingStatusCard rollup={{ ...rollup, cancelled: 2, rejected: 1 }} />)
    expect(screen.getByText("취소·거절 3건 제외")).toBeInTheDocument()
  })

  it("취소·거절이 0건이면 제외 안내 문구를 표시하지 않는다", () => {
    render(<MeetingStatusCard rollup={rollup} />)
    expect(screen.queryByText(/제외/)).not.toBeInTheDocument()
  })
})
