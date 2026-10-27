import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  recordFeedback,
  getFeedbackAnswer,
  clearFeedback,
  __resetFeedbackForTest,
} from "./feedback-store"

// feedback-store — "추천이 적절했나요?" 위젯 응답의 로컬 영속(QA #E).
// 재방문(재마운트)해도 이미 답한 기업은 다시 묻지 않아야 한다.
describe("feedback-store", () => {
  beforeEach(() => {
    __resetFeedbackForTest()
  })

  it("응답 전에는 기록이 없다", () => {
    expect(getFeedbackAnswer("org-1")).toBeUndefined()
  })

  it("'적절' 응답을 기록한다", () => {
    recordFeedback("org-1", "appropriate")
    expect(getFeedbackAnswer("org-1")).toBe("appropriate")
  })

  it("'부적절' 응답을 기록한다", () => {
    recordFeedback("org-1", "inappropriate")
    expect(getFeedbackAnswer("org-1")).toBe("inappropriate")
  })

  it("같은 기업을 다시 평가하면 최신 응답으로 덮어쓴다", () => {
    recordFeedback("org-1", "appropriate")
    recordFeedback("org-1", "inappropriate")
    expect(getFeedbackAnswer("org-1")).toBe("inappropriate")
  })

  it("기업마다 독립적으로 기록한다(화면 전체 1회가 아니라 기업 단위)", () => {
    recordFeedback("org-1", "appropriate")
    expect(getFeedbackAnswer("org-2")).toBeUndefined()
  })

  it("clearFeedback으로 기록을 지우면 다시 미응답 상태가 된다", () => {
    recordFeedback("org-1", "inappropriate")
    clearFeedback("org-1")
    expect(getFeedbackAnswer("org-1")).toBeUndefined()
  })

  it("저장된 값은 localStorage 키에 직렬화된다", () => {
    recordFeedback("org-9", "appropriate")
    const raw = window.localStorage.getItem("nabi:discover:recommendation-feedback")
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toEqual({ "org-9": "appropriate" })
  })

  it("새로고침(모듈 재로드) 후에도 localStorage에서 복원된다 — 재방문 시 다시 묻지 않는 핵심 동작", async () => {
    recordFeedback("org-1", "appropriate")
    vi.resetModules()
    const fresh = await import("./feedback-store")
    expect(fresh.getFeedbackAnswer("org-1")).toBe("appropriate")
    fresh.__resetFeedbackForTest()
  })
})
