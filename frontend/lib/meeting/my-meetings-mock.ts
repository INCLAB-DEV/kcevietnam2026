// 데모용 MY-001 미팅 타임라인 입력. 뷰어 역할(buyer/exhibitor)에 따라 상대 기업이 달라진다.
// home-mock과 같은 패턴(viewer.orgId = viewer 측, 상대는 counterpart).
// 상대 기업은 discover와 같은 실제 조직 데이터(lib/mock-orgs)에 연결해, 우측 패널이 부스·전시품·
// 매칭 근거까지 실데이터로 채워지게 한다(counterpart id = 실 org id).
// MockApiClient.getMyMeetings/getEventDates의 구현 디테일 — 페이지는 직접 import하지 않는다(백엔드 #33).
// 실연동 시 같은 seam을 FastAPI 어댑터(→ RDS, 권한검사는 Cognito JWT)로 교체한다.

import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import type { EventDate } from "./timeline"
import type { Viewer } from "@/lib/api-client/types"
import { ALL_MOCK_ORGS } from "@/lib/mock-orgs"

// 2026 베트남 K-콘텐츠 엑스포 비즈매칭 운영일(데모 고정값). 실연동 시 행사 일정 API로 대체.
// mock 모드 전용 폴백 — 실 세션 날짜 탭은 백엔드 행사 기간에서 온다(lib/api-client/server.ts
// getEventDates → lib/meeting/event-dates.ts). 값은 데모 시드(demo_seed.py DEMO_EXHIBITION_*)와
// 같은 창(2026.10.20~22)으로 맞춰 둔다 — 어긋나면 그날 잡힌 미팅이 타임라인에서 조용히 사라진다.
export const EVENT_DATES: EventDate[] = [
  { id: "2026-10-20", label: "10/20", weekday: "화" },
  { id: "2026-10-21", label: "10/21", weekday: "수" },
  { id: "2026-10-22", label: "10/22", weekday: "목" },
]

const ORG_BY_ID = new Map(ALL_MOCK_ORGS.map((o) => [o.id, o]))

// 상대측 참석 담당자(참석 Member 데모값). 실연동 시 미팅 참석자 API로 대체. key = 실 org id.
export const MOCK_CONTACTS: Record<string, { name: string; title: string }> = {
  "ex-001": { name: "정하나", title: "사업개발팀장" },
  "ex-002": { name: "김민준", title: "해외영업 이사" },
  "ex-003": { name: "박서준", title: "콘텐츠기획 부장" },
  "ex-004": { name: "이수아", title: "수출사업 팀장" },
  "by-001": { name: "최유진", title: "콘텐츠구매 책임자" },
  "by-003": { name: "강태희", title: "유통기획 매니저" },
  "by-004": { name: "한소이", title: "라이선싱 팀장" },
  "by-005": { name: "윤지호", title: "선임연구원" },
}

// 베트남 전시 정책(F-MT-001): 미팅 장소는 항상 참가사 부스뿐이다(매칭존 테이블·비즈니스 룸이 없다).
// 바이어가 보는 상대는 그 참가사의 실제 부스, 참가사가 보는 상대(바이어)는 세션 참가사 자신의
// 부스가 된다 — getViewerOrg(exhibitor) shim과 동일하게 exh-1 ≈ ex-001(픽셀아츠 스튜디오)로 취급한다.
function boothVenue(orgId: string): string {
  const booth = ORG_BY_ID.get(orgId)?.booth
  return booth ? `참가사 부스 ${booth.code}` : "참가사 부스"
}

const VIEWER_EXHIBITOR_ORG_ID = "ex-001" // getViewerOrg(exhibitor) shim과 동일(픽셀아츠 스튜디오)

