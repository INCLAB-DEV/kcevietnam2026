import { describe, it, expect } from "vitest"
import { buildMeetingPanels, resolvePanelInitial } from "./meeting-panel"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import type { Organization } from "@/lib/types"
import type { EventDate } from "./timeline"

const VIEWER_ORG_ID = "buyer-1"

const VIEWER_ORG: Organization = {
  id: "by-x",
  name: "방위사업청",
  role: "buyer",
  keywords: ["레이더", "전자전"],
  budgetRange: "50억~100억",
  adoptionTimeline: "6개월 내",
}

const EXH: Organization = {
  id: "ex-001",
  name: "한화시스템",
  role: "exhibitor",
  keywords: ["레이더", "전자전"],
  booth: { hallNo: "1", hallName: "제1전시관", code: "A-12" },
  strength: "국내 최고의 방산 전자전·레이더 솔루션",
  exhibits: ["다기능레이더(AESA)"],
  achievements: ["천궁-II 다기능레이더 양산"],
  founded: "2000년",
  employees: "약 4,000명",
}

const DATES: EventDate[] = [
  { id: "2026-09-16", label: "9/16", weekday: "수" },
  { id: "2026-09-18", label: "9/18", weekday: "금" },
]

function meeting(partial: Partial<MeetingRecord> & { status: ScheduleStatus }): MeetingRecord {
  return {
    id: "m",
    hasReview: false,
    scheduledAt: "2026-09-16T10:00:00+09:00",
    buyerOrgId: VIEWER_ORG_ID,
    exhibitorOrgId: "ex-001",
    requestedByOrgId: VIEWER_ORG_ID,
    counterpartName: "한화시스템",
    venue: "비즈니스룸 1",
    ...partial,
  }
}

function panelsOf(
  meetings: MeetingRecord[],
  viewerOrg: Organization | null = VIEWER_ORG,
  now?: { date: string; time: string }
) {
  return buildMeetingPanels({
    viewerRole: "buyer",
    viewerOrgId: VIEWER_ORG_ID,
    viewerOrg,
    viewerMember: { side: "us", name: "김바이어", title: "구매팀장" },
    meetings,
    orgs: [EXH],
    contacts: { "ex-001": { name: "정한화", title: "사업개발팀장" } },
    now,
  })
}

