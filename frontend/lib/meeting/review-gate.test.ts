import { describe, expect, it } from "vitest"
import { shouldShowReviewFlow } from "./review-gate"

// H-04 회귀 잠금 + 2026-09-14 제품 결정(확정 미팅이면 행사 전이라도 회의록 자유 작성) — 확정 전
// (proposed 등) 미팅에는 여전히 회의록 폼 대신 상세를 보여줘야 하고, accepted/completed는 둘 다
// 회의록 플로우를 보여줘야 한다. 이 판정 하나가 페이지의 분기 전체를 결정한다.
describe("shouldShowReviewFlow — H-04 + 2026-09-14 확정 미팅 회의록 자유화", () => {
  it("accepted·completed는 회의록 플로우를 보여준다", () => {
    expect(shouldShowReviewFlow("accepted")).toBe(true)
    expect(shouldShowReviewFlow("completed")).toBe(true)
  })

  it("proposed/cancelled/rejected는 회의록이 아니라 미팅 상세를 보여줘야 한다", () => {
    expect(shouldShowReviewFlow("proposed")).toBe(false)
    expect(shouldShowReviewFlow("cancelled")).toBe(false)
    expect(shouldShowReviewFlow("rejected")).toBe(false)
  })
})