// 바이어는 참가사를, 참가사는 바이어를 상대로 본다. id는 실제 org(매칭/부스 조회용), 이름은 ORG_BY_ID에서.
const COUNTERPARTS: Record<"buyer" | "exhibitor", { id: string; venue: string }[]> = {
  buyer: [
    { id: "ex-001", venue: boothVenue("ex-001") }, // 픽셀아츠 스튜디오
    { id: "ex-002", venue: boothVenue("ex-002") }, // 한강게임즈
    { id: "ex-003", venue: boothVenue("ex-003") }, // 툰브릿지
    { id: "ex-004", venue: boothVenue("ex-004") }, // 사운드웨이브
  ],
  exhibitor: [
    { id: "by-001", venue: boothVenue(VIEWER_EXHIBITOR_ORG_ID) }, // Seoul Content Partners — 장소는 내(참가사) 부스
    { id: "by-005", venue: boothVenue(VIEWER_EXHIBITOR_ORG_ID) }, // Tokyo Anime Ventures
    { id: "by-004", venue: boothVenue(VIEWER_EXHIBITOR_ORG_ID) }, // K-Wave Media Group
    { id: "by-003", venue: boothVenue(VIEWER_EXHIBITOR_ORG_ID) }, // Global Music Ventures
  ],
}

function makeMeeting(
  viewer: Viewer,
  c: { id: string; venue: string },
  fields: {
    id: string
    status: ScheduleStatus
    scheduledAt: string
    requestedBy: "me" | "counterpart"
    durationMinutes?: number // 30(기본)/60/90 — 30분 슬롯 1~3칸 점유
    attended?: boolean // completed의 결과 속성(false=노쇼/불참)
    hasReview?: boolean // 회의록 작성완료 여부(완료+참석에서만 의미). 기본 false.
  }
): MeetingRecord {
  const isBuyer = viewer.role === "buyer"
  const { requestedBy, hasReview = false, ...rest } = fields
  return {
    ...rest,
    hasReview,
    buyerOrgId: isBuyer ? viewer.orgId : c.id,
    exhibitorOrgId: isBuyer ? c.id : viewer.orgId,
    requestedByOrgId: requestedBy === "me" ? viewer.orgId : c.id,
    counterpartName: ORG_BY_ID.get(c.id)?.name ?? c.id,
    venue: c.venue,
  }
}

// 슬롯 색/라벨/액션 매트릭스를 모두 보여주는 데모 미팅 집합(09:00~18:00 30분 격자에 정렬).
export function buildMockTimelineMeetings(viewer: Viewer): MeetingRecord[] {
  const c = COUNTERPARTS[viewer.role]
  return [
    // 9/16 — 스팬 케이스 포함(90분=3칸, 60분=2칸, 30분=1칸)
    makeMeeting(viewer, c[0], { id: "mtg-1", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", requestedBy: "me", durationMinutes: 90 }),
    makeMeeting(viewer, c[2], { id: "mtg-2", status: "proposed", scheduledAt: "2026-09-16T11:30:00+09:00", requestedBy: "counterpart" }),
    makeMeeting(viewer, c[3], { id: "mtg-3", status: "proposed", scheduledAt: "2026-09-16T14:30:00+09:00", requestedBy: "me", durationMinutes: 60 }),
    makeMeeting(viewer, c[1], { id: "mtg-4", status: "accepted", scheduledAt: "2026-09-16T16:00:00+09:00", requestedBy: "counterpart" }),
    // 9/17 — 받은 요청 + 정리된 건(취소·거절)
    makeMeeting(viewer, c[1], { id: "mtg-5", status: "proposed", scheduledAt: "2026-09-17T09:30:00+09:00", requestedBy: "counterpart" }),
    makeMeeting(viewer, c[2], { id: "mtg-6", status: "cancelled", scheduledAt: "2026-09-17T13:00:00+09:00", requestedBy: "me" }),
    makeMeeting(viewer, c[3], { id: "mtg-7", status: "rejected", scheduledAt: "2026-09-17T15:00:00+09:00", requestedBy: "counterpart" }),
    // 9/18 — 완료 3종: 참석+회의록 미작성(orange "회의록 작성"), 참석+작성완료(blue "회의록 보기"), 불참=노쇼(gray).
    makeMeeting(viewer, c[0], { id: "mtg-8", status: "completed", scheduledAt: "2026-09-18T10:00:00+09:00", requestedBy: "me" }),
    makeMeeting(viewer, c[2], { id: "mtg-10", status: "completed", hasReview: true, scheduledAt: "2026-09-18T11:00:00+09:00", requestedBy: "me" }),
    makeMeeting(viewer, c[1], { id: "mtg-9", status: "completed", attended: false, scheduledAt: "2026-09-18T11:30:00+09:00", requestedBy: "counterpart" }),
  ]
}
