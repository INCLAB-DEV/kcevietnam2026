import type { HomeDashboardInput, MeetingRecord } from "./home-dashboard-data"
import type { Notification } from "./notification"
import type { Viewer } from "@/lib/api-client/types"

// 데모용 홈 대시보드 입력. 뷰어 역할(buyer/exhibitor)에 따라 상대 기업이 달라진다.
// MockApiClient.getHomeDashboard/getHomeNotifications의 구현 디테일 — 페이지는 직접 import하지 않는다.
// 실연동 시 같은 seam을 FastAPI 어댑터(→ RDS, 권한검사는 Cognito JWT)로 교체한다.

// 베트남 전시 정책(F-MT-001): 미팅 장소는 항상 참가사 부스뿐이다(매칭존 테이블·비즈니스 룸이 없다).
// my-meetings-mock.ts의 boothVenue()와 같은 표기("참가사 부스 {code}")로 맞춘다. 바이어가 보는 상대는
// 그 참가사의 실제 부스(lib/mock-orgs 부스코드), 참가사가 보는 상대(바이어)는 세션 참가사 자신의 부스가
// 된다 — 데모 참가사 계정(exhibitor01@demo.nabi.local)이 픽셀아츠 스튜디오(부스 A-12)라 exhibitor
// 상대는 전부 그 부스로 고정.
const COUNTERPARTS: Record<"buyer" | "exhibitor", { id: string; name: string; venue: string }[]> = {
  buyer: [
    { id: "exh-a", name: "픽셀아츠 스튜디오", venue: "참가사 부스 A-12" },
    { id: "exh-b", name: "한강게임즈", venue: "참가사 부스 A-15" },
    { id: "exh-c", name: "툰브릿지", venue: "참가사 부스 B-05" },
    { id: "exh-d", name: "사운드웨이브", venue: "참가사 부스 B-08" },
  ],
  exhibitor: [
    { id: "buyer-a", name: "Seoul Content Partners", venue: "참가사 부스 A-12" },
    { id: "buyer-b", name: "Asia Webtoon Distribution", venue: "참가사 부스 A-12" },
    { id: "buyer-c", name: "Global Music Ventures", venue: "참가사 부스 A-12" },
    { id: "buyer-d", name: "K-Wave Media Group", venue: "참가사 부스 A-12" },
  ],
}

// 미팅 1건을 viewer 시점으로 만든다(viewer 측 org = viewer.orgId).
function makeMeeting(
  viewer: Viewer,
  c: { id: string; name: string; venue: string },
  fields: Pick<MeetingRecord, "id" | "status" | "hasReview" | "scheduledAt" | "attended"> & {
    requestedBy: "me" | "counterpart"
  }
): MeetingRecord {
  const isBuyer = viewer.role === "buyer"
  const { requestedBy, ...rest } = fields
  return {
    ...rest,
    buyerOrgId: isBuyer ? viewer.orgId : c.id,
    exhibitorOrgId: isBuyer ? c.id : viewer.orgId,
    requestedByOrgId: requestedBy === "me" ? viewer.orgId : c.id,
    counterpartName: c.name,
    venue: c.venue,
  }
}

// 데모용 알림 피드(역할별). 화면에선 latestNotifications로 최신순·5개로 추린다.
// 타입별 딥링크는 notificationHref가 meetingId로 해결(F-NT-001).
export function buildMockNotifications(today: string, viewer: Viewer): Notification[] {
  const c = COUNTERPARTS[viewer.role]
  return [
    { id: "ntf-1", type: "meeting_requested", meetingId: "mtg-3", message: `${c[2].name}이 미팅을 요청했습니다`, createdAt: `${today}T16:00:00+09:00` },
    { id: "ntf-2", type: "meeting_accepted", meetingId: "mtg-1", message: `${c[0].name}이 미팅 요청을 수락했습니다`, createdAt: `${today}T15:30:00+09:00` },
    { id: "ntf-3", type: "meeting_reminder", meetingId: "mtg-2", message: `${c[1].name} 미팅이 곧 시작됩니다`, createdAt: `${today}T14:00:00+09:00` },
    { id: "ntf-4", type: "meeting_requested", meetingId: "mtg-4", message: `${c[3].name}이 미팅을 요청했습니다`, createdAt: `${today}T11:00:00+09:00` },
    { id: "ntf-5", type: "review_prompt", meetingId: "mtg-5", message: `${c[0].name}과의 미팅 회의록을 작성해주세요`, createdAt: `${today}T09:30:00+09:00` },
    { id: "ntf-6", type: "meeting_cancelled", meetingId: "mtg-2", message: `${c[2].name}이 미팅을 취소했습니다`, createdAt: `${today}T08:00:00+09:00` },
  ]
}

export function buildMockHomeInput(today: string, viewer: Viewer): HomeDashboardInput {
  // organizer는 홈(HM-001) 대상이 아니다 — 호출측(api-client/페이지)에서 참가측 viewer만 넘긴다.
  const counterparts = COUNTERPARTS[viewer.role]

  return {
    viewerRole: viewer.role,
    viewerOrgId: viewer.orgId,
    today,
    meetings: [
      // 미팅 예정(accepted) x2
      makeMeeting(viewer, counterparts[0], {
        id: "mtg-1",
        status: "accepted",
        hasReview: false,
        scheduledAt: `${today}T10:00:00+09:00`,
        requestedBy: "me",
      }),
      makeMeeting(viewer, counterparts[1], {
        id: "mtg-2",
        status: "accepted",
        hasReview: false,
        scheduledAt: `${today}T14:30:00+09:00`,
        requestedBy: "counterpart",
      }),
      // 받은 요청 (상대가 신청 → 내가 수락해야)
      makeMeeting(viewer, counterparts[2], {
        id: "mtg-3",
        status: "proposed",
        hasReview: false,
        scheduledAt: `${today}T16:00:00+09:00`,
        requestedBy: "counterpart",
      }),
      // 보낸 요청 (내가 신청 → 상대 수락 대기)
      makeMeeting(viewer, counterparts[3], {
        id: "mtg-4",
        status: "proposed",
        hasReview: false,
        scheduledAt: `${today}T11:00:00+09:00`,
        requestedBy: "me",
      }),
      // 미팅 완료 (참석 + 불참=노쇼), 둘 다 회의록 미작성
      makeMeeting(viewer, counterparts[0], {
        id: "mtg-5",
        status: "completed",
        hasReview: false,
        scheduledAt: "2026-09-11T11:00:00+09:00",
        requestedBy: "me",
      }),
      makeMeeting(viewer, counterparts[1], {
        id: "mtg-6",
        status: "completed",
        attended: false,
        hasReview: false,
        scheduledAt: "2026-09-11T15:00:00+09:00",
        requestedBy: "counterpart",
      }),
    ],
  }
}
