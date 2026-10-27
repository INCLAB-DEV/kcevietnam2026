import { describe, it, expect } from "vitest"
import { resolveActionStrip } from "./action-strip"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"

const ME = "org-me"
const OTHER = "org-other"

function rec(p: Partial<MeetingRecord> & { id: string }): MeetingRecord {
  return {
    status: "accepted",
    hasReview: false,
    scheduledAt: "2026-09-16T10:00:00+09:00",
    buyerOrgId: ME, // viewer(buyer) 측 = 내 기업
    exhibitorOrgId: OTHER,
    requestedByOrgId: ME, // 기본 sent(내가 신청)
    counterpartName: "한화시스템",
    venue: "비즈니스룸 1",
    ...p,
  }
}

const base = { viewerRole: "buyer" as const, viewerOrgId: ME }

describe("resolveActionStrip", () => {
  it("받은 미팅요청 = 받은(상대가 신청) proposed만, 가장 이른 건을 점프 대상으로", () => {
    const view = resolveActionStrip({
      ...base,
      meetings: [
        rec({ id: "r-late", status: "proposed", requestedByOrgId: OTHER, scheduledAt: "2026-09-17T09:00:00+09:00" }),
        rec({ id: "r-early", status: "proposed", requestedByOrgId: OTHER, scheduledAt: "2026-09-16T11:00:00+09:00" }),
        rec({ id: "sent", status: "proposed", requestedByOrgId: ME }), // 내가 보낸 → 받은요청 아님
      ],
    })
    expect(view.receivedRequests).toBe(2)
    expect(view.earliestReceivedId).toBe("r-early")
  })

  it("회의록 = 완료(참석) & 미작성만 — 노쇼·작성완료는 제외, 가장 이른 건을 점프 대상으로", () => {
    const view = resolveActionStrip({
      ...base,
      meetings: [
        rec({ id: "c-late", status: "completed", hasReview: false, scheduledAt: "2026-09-18T10:00:00+09:00" }),
        rec({ id: "noshow-early", status: "completed", attended: false, hasReview: false, scheduledAt: "2026-09-18T09:00:00+09:00" }), // 노쇼 → 회의록 대상 아님
        rec({ id: "attended-mid", status: "completed", attended: true, hasReview: false, scheduledAt: "2026-09-18T09:30:00+09:00" }),
        rec({ id: "done", status: "completed", hasReview: true }), // 작성 완료 → 제외
      ],
    })
    expect(view.pendingReview).toBe(2) // c-late + attended-mid (노쇼·done 제외)
    expect(view.earliestReviewId).toBe("attended-mid") // 노쇼(09:00)는 빠지고 그 다음 이른 09:30
  })

  it("권한 경계: 내 기업이 당사자가 아닌 미팅은 집계에서 제외한다", () => {
    const view = resolveActionStrip({
      ...base,
      meetings: [
        rec({ id: "mine", status: "proposed", requestedByOrgId: OTHER }),
        rec({ id: "notmine", status: "proposed", requestedByOrgId: OTHER, buyerOrgId: "someone-else" }),
      ],
    })
    expect(view.receivedRequests).toBe(1)
    expect(view.earliestReceivedId).toBe("mine")
  })

  it("처리할 게 없으면 0건 + null(스트립은 렌더되지 않음)", () => {
    const view = resolveActionStrip({
      ...base,
      meetings: [
        rec({ id: "a", status: "accepted" }),
        rec({ id: "s", status: "proposed", requestedByOrgId: ME }), // 보낸 요청은 액션 아님
      ],
    })
    expect(view).toEqual({
      receivedRequests: 0,
      earliestReceivedId: null,
      pendingReview: 0,
      earliestReviewId: null,
    })
  })

  it("만료(수락 전 시작 지남)된 받은요청은 받은 미팅요청·점프 대상에서 제외한다", () => {
    const view = resolveActionStrip({
      ...base,
      now: { date: "2026-09-16", time: "10:34" }, // 10:00 시작 지남
      meetings: [
        rec({ id: "expired", status: "proposed", requestedByOrgId: OTHER, scheduledAt: "2026-09-16T10:00:00+09:00" }),
        rec({ id: "future", status: "proposed", requestedByOrgId: OTHER, scheduledAt: "2026-09-16T14:00:00+09:00" }),
      ],
    })
    expect(view.receivedRequests).toBe(1) // 만료 제외, future만
    expect(view.earliestReceivedId).toBe("future")
  })
})
