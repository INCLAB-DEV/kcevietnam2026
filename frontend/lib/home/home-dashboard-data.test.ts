import { describe, it, expect } from "vitest"
import { buildHomeDashboardData, type HomeDashboardInput, type MeetingRecord } from "./home-dashboard-data"

function meeting(partial: Partial<MeetingRecord> & { id: string }): MeetingRecord {
  return {
    status: "accepted",
    hasReview: false,
    scheduledAt: "2026-09-12T10:00:00+09:00",
    buyerOrgId: "buyer-1",
    exhibitorOrgId: "exh-1",
    requestedByOrgId: "exh-1", // 기본: 상대가 보냄(received)
    counterpartName: "상대 기업",
    venue: "비즈니스룸 1",
    ...partial,
  }
}

function input(partial: Partial<HomeDashboardInput> = {}): HomeDashboardInput {
  return {
    viewerRole: "buyer",
    viewerOrgId: "buyer-1",
    meetings: [],
    today: "2026-09-12",
    ...partial,
  }
}

describe("buildHomeDashboardData", () => {
  it("내 미팅을 상태별로 롤업한다", () => {
    const result = buildHomeDashboardData(
      input({
        viewerRole: "buyer",
        viewerOrgId: "buyer-1",
        meetings: [
          meeting({ id: "a", status: "proposed", buyerOrgId: "buyer-1", requestedByOrgId: "exh-1" }),
          meeting({ id: "b", status: "accepted", buyerOrgId: "buyer-1" }),
        ],
      })
    )
    expect(result.statusRollup.receivedRequests).toBe(1)
    expect(result.statusRollup.upcoming).toBe(1)
  })

  it("요청 방향: 내가 보낸 proposed는 보낸 요청, 상대가 보낸 건 받은 요청", () => {
    const result = buildHomeDashboardData(
      input({
        viewerRole: "buyer",
        viewerOrgId: "buyer-1",
        meetings: [
          meeting({ id: "sent", status: "proposed", buyerOrgId: "buyer-1", requestedByOrgId: "buyer-1" }),
          meeting({ id: "recv", status: "proposed", buyerOrgId: "buyer-1", requestedByOrgId: "exh-1" }),
        ],
      })
    )
    expect(result.statusRollup.sentRequests).toBe(1)
    expect(result.statusRollup.receivedRequests).toBe(1)
  })

  it("권한 경계: 다른 기업이 당사자인 미팅은 롤업·일정에서 제외한다", () => {
    const result = buildHomeDashboardData(
      input({
        viewerRole: "buyer",
        viewerOrgId: "buyer-1",
        today: "2026-09-12",
        meetings: [
          meeting({ id: "mine", status: "accepted", buyerOrgId: "buyer-1" }),
          meeting({ id: "other", status: "accepted", buyerOrgId: "buyer-999" }),
        ],
      })
    )
    expect(result.statusRollup.upcoming).toBe(1)
    expect(result.todaySchedule.map((m) => m.id)).toEqual(["mine"])
  })

  it("오늘 일정: 취소·거절된 건은 오늘 날짜여도 제외한다", () => {
    const result = buildHomeDashboardData(
      input({
        viewerRole: "buyer",
        viewerOrgId: "buyer-1",
        today: "2026-09-12",
        meetings: [
          meeting({ id: "live", status: "accepted" }),
          meeting({ id: "cancelled", status: "cancelled" }),
          meeting({ id: "rejected", status: "rejected" }),
        ],
      })
    )
    expect(result.todaySchedule.map((m) => m.id)).toEqual(["live"])
  })

  it("오늘 일정: 오늘 날짜(KST) 미팅만 시간순으로 모은다", () => {
    const result = buildHomeDashboardData(
      input({
        viewerRole: "buyer",
        viewerOrgId: "buyer-1",
        today: "2026-09-12",
        meetings: [
          meeting({ id: "afternoon", scheduledAt: "2026-09-12T14:00:00+09:00" }),
          meeting({ id: "morning", scheduledAt: "2026-09-12T09:00:00+09:00" }),
          meeting({ id: "tomorrow", scheduledAt: "2026-09-13T09:00:00+09:00" }),
        ],
      })
    )
    expect(result.todaySchedule.map((m) => m.id)).toEqual(["morning", "afternoon"])
  })
})
