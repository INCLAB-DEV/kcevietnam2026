import "server-only"

// 슈퍼어드민 콘솔의 서버 전용 read seam (frontend ADR-0001).
//
// `server-only`로 봉인한다 — client component가 이 모듈을 import하면 **빌드 타임에 실패**한다.
// 덕분에 아래가 끌어오는 목업 픽스처(기업 명단·신청서 본문·미팅·알림 이력)가 클라이언트 모듈
// 그래프와 `.next/static/chunks`에 영영 들어오지 않는다. 봉인이 경계를 강제하므로 픽스처는
// 동적 import 트릭 없이 정적 import한다.
//
// 읽기는 서버 컴포넌트(app/admin/*/page.tsx)에서만 호출한다. 쓰기(뮤테이션)는 클라 안전 모듈인
// admin-actions.ts가 담당한다 — read/session 분리 규칙(ADR-0001)을 이 표면에서도 그대로 지킨다.
//
// 실연동(ADR-0008): 이 어댑터 1개만 FastAPI 호출로 교체하면 호출처(서버 page)는 그대로다.
//   getEvents()        → GET /api/admin/events
//   getEventSettings() → GET /api/admin/events/{id}/settings
//   getOrganizations() → GET /api/admin/events/{id}/organizations
//   getOrgProfiles()   → GET /api/admin/events/{id}/organizations/{org_id} (상세)
//   getMeetings()      → GET /api/admin/events/{id}/meetings
//   getNotifications() → GET /api/admin/events/{id}/notifications
//   getInterpreters()  → GET /api/admin/events/{id}/interpreters
//   getVenues()        → GET /api/admin/events/{id}/venues
//   getOrganizers()    → GET /api/admin/events/{id}/organizers
//   getDashboard()     → 집계(백엔드가 계산해 내려주는 요약 엔드포인트로 대체 가능)

import {
  buildAdminDashboard,
  MOCK_EVENTS,
  MOCK_EVENT_SETTINGS,
  MOCK_INTERPRETERS,
  MOCK_MEETINGS,
  MOCK_NOTIFICATION_LOGS,
  MOCK_ORGANIZATIONS,
  MOCK_ORGANIZERS,
  MOCK_ORG_PROFILES,
  MOCK_VENUES,
} from "./admin-mock"
import { httpAdminReadClient } from "./http-client"
import { scopeToEvent } from "./organizations"
import type {
  AdminDashboard,
  AdminEvent,
  AdminEventSettings,
  AdminInterpreter,
  AdminMeeting,
  AdminNotificationLog,
  AdminOrganization,
  AdminOrganizer,
  AdminOrgProfile,
  AdminVenue,
} from "./types"

export interface AdminReadClient {
  getEvents(): Promise<AdminEvent[]>
  getEventSettings(eventId: string): Promise<AdminEventSettings | null>
  getOrganizations(eventId: string): Promise<AdminOrganization[]>
  getOrgProfiles(eventId: string): Promise<Record<string, AdminOrgProfile>>
  getMeetings(eventId: string): Promise<AdminMeeting[]>
  getNotifications(eventId: string): Promise<AdminNotificationLog[]>
  getInterpreters(eventId: string): Promise<AdminInterpreter[]>
  getVenues(eventId: string): Promise<AdminVenue[]>
  getOrganizers(eventId: string): Promise<AdminOrganizer[]>
  getDashboard(eventId: string): Promise<AdminDashboard>
}

const mockAdminReadClient: AdminReadClient = {
  async getEvents() {
    return MOCK_EVENTS
  },

  async getEventSettings(eventId) {
    return MOCK_EVENT_SETTINGS[eventId] ?? null
  },

  async getOrganizations(eventId) {
    return scopeToEvent(MOCK_ORGANIZATIONS, eventId)
  },

  // 목록과 함께 신청서 본문을 넘긴다 — 상세를 열 때마다 왕복하지 않고 인라인 편집을 바로 연다.
  // 실연동에서 페이로드가 커지면 상세 진입 시 lazy-fetch(GET /organizations/{id}/profile)로 바꾼다.
  async getOrgProfiles(eventId) {
    const ids = new Set(scopeToEvent(MOCK_ORGANIZATIONS, eventId).map((o) => o.id))
    return Object.fromEntries(
      Object.entries(MOCK_ORG_PROFILES).filter(([id]) => ids.has(id)),
    )
  },

  async getMeetings(eventId) {
    return scopeToEvent(MOCK_MEETINGS, eventId)
  },

  async getNotifications(eventId) {
    return scopeToEvent(MOCK_NOTIFICATION_LOGS, eventId)
  },

  async getInterpreters(eventId) {
    return scopeToEvent(MOCK_INTERPRETERS, eventId)
  },

  async getVenues(eventId) {
    return scopeToEvent(MOCK_VENUES, eventId)
  },

  async getOrganizers(eventId) {
    return scopeToEvent(MOCK_ORGANIZERS, eventId)
  },

  async getDashboard(eventId) {
    return buildAdminDashboard(eventId)
  },
}

// 실연동 모드 판정 — 로그인·어드민 쓰기와 동일한 env 스위치(NEXT_PUBLIC_AUTH_CLIENT). 어드민
// 실연동은 실 세션(로그인 발급 access_token)을 전제하므로 스위치를 공유한다(없으면 토큰 부재로
// 읽기 자체가 401이라 따로 켤 이유가 없다).
export const adminServerClient: AdminReadClient =
  process.env.NEXT_PUBLIC_AUTH_CLIENT === "http" ? httpAdminReadClient : mockAdminReadClient

// 행사 목록 화면(app/admin/events/page.tsx)이 등록된 모든 행사를 순회하며 설정을 붙일 때 쓰는
// 내성 래퍼 — 개별 행사 조회 실패(예: DB로 새로 grant된 행사가 아직 이 계정 권한으로 안 잡혀
// 403, 일시적 네트워크 오류 등)가 Promise.all 전체를 reject시켜 페이지를 통째로 500 내리는 걸
// 막는다(결함: 행사가 2개 이상이고 그중 하나만 조회 실패해도 /admin/events 전체가 죽던 문제).
// 실패한 행사는 설정 없음(null)으로 강등 — EventsConsole은 이미 s가 없는 카드를 "설정 없음"으로
// 견디게 돼 있어(설정 섹션만 생략), 화면 전체가 아니라 그 카드 하나만 못 채워진 채 남는다.
// client 파라미터는 vitest에서 cookies()/fetch 없이 순수 로직만 검증하기 위한 주입 지점이다.
export async function getEventSettingsSafe(
  eventId: string,
  client: AdminReadClient = adminServerClient,
): Promise<AdminEventSettings | null> {
  try {
    return await client.getEventSettings(eventId)
  } catch (err) {
    console.error(`[admin] event ${eventId} 설정 조회 실패 — 이 행사는 설정 없이 표시한다`, err)
    return null
  }
}
