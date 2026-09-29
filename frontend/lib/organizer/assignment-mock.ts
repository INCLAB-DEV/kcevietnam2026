// assignment-mock (F-OP-005 / F-OP-003) — 배정 그리드의 서버 측 목업 빌더.
//
// 추천 점수계산(computeRecommendations 휴리스틱)은 여기서만 실행된다 — 이 모듈은 serverApiClient
// (server-only)에서만 import되므로 휴리스틱이 클라 번들로 새지 않는다(ADR-0001). 실연동 시 이 빌더를
// FastAPI 조회 + 매처 호출로 교체하면 호출처(seam)는 그대로다(ADR-0008). 현재 미팅은 데모 시드.

import { MOCK_BUYERS, MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { EVENT_DATES, MOCK_CONTACTS } from "@/lib/meeting/my-meetings-mock"
import { computeRecommendations } from "@/lib/api-client/recommendations"
import type { MatchResult } from "@/lib/api-client/types"
import { DEFAULT_SCHEDULE_SETTINGS, slotId, slotTimes } from "./schedule"
import type { AssignmentMeeting } from "./forced-assignment"
import type { AssignmentScheduleData } from "./assignment-schedule"
import { MOCK_MEMBER_PROFILES } from "./member-profiles-mock"

// 비즈매칭 신청순(tie-break) — 데모에선 mock 배열 순서를 신청 순번으로 본다(ex/bu 각 1부터).
function buildApplicationOrder(): Record<string, number> {
  const order: Record<string, number> = {}
  MOCK_EXHIBITORS.forEach((org, i) => (order[org.id] = i + 1))
  MOCK_BUYERS.forEach((org, i) => (order[org.id] = i + 1))
  return order
}

// 현재 배정된 미팅 시드 — MY-001 내 미팅과 같은 케이스 팔레트를 그리드에 보여준다(데모):
// 확정(green, 단일/연속 90·60분) · 수락대기(red) · 완료·보관(blue) · 노쇼(gray) · 취소·거절(gray).
// 상태는 받는 쪽 바이어 유형과 일관되게 둔다(by-001·003=초청, by-002·004=사전, by-005=현장).
// 슬롯은 폴백 그리드(lib/organizer/schedule.ts DEFAULT_SCHEDULE_SETTINGS — 09:00~17:30, 30분 간격,
// 점심 미설정) 위의 시각만 쓴다. 연속 다칸(90·60분) 미팅은 그 칸들이 전부 같은 날 그리드 안에
// 들어와야 한다 — 그리드 산술(spanOf 등)이 칸 간격(30분) 단위로 뒤 칸을 센다.
const D0 = EVENT_DATES[0]?.id ?? "2026-09-16" // 9/16
const D1 = EVENT_DATES[1]?.id ?? "2026-09-17" // 9/17

const SEED_MEETINGS: AssignmentMeeting[] = [
  // 픽셀아츠 스튜디오: 90분(3슬롯) 확정 → 60분(2슬롯) 완료·보관 → 노쇼
  { id: "seed-1", exhibitorId: "ex-001", buyerId: "by-001", slotId: slotId(D0, "10:00"), status: "accepted", matchingType: "ai", durationMinutes: 90, venue: "비즈니스 룸 A", requestedByOrgId: "by-001" },
  { id: "seed-2", exhibitorId: "ex-001", buyerId: "by-002", slotId: slotId(D0, "13:00"), status: "completed", matchingType: "forced", durationMinutes: 60, attended: true, hasReview: true, venue: "비즈매칭존 T-12", requestedByOrgId: "ex-001" },
  { id: "seed-3", exhibitorId: "ex-001", buyerId: "by-004", slotId: slotId(D0, "15:30"), status: "completed", matchingType: "ai", attended: false, venue: "상대방 부스 (7홀 A-12)", requestedByOrgId: "ex-001" },
  // 한강게임즈: 같은 상대(Global Music Ventures)를 10:30·11:00 연달아 → 한 블록(60분)으로 병합(연속 슬롯 병합 시연)
  { id: "seed-4", exhibitorId: "ex-002", buyerId: "by-003", slotId: slotId(D0, "10:30"), status: "accepted", matchingType: "ai", venue: "비즈매칭존 T-03", requestedByOrgId: "by-003" },
  { id: "seed-4b", exhibitorId: "ex-002", buyerId: "by-003", slotId: slotId(D0, "11:00"), status: "accepted", matchingType: "ai", venue: "비즈매칭존 T-03", requestedByOrgId: "by-003" },
  // 툰브릿지: 수락대기 / 죽은 이력만 남은 칸(취소 + 거절) — 그 칸에도 [+]가 떠야 한다(#10 후속 QA A/B6)
  { id: "seed-5", exhibitorId: "ex-003", buyerId: "by-002", slotId: slotId(D0, "11:30"), status: "proposed", matchingType: "forced", venue: "비즈매칭존 T-07", requestedByOrgId: "ex-003" },
  { id: "seed-6", exhibitorId: "ex-003", buyerId: "by-001", slotId: slotId(D0, "14:30"), status: "cancelled", matchingType: "open", venue: "비즈니스 룸 C", requestedByOrgId: "by-001" },
  { id: "seed-6b", exhibitorId: "ex-003", buyerId: "by-004", slotId: slotId(D0, "14:30"), status: "rejected", matchingType: "forced", venue: "비즈니스 룸 C", requestedByOrgId: "ex-003" },
  // 사운드웨이브: 60분(2슬롯) 확정 — 9/17
  { id: "seed-7", exhibitorId: "ex-004", buyerId: "by-003", slotId: slotId(D1, "13:00"), status: "accepted", matchingType: "forced", durationMinutes: 60, venue: "비즈매칭존 T-01", requestedByOrgId: "ex-004" },
  // 케이브로드캐스트: 수락대기(현장 바이어)
  { id: "seed-8", exhibitorId: "ex-005", buyerId: "by-005", slotId: slotId(D0, "13:00"), status: "proposed", matchingType: "open", venue: "상대방 부스", requestedByOrgId: "by-005" },
]

// 기업별 "불가" 슬롯(비즈매칭 신청 때 각 기업이 지정) — 데모: 9/16(D0)에 시간대별로 지정.
// 셀엔 "불가"로 표시되고, 일괄배정·자동채움·Forced 후보에서 제외된다(양측 가능 슬롯만 배정).
// 시드 미팅과 겹치지 않는 빈 시각을 골라 "불가" 상태가 그리드에 또렷이 보이게 한다.
function blocks(dateId: string, times: string[]): string[] {
  return times.map((t) => slotId(dateId, t))
}
const UNAVAILABLE_BY_ORG: Record<string, string[]> = {
  // 참가사
  "ex-001": blocks(D0, ["14:30", "16:00", "16:30"]), // 픽셀아츠 스튜디오 — 오후 중반 불가
  "ex-002": blocks(D0, ["10:00", "14:30", "15:30"]), // 한강게임즈
  "ex-003": blocks(D0, ["15:30", "16:00", "16:30", "17:30"]), // 툰브릿지 — 늦은 오후 불가
  "ex-004": blocks(D0, ["09:00", "09:30", "10:00"]), // 사운드웨이브 — 이른 오전 불가
  "ex-005": blocks(D0, ["13:30", "14:30", "15:30"]), // 케이브로드캐스트
  // 바이어
  "by-001": blocks(D0, ["16:00", "16:30"]), // Seoul Content Partners
  "by-002": blocks(D0, ["15:30", "16:00"]), // Asia Webtoon Distribution
  "by-003": blocks(D0, ["13:30", "14:30"]), // Global Music Ventures
  "by-004": blocks(D0, ["09:00", "09:30"]), // K-Wave Media Group
  "by-005": blocks(D0, ["15:30", "16:00", "16:30"]), // Tokyo Anime Ventures
}

// 배정 그리드 한 묶음을 만든다. 추천은 양 방향(참가사→바이어 / 바이어→참가사) 모두 사전계산.
export function buildAssignmentSchedule(): AssignmentScheduleData {
  const settings = DEFAULT_SCHEDULE_SETTINGS
  const recsByOrgId: Record<string, MatchResult[]> = {}
  for (const exhibitor of MOCK_EXHIBITORS) {
    recsByOrgId[exhibitor.id] = computeRecommendations(exhibitor, MOCK_BUYERS)
  }
  for (const buyer of MOCK_BUYERS) {
    recsByOrgId[buyer.id] = computeRecommendations(buyer, MOCK_EXHIBITORS)
  }
  return {
    exhibitors: MOCK_EXHIBITORS,
    buyers: MOCK_BUYERS,
    dates: EVENT_DATES.map(({ id, label, weekday }) => ({ id, label, weekday })),
    settings,
    slotTimes: slotTimes(settings),
    meetings: SEED_MEETINGS,
    recsByOrgId,
    applicationOrder: buildApplicationOrder(),
    unavailableByOrgId: UNAVAILABLE_BY_ORG,
    contactsByOrgId: MOCK_CONTACTS,
    profilesByOrgId: MOCK_MEMBER_PROFILES,
  }
}
