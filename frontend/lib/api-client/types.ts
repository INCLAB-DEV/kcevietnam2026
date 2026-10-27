import type { UserRole } from "@/components/layout/nav"
import type { NotificationItem } from "@/lib/notifications/types"
import type { Organization, ViewerRole } from "@/lib/types"
import type { EventSettings } from "@/lib/event/event-settings"
import type {
  HomeDashboardInput,
  MeetingRecord,
  ParticipantRole,
} from "@/lib/home/home-dashboard-data"
import type { Notification } from "@/lib/home/notification"
import type { EventDate } from "@/lib/meeting/timeline"
import type { MeetingAvailability } from "@/lib/meeting/types"
import type { Locale } from "@/lib/i18n/config"
import type { MemberRow } from "@/lib/organizer/members"
import type { AssignmentScheduleData, OrganizationScheduleResult } from "@/lib/organizer/assignment-schedule"
import type { MemberProfile } from "@/lib/organizer/member-profile"
import type { OpsMetrics, OpsMetricsScope } from "@/lib/organizer/ops-metrics"
import type { SaturationStatus } from "@/lib/organizer/saturation-status"

// OP-001 운영 대시보드가 한 번에 읽는 묶음 — 집계 지표 + 전체 포화배정 현황(읽기 전용).
export interface OpsDashboard {
  metrics: OpsMetrics
  saturation: SaturationStatus
  // 집계 모집단(OpsMetricsScope) — 없으면 'event'(mock·구 응답). sub 실세션은 'jurisdiction'.
  scope?: OpsMetricsScope
}

export interface User {
  id: string
  name: string
  role: UserRole
  email: string
}

// 화면을 보는 주체(역할 + 소속 org) — 권한 경계의 입력. 데모에선 mock 세션에서, 실연동 시
// 서버가 Cognito JWT에서 구성한다. ApiClient를 mock 세션 타입에 묶지 않으려고 따로 둔다.
export interface Viewer {
  role: ParticipantRole
  orgId: string
}

export interface Meeting {
  id: string
  title: string
  status: "confirmed" | "pending" | "cancelled"
  scheduledAt: string
  buyerId: string
  exhibitorId: string
}

export interface RecommendationFeedback {
  viewerOrgId?: string
  targetOrgId: string
  appropriate: boolean
  reason?: string
}

// AI 매칭 추천 결과 — 한 후보 기업의 랭킹 점수 + 사유. 점수계산은 seam 뒤(MockApiClient)에서만
// 일어난다(ADR-0008); FE는 이 결과를 렌더링만 한다. 적합도(fit score) 재정의는 범위 밖(#88).
export interface MatchResult {
  org: Organization
  aiScore: number
  aiReasons: string[]
}

// ── 읽기 클라이언트(서버 전용) ───────────────────────────────────────────────
// "데이터가 어디서 오는가"를 이 seam 한 곳으로 모은다(ADR-0008). mock은 인메모리 픽스처를
// 돌려주는 어댑터, 실연동 시 FastAPI 어댑터 1개로 교체한다(호출처는 그대로).
//
// 이 표면의 구현(serverApiClient)은 `server-only` 마커로 봉인돼 클라이언트 모듈 그래프에
// 들어오지 못한다(frontend ADR-0001). 따라서 read 어댑터의 mock 픽스처·점수 휴리스틱이
// `.next/static/chunks`로 새지 않는다. 읽기는 서버 컴포넌트에서만 호출한다.
export interface ReadApiClient {
  getUser(userId: string): Promise<User>
  getMeetings(userId: string): Promise<Meeting[]>

  // F-DV-001 기업 탐색 — 방향별 가시성이 이미 적용된 디렉터리(우회 경로 차단, lib/discover/visibility.ts
  // + 행사 설정) / 단건 조회(없으면 null, 필터 없음 — 운영자 등 다른 호출부와 공유).
  getOrganizations(viewerRole: ViewerRole): Promise<Organization[]>
  getOrganization(orgId: string): Promise<Organization | null>
  // 데모 뷰어 org — 세션 orgId↔기업 id 1:1 매핑 전 임시 shim. 실연동 시 Cognito org_id로 조회.
  getViewerOrg(role: ParticipantRole): Promise<Organization>
  // 행사 운영 정책(장소 유형·같은 역할 상호열람 허용 여부 등). 하드코딩 대신 이 seam에서 읽는다 —
  // 다음 행사에서 어드민 콘솔이 값을 바꾸면 전체 화면이 따라간다.
  getEventSettings(): Promise<EventSettings>

