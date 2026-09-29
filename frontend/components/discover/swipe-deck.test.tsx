import { render, screen, cleanup } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwipeDeck } from "./swipe-deck"
import { __resetFeedbackForTest } from "@/lib/discover/feedback-store"
import type { MatchResult } from "@/lib/api-client"
import type { Organization } from "@/lib/types"

function ex(id: string, name: string): Organization {
  return { id, name, role: "exhibitor", keywords: ["레이더"], booth: { hallNo: "1", hallName: "제1전시관", code: "A-1" }, strength: "강점" }
}

const deck: MatchResult[] = [
  { org: ex("a", "한화시스템"), aiScore: 92, aiReasons: ["레이더 분야 일치"] },
  { org: ex("b", "LIG넥스원"), aiScore: 71, aiReasons: ["감시정찰 연관"] },
  { org: ex("c", "현대로템"), aiScore: 40, aiReasons: ["지상전력 연관"] },
]

describe("SwipeDeck", () => {
  beforeEach(() => {
    __resetFeedbackForTest()
  })

  it("추천 카드들을 캐러셀 슬라이드로 렌더한다", () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByRole("heading", { name: "한화시스템" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "현대로템" })).toBeInTheDocument()
  })

  it("적합도 점수와 추천 이유를 표시한다", () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByText(/92/)).toBeInTheDocument()
    expect(screen.getByText("레이더 분야 일치")).toBeInTheDocument()
  })

  // --- 네비게이션(캐러셀 기본 좌/우 버튼) ---

  it("캐러셀 좌/우 버튼을 제공하고 첫 카드에서는 '이전 추천'이 비활성화된다", () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByRole("button", { name: "다음 추천" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "이전 추천" })).toBeDisabled()
  })

  // --- 피드백 (안내 + 예/아니오 + 사유) — 현재(첫) 카드 기준 ---

  it("피드백 안내 문구를 보여준다", () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByText("추천이 적절했나요?")).toBeInTheDocument()
  })

  it("'예'를 누르면 적절 피드백을 기록하고 평가 영역을 숨긴다", async () => {
    const onFeedback = vi.fn()
    render(<SwipeDeck results={deck} viewerRole="buyer" onFeedback={onFeedback} />)
    await userEvent.click(screen.getByRole("button", { name: "예" }))
    expect(onFeedback).toHaveBeenCalledWith("a", true)
    expect(screen.queryByText("추천이 적절했나요?")).not.toBeInTheDocument()
  })

  it("'아니오'를 누르면 거절 사유 선택지가 나타난다", async () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "아니오" }))
    expect(screen.getByRole("button", { name: "분야가 맞지 않음" })).toBeInTheDocument()
    expect(screen.queryByText("추천이 적절했나요?")).not.toBeInTheDocument()
  })

  it("사유를 선택하면 부적절+사유를 기록하고 사유 선택지를 닫는다 (제외는 부모가 처리)", async () => {
    const onFeedback = vi.fn()
    render(<SwipeDeck results={deck} viewerRole="buyer" onFeedback={onFeedback} />)
    await userEvent.click(screen.getByRole("button", { name: "아니오" }))
    await userEvent.click(screen.getByRole("button", { name: "분야가 맞지 않음" }))
    expect(onFeedback).toHaveBeenCalledWith("a", false, "분야가 맞지 않음")
    expect(screen.getByRole("button", { name: "예" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "분야가 맞지 않음" })).not.toBeInTheDocument()
  })

  it("사유 노출 중 '뒤로'를 누르면 예/아니오로 돌아간다", async () => {
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "아니오" }))
    await userEvent.click(screen.getByRole("button", { name: "← 뒤로" }))
    expect(screen.getByRole("button", { name: "예" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "분야가 맞지 않음" })).not.toBeInTheDocument()
  })

  it("빈 추천 목록이면 안내 메시지를 보여준다", () => {
    render(<SwipeDeck results={[]} viewerRole="buyer" />)
    expect(screen.getByText(/추천할 기업이 없습니다/)).toBeInTheDocument()
  })

  // --- 피드백 응답 영속(QA #E: "예 눌러도 다른 곳 갔다 오면 계속 나옴") ---

  it("'예'로 답한 후 컴포넌트가 재마운트돼도(다른 화면 갔다 옴) 다시 묻지 않는다", async () => {
    const { unmount } = render(<SwipeDeck results={deck} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "예" }))
    expect(screen.queryByText("추천이 적절했나요?")).not.toBeInTheDocument()

    unmount()
    cleanup()
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.queryByText("추천이 적절했나요?")).not.toBeInTheDocument()
  })

  it("아직 응답하지 않은 기업은 재마운트 후에도 계속 물어본다", () => {
    const { unmount } = render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByText("추천이 적절했나요?")).toBeInTheDocument()
    unmount()
    cleanup()
    render(<SwipeDeck results={deck} viewerRole="buyer" />)
    expect(screen.getByText("추천이 적절했나요?")).toBeInTheDocument()
  })
})