describe("buildMeetingPanels", () => {
  it("상대 참가사 정보를 매핑한다(요약 헤더 + org 원본 + 상세링크)", () => {
    const v = panelsOf([meeting({ id: "a", status: "accepted" })]).a
    expect(v.counterpart.name).toBe("한화시스템")
    expect(v.counterpart.typeLabel).toBe("참가사")
    // 전시품·부스 등 상세 필드는 패널이 재정의하지 않고 org 원본을 그대로 넘긴다
    // ("기업 상세 보기" → 공통 OrgDetailBody 모달이 렌더). 중복 정의 제거(DV-002 모달 통합).
    expect(v.org.id).toBe("ex-001")
    expect(v.org.exhibits).toContain("다기능레이더(AESA)")
    expect(v.viewerRole).toBe("buyer")
    expect(v.detailHref).toBe("/discover/ex-001")
  })

  it("매칭 점수·이유를 ai-engine으로 채운다(키워드 겹침)", () => {
    const v = panelsOf([meeting({ id: "a", status: "accepted" })]).a
    expect(v.match?.score).toBeGreaterThan(0)
    expect(v.match?.reasons.length).toBeGreaterThan(0)
  })

  it("방향·라벨·액션을 미팅에서 만든다(받은 proposed→수락/거부)", () => {
    const v = panelsOf([meeting({ id: "b", status: "proposed", requestedByOrgId: "ex-001" })]).b
    expect(v.direction).toBe("received")
    expect(v.directionLabel).toBe("상대가 신청")
    expect(v.actions).toEqual(["accept", "reject"])
    expect(v.statusLabel).toBe("수락 필요")
  })

  it("완료 미팅 라벨·액션: 참석+미작성=회의록 작성, 참석+작성완료=회의록 보기(reviewDone), 노쇼=불참+참석여부 수정", () => {
    const undone = panelsOf([meeting({ id: "a", status: "completed", attended: true, hasReview: false })]).a
    expect(undone.statusLabel).toBe("회의록 작성")
    expect(undone.reviewDone).toBe(false)
    expect(undone.actions).toEqual(["review"]) // 참석=회의록만(참석여부 수정 버튼 공존 금지)

    const done = panelsOf([meeting({ id: "b", status: "completed", attended: true, hasReview: true })]).b
    expect(done.statusLabel).toBe("회의록 보기")
    expect(done.reviewDone).toBe(true)

    const noshow = panelsOf([meeting({ id: "c", status: "completed", attended: false })]).c
    expect(noshow.statusLabel).toBe("불참")
    expect(noshow.tone).toBe("gray")
    expect(noshow.actions).toEqual(["attendance"]) // 회의록 불가, 참석여부 수정만
  })

  it("참석자는 우리·상대 순으로 채운다", () => {
    const v = panelsOf([meeting({ id: "a", status: "accepted" })]).a
    expect(v.members.map((m) => m.side)).toEqual(["us", "them"])
    expect(v.members[1].name).toBe("정한화")
  })

  it("viewerOrg가 없으면 match=null", () => {
    const v = panelsOf([meeting({ id: "a", status: "accepted" })], null).a
    expect(v.match).toBeNull()
  })

  it("상대 조직 정보가 없으면 패널을 만들지 않는다", () => {
    const panels = buildMeetingPanels({
      viewerRole: "buyer",
      viewerOrgId: VIEWER_ORG_ID,
      viewerOrg: VIEWER_ORG,
      viewerMember: null,
      meetings: [meeting({ id: "a", status: "accepted" })],
      orgs: [], // 조회 불가
      contacts: {},
    })
    expect(Object.keys(panels)).toHaveLength(0)
  })

  it("만료(수락 전 시작 지남): 상태 라벨 '응답 시간 지남'·회색·액션 없음", () => {
    const v = panelsOf(
      [meeting({ id: "x", status: "proposed", requestedByOrgId: "ex-001", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      VIEWER_ORG,
      { date: "2026-09-16", time: "09:34" } // 시작 지남 → 만료
    ).x
    expect(v.statusLabel).toBe("응답 시간 지남")
    expect(v.tone).toBe("gray")
    expect(v.actions).toEqual([]) // 수락/거부 숨김
  })
})

describe("resolvePanelInitial", () => {
  function resolve(meetings: MeetingRecord[], now?: { date: string; time: string }) {
    return resolvePanelInitial({
      meetings,
      viewerRole: "buyer",
      viewerOrgId: VIEWER_ORG_ID,
      eventDates: DATES,
      now,
    })
  }

  it("지금 이후 가장 이른 예정 미팅을 기본 표시한다", () => {
    const r = resolve(
      [
        meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" }),
        meeting({ id: "b", status: "proposed", scheduledAt: "2026-09-16T09:30:00+09:00" }),
      ],
      { date: "2026-09-16", time: "09:00" }
    )
    expect(r.defaultMeetingId).toBe("b")
    expect(r.emptyState).toBeNull()
  })

  it("A: 예정 없음 + 잔여 슬롯 있음 → find-partner", () => {
    const r = resolve([], { date: "2026-09-16", time: "09:00" })
    expect(r.defaultMeetingId).toBeNull()
    expect(r.emptyState).toBe("find-partner")
  })

  it("B: 예정 없음 + 잔여 슬롯 없음(행사 종료) → no-meetings", () => {
    const r = resolve([], { date: "2026-09-19", time: "09:00" })
    expect(r.emptyState).toBe("no-meetings")
  })

  it("취소·완료 등은 '예정'에서 제외한다", () => {
    const r = resolve(
      [meeting({ id: "c", status: "cancelled", scheduledAt: "2026-09-16T15:00:00+09:00" })],
      { date: "2026-09-16", time: "09:00" }
    )
    expect(r.defaultMeetingId).toBeNull()
    expect(r.emptyState).toBe("find-partner")
  })

  it("지난 시각의 예정 미팅은 기본 표시하지 않는다", () => {
    const r = resolve(
      [meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" })],
      { date: "2026-09-16", time: "11:00" }
    )
    expect(r.defaultMeetingId).toBeNull()
  })

  it("진행 중(now가 미팅 [시작,종료) 안)인 미팅을 기본 표시한다(예정 없음으로 떨어지지 않음)", () => {
    const r = resolve(
      [meeting({ id: "live", status: "accepted", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      { date: "2026-09-16", time: "09:34" } // 09:30~10:00 진행 중(시작 ≤ now < 종료)
    )
    expect(r.defaultMeetingId).toBe("live")
    expect(r.emptyState).toBeNull()
  })

  it("만료(수락 전 + 시작 지남)는 기본 표시 후보에서 제외한다(종료 전이라도)", () => {
    const r = resolve(
      [meeting({ id: "x", status: "proposed", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      { date: "2026-09-16", time: "09:34" } // 시작(09:30) 지남 → 만료
    )
    expect(r.defaultMeetingId).toBeNull()
    expect(r.emptyState).toBe("find-partner")
  })
})
