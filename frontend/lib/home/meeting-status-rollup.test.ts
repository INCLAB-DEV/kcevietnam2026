import { describe, it, expect } from "vitest"
import { rollupMeetingStatus, type ScheduleEntry } from "./meeting-status-rollup"

function entry(
  partial: Partial<ScheduleEntry> & { status: ScheduleEntry["status"] }
): ScheduleEntry {
  return { id: "m", hasReview: false, direction: "received", ...partial }
}

describe("rollupMeetingStatus", () => {
  it("내가 보낸 proposed 건은 보낸 요청(sentRequests)으로 집계한다", () => {
    const result = rollupMeetingStatus([
      entry({ status: "proposed", direction: "sent" }),
      entry({ status: "proposed", direction: "sent" }),
    ])
    expect(result.sentRequests).toBe(2)
    expect(result.receivedRequests).toBe(0)
  })

  it("내가 받은 proposed 건은 받은 요청(receivedRequests)으로 집계한다", () => {
    const result = rollupMeetingStatus([
      entry({ status: "proposed", direction: "received" }),
      entry({ status: "proposed", direction: "sent" }),
    ])
    expect(result.receivedRequests).toBe(1)
    expect(result.sentRequests).toBe(1)
  })

  it("accepted 건을 미팅 예정(upcoming)으로 집계한다", () => {
    const result = rollupMeetingStatus([entry({ status: "accepted" })])
    expect(result.upcoming).toBe(1)
  })

  it("completed를 집계한다 (노쇼도 completed의 결과 속성이라 completed로 집계 — ADR-0010)", () => {
    const result = rollupMeetingStatus([
      entry({ status: "completed", hasReview: true }),
      entry({ status: "completed", hasReview: true }),
      entry({ status: "completed", hasReview: true }), // 노쇼였던 건도 status는 completed
    ])
    expect(result.completed).toBe(3)
  })

  it("완료(노쇼 포함) 중 회의록 미작성 건만 회의록 작성 대기(pendingReview)로 집계한다", () => {
    const result = rollupMeetingStatus([
      entry({ status: "completed", hasReview: true }),
      entry({ status: "completed", hasReview: false }),
      entry({ status: "completed", hasReview: false }), // 노쇼였던 미작성 건
    ])
    expect(result.pendingReview).toBe(2)
  })

  it("취소/거부 건은 기존 버킷(예정·요청·완료 등)에는 집계하지 않는다 — 홈 카드는 의도적으로 뺀다(#3)", () => {
    const result = rollupMeetingStatus([
      entry({ status: "cancelled" }),
      entry({ status: "rejected" }),
    ])
    expect(result).toEqual({
      sentRequests: 0,
      receivedRequests: 0,
      upcoming: 0,
      completed: 0,
      pendingReview: 0,
      cancelled: 1,
      rejected: 1,
    })
  })

  it("취소/거부 건수를 별도 필드로 집계한다 (#3 F9 — 미팅 화면과 다른 모수를 설명하기 위한 최소 확장)", () => {
    const result = rollupMeetingStatus([
      entry({ status: "cancelled" }),
      entry({ status: "cancelled" }),
      entry({ status: "cancelled" }),
      entry({ status: "rejected" }),
    ])
    expect(result.cancelled).toBe(3)
    expect(result.rejected).toBe(1)
  })

  it("ADR-0005 수락 규칙: 초청 바이어 수신은 즉시 accepted(받은 요청 0), 일반 수신은 proposed(받은 요청 집계)", () => {
    // 초청 바이어 수신 = 거부 단계 없이 즉시 accepted → 받은 요청 0
    const hostedBuyerInbox = rollupMeetingStatus([
      entry({ status: "accepted" }),
      entry({ status: "accepted" }),
    ])
    expect(hostedBuyerInbox.receivedRequests).toBe(0)
    expect(hostedBuyerInbox.upcoming).toBe(2)

    // 일반 바이어/Exhibitor 수신 = proposed로 시작 → 받은 요청으로 집계
    const regularBuyerInbox = rollupMeetingStatus([
      entry({ status: "proposed", direction: "received" }),
      entry({ status: "proposed", direction: "received" }),
    ])
    expect(regularBuyerInbox.receivedRequests).toBe(2)
    expect(regularBuyerInbox.upcoming).toBe(0)
  })
})
