// 슈퍼어드민 API 경로의 **단일 소스**. 실연동 스왑 때 경로가 바뀌면 이 파일만 고친다.
//
// 백엔드 계약(확정): 이벤트 하위 리소스는 전부 **event 스코프 경로**다
// (`/api/admin/events/{event_id}/...`). 엑셀 입출력만 event_id를 쿼리로 받는 전역 경로다.
//
// 문자열을 화면·액션에 흩뿌리지 않는 이유: 경로가 바뀌면 grep으로 찾아 고치는 대신 여기 한 곳만
// 바꾸면 되고, 오타가 나면 타입이 아니라 런타임에서 터지는 걸 막을 수 있다.

const BASE = "/api/admin"

const enc = encodeURIComponent

// 쿼리 문자열 조립 — undefined/null/빈 문자열은 빼고, 값이 하나도 없으면 "?"도 붙이지 않는다.
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  )
  if (entries.length === 0) return ""
  return `?${entries.map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join("&")}`
}

export interface OrganizationListQuery {
  role?: string
  status?: string
  search?: string
  limit?: number
  offset?: number
}

export interface MeetingListQuery {
  status?: string
  limit?: number
  offset?: number
}

export const adminApi = {
  // ── 행사 ───────────────────────────────────────────────────────────────────
  // GET(목록) / POST(생성)
  events: () => `${BASE}/events`,
  // GET(단건) / PATCH — name, venue_name, exhibition_start/end, application_start/end
  event: (eventId: string) => `${BASE}/events/${enc(eventId)}`,
  // GET / PATCH — slot_minutes, enabled_venue_types, allow_same_role_discovery
  eventSettings: (eventId: string) => `${BASE}/events/${enc(eventId)}/settings`,

  // ── 기업 (event 스코프) ────────────────────────────────────────────────────
  organizations: (eventId: string, query: OrganizationListQuery = {}) =>
    `${BASE}/events/${enc(eventId)}/organizations${queryString({ ...query })}`,
  organization: (eventId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}`,
  // PATCH — 직접 수정. role 쿼리로 buyer/exhibitor 프로필 스키마를 가른다.
  organizationProfile: (eventId: string, organizationId: string, role: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/profile${queryString({ role })}`,
  // POST — 대리작성. master는 approved, sub는 submitted로 전환한다.
  organizationProxyProfile: (eventId: string, organizationId: string, role: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/proxy-profile${queryString({ role })}`,
  // PATCH — body { slots: [...] } 전체 치환.
  organizationUnavailableSlots: (eventId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/unavailable-slots`,
  // GET — org_id → 불가 슬롯 배열 전체(H8). organizations 목록 응답엔 이 필드가 없어(unavailable_slots
  // 미포함) 별도로 조회한다 — 없으면 설정 화면이 항상 빈 배열로 초기화돼 PATCH가 성공해도 새로고침
  // 후 사라진 것처럼 보인다.
  unavailableSlots: (eventId: string) => `${BASE}/events/${enc(eventId)}/unavailable-slots`,
  // PATCH — body { password }. 담당자(members 첫 행) 계정 비밀번호 설정/재설정.
  // 이 행사의 운영자(master·sub)가 쓰고, sub는 자기 관할 바이어만(백엔드가 관할을 판정한다).
  // 응답에는 비밀번호도 해시도 없다(식별 정보만) — 평문은 요청 본문으로만 흐른다.
  organizationContactPassword: (eventId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/contact-password`,
  // PATCH — body { role: "buyer" | "exhibitor" }. 이 행사에서의 참가 역할을 바꾼다.
  organizationRole: (eventId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/role`,
  // PATCH — body { status, note? }. 신청서 검토(승인/반려/수정요청, OP-003) — submitted만, master 전용.
  // /organizer/members(참가기업 관리)의 심사 모달과 같은 백엔드 엔드포인트(app/admin/router.py
  // review_organization). 그쪽은 첫 행사로 event_id를 보완하지만(app/api/organizer/members/
  // [memberId]/status/route.ts), 여기 admin 콘솔은 이미 확정된 event.id(EventSwitcher로 고른 행사)를
  // 그대로 쓴다 — 여러 행사를 오가는 슈퍼어드민이 다른 행사를 심사하는 사고를 막는다.
  organizationReview: (eventId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/organizations/${enc(organizationId)}/review`,

  // ── 운영자 (event 스코프) ──────────────────────────────────────────────────
  // GET(목록) / POST(서브어드민 부여 — body { member_id, permission_level: "sub" })
  // ⚠ master(슈퍼어드민)는 DB에서만 부여한다. 이 경로로 master를 만들 수 없다(백엔드도 거절).
  organizers: (eventId: string) => `${BASE}/events/${enc(eventId)}/organizers`,
  // DELETE — 권한 회수.
  organizer: (eventId: string, organizerId: string) =>
    `${BASE}/events/${enc(eventId)}/organizers/${enc(organizerId)}`,

  // ── 미팅 (event 스코프) ────────────────────────────────────────────────────
  meetings: (eventId: string, query: MeetingListQuery = {}) =>
    `${BASE}/events/${enc(eventId)}/meetings${queryString({ ...query })}`,
  meetingCancel: (eventId: string, meetingId: string) =>
    `${BASE}/events/${enc(eventId)}/meetings/${enc(meetingId)}/cancel`,

  // ── 알림 (event 스코프) ────────────────────────────────────────────────────
  // 백엔드 구현됨(#OP 알림 콘솔) — 발송 이력 = notification_dispatches 행, 재발송은 그 행 갱신.
  notifications: (eventId: string) => `${BASE}/events/${enc(eventId)}/notifications`,
  notificationResend: (eventId: string, logId: string) =>
    `${BASE}/events/${enc(eventId)}/notifications/${enc(logId)}/resend`,

  // ── 통역사 (event 스코프) ──────────────────────────────────────────────────
  interpreters: (eventId: string) => `${BASE}/events/${enc(eventId)}/interpreters`,
  interpreter: (eventId: string, interpreterId: string) =>
    `${BASE}/events/${enc(eventId)}/interpreters/${enc(interpreterId)}`,
  // POST — body { organization_id }
  interpreterAssign: (eventId: string, interpreterId: string) =>
    `${BASE}/events/${enc(eventId)}/interpreters/${enc(interpreterId)}/assign`,
  // DELETE — 배정 해제는 기업 id를 경로로 받는다(POST와 대칭이 아님에 주의).
  interpreterUnassign: (eventId: string, interpreterId: string, organizationId: string) =>
    `${BASE}/events/${enc(eventId)}/interpreters/${enc(interpreterId)}/assign/${enc(organizationId)}`,

  // ── 미팅 장소(event 스코프) ────────────────────────────────────────────────
  // GET(목록, operator) / POST(생성, master). booth는 자동 생성이라 CRUD 대상 아님
  // (zone_table·business_room만) — 목록은 라벨 순 = 실제 배정 순서.
  venues: (eventId: string) => `${BASE}/events/${enc(eventId)}/venues`,
  // PATCH(라벨 변경) / DELETE — 둘 다 master. 라벨 중복 409, 참조 미팅 있으면 삭제 409.
  venue: (eventId: string, venueId: string) =>
    `${BASE}/events/${enc(eventId)}/venues/${enc(venueId)}`,

  // ── 엑셀 (전역 경로 + event_id 쿼리) ──────────────────────────────────────
  export: (kind: "organizations" | "meetings" | "reviews", eventId: string) =>
    `${BASE}/export/${kind}.xlsx${queryString({ event_id: eventId })}`,
} as const