  // F-DV-001 AI 추천 — viewer↔후보 쌍을 랭킹한 점수+사유. 점수계산은 이 seam 뒤에서만 일어난다
  // (ADR-0008): mock은 휴리스틱을 동적 import해 서버에서 실행, 실연동 시 FastAPI 매처로 교체.
  getRecommendations(viewer: Organization, candidates: Organization[]): Promise<MatchResult[]>

  // HM-001 홈 대시보드 입력 + 알림 피드. today(KST)는 주입받는다(모듈에서 Date.now() 안 씀).
  // 화면은 결과를 순수 투영(buildHomeDashboardData / latestNotifications)만 한다.
  getHomeDashboard(viewer: Viewer, today: string): Promise<HomeDashboardInput>
  getHomeNotifications(viewer: Viewer, today: string): Promise<Notification[]>

  // MY-001 내 미팅 타임라인 입력(#33) + DX Korea 행사일. 화면은 buildTimeline로 투영만 한다.
  getMyMeetings(viewer: Viewer): Promise<MeetingRecord[]>
  getEventDates(): Promise<EventDate[]>

  // OP-002 운영자 명단(#51) — 전체 / 단건(없으면 null).
  getMembers(): Promise<MemberRow[]>
  getMember(orgId: string): Promise<MemberRow | null>
  // OP-002 신청서 조회 — 제출 이력 기업의 B층 신청서(BM-004/005). 미신청 기업은 키 없음.
  getMemberProfiles(): Promise<Record<string, MemberProfile>>

  // OP-001 운영 대시보드(#53) — 집계 지표 + 포화배정 현황. 집계는 이 seam 뒤(서버)에서만 일어난다.
  //   실연동 시 FastAPI 집계 엔드포인트 호출로 교체(ADR-0008 경계 B). 읽기 전용.
  getOpsDashboard(): Promise<OpsDashboard>

  // OP-005/OP-003 배정 — 그리드(기업×슬롯)·현재 미팅·추천(매칭순)·운영설정을 한 묶음으로.
  // 추천 점수계산은 이 seam 뒤(서버)에서만 일어난다(ADR-0001/0008): 점수만 내려오고 클라는 selection만 한다.
  getAssignmentSchedule(): Promise<AssignmentScheduleData>
  // OP-003 기업 디테일 일정(조회, master+sub) — 한 기업 + 미팅 상대만. sub는 관할로 좁혀 내려오고
  // 관할 밖/없는 기업은 forbidden/not_found 값으로 온다(던지지 않는다).
  getOrganizationSchedule(organizationId: string): Promise<OrganizationScheduleResult>

  // F-MT-001 미팅 신청 모달이 한 상대 기업에 대해 읽는 가용성(슬롯·장소·AI 초안).
  getMeetingAvailability(recipient: Organization, locale?: Locale): Promise<MeetingAvailability>
}

// ── 세션/뮤테이션 클라이언트(클라 호출 가능) ──────────────────────────────────
// client component(app-sidebar·discover-tabs 등)가 직접 호출하는 표면. 구현(sessionApiClient)은
// 클라 안전 모듈(notifications/store·inbox)·스텁만 정적 import한다 — read 어댑터의 mock 픽스처를
// 끌어오지 않으므로 클라 번들로 안전하게 들어온다(frontend ADR-0001).
export interface SessionApiClient {
  // 세션 종료. mock은 스텁이며, 실연동 시 Cognito 사인아웃(토큰 폐기)로 스왑한다.
  logout(): Promise<void>
  // AI 추천 적절성/거절 피드백. mock은 스텁이며, 실연동 시 FastAPI로 POST (#14 추천 학습/성과보고).
  recordRecommendationFeedback(input: RecommendationFeedback): Promise<void>

  // NT-001 알림 인박스 (org 공유). mock은 인메모리 스토어이며, 실연동 시 FastAPI(#44/#45)로 스왑.
  //   listNotifications: org-scoped 전체(시간순 정렬·필터는 클라 순수 로직 담당).
  //   markNotificationRead / markAllNotificationsRead: org 공유 읽음(한 멤버 읽음→org 전체). 갱신된 전체 목록 반환.
  listNotifications(orgId: string): Promise<NotificationItem[]>
  markNotificationRead(
    orgId: string,
    notificationId: string,
    memberName: string,
  ): Promise<NotificationItem[]>
  markAllNotificationsRead(orgId: string, memberName: string): Promise<NotificationItem[]>
}

// 두 표면의 합집합 — 실연동 전 형상 호환(전체 표면 테스트)에만 쓴다. 런타임 구현은 절대
// 합치지 않는다: read는 serverApiClient(server-only), 세션/뮤테이션은 sessionApiClient.
export type ApiClient = ReadApiClient & SessionApiClient
