// 슈퍼어드민 콘솔의 쓰기(뮤테이션) seam — 클라 안전 모듈(ADR-0001의 session 표면에 해당).
//
// dispatch() 한 곳이 실연동 스왑 지점이다: `NEXT_PUBLIC_AUTH_CLIENT=http`(실연동 모드)면 같은
// 출처 BFF(app/api/admin/[...path]) 경유로 FastAPI에 실제로 보내고, 아니면 목업(요청 조립만 하고
// 성공 반환 — 화면은 낙관적 갱신)으로 데모를 유지한다. 실패를 던지지 않는 계약은 운영자 콘솔
// (lib/organizer/member-actions)과 같다 — 호출부는 결과를 보고 토스트만 띄운다(비차단).
// 경로는 lib/admin/api-paths.ts가 단일 소스다 — 경로가 바뀌면 거기만 고친다.
//
// 모든 이벤트 하위 액션이 eventId를 첫 인자로 받는 이유: 백엔드 경로가 event 스코프
// (`/api/admin/events/{event_id}/...`)라 event를 모르면 요청을 만들 수 없기 때문이다.

import { adminApi } from "./api-paths"
import { toAdminEventSettings, type EventSettingsOutSnake } from "./event-settings"
import { toLangCodes } from "./interpreters"
import type {
  AdminEventInput,
  AdminEventPatch,
  AdminEventSettings,
  AdminEventSettingsPatch,
  AdminInterpreterInput,
  AdminOrganizer,
  AdminOrganizerGrantRequest,
  AdminOrgProfilePatch,
  AdminOrgRole,
  AdminVenueInput,
  SlotMinutes,
  VenueType,
} from "./types"

// POST /api/admin/events 실제 wire 계약(backend/app/admin/schemas.py EventCreate, extra=forbid) —
// 정책 필드(slot_minutes 등)를 **top-level**로 받는다. AdminEventInput(lib/admin/types.ts)의 중첩
// `settings`는 이 계약과 다르다(types.ts는 다른 팀 소관이라 여기서 별도로 실제 계약대로 둔다).
export interface AdminEventCreateBody extends Omit<AdminEventInput, "settings"> {
  slot_minutes?: SlotMinutes
  enabled_venue_types?: VenueType[]
  allow_same_role_discovery?: boolean
}

export interface AdminActionResult {
  success: boolean
  error?: string
}

type Method = "POST" | "PATCH" | "DELETE"

// 실연동 모드 판정 — 로그인/auth seam과 동일한 env 스위치(NEXT_PUBLIC_AUTH_CLIENT). 어드민
// 실연동은 실 세션(BFF가 쿠키에서 읽어 붙이는 access_token)을 전제하므로 스위치를 공유한다:
// 이 값이 "http"가 아니면 토큰 자체가 없어 어드민 호출이 성립할 수 없다.
export function isAdminHttpMode(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http"
}

// 요청 디스패처. 실연동 모드면 같은 출처 BFF(app/api/admin/[...path])로 보내 FastAPI에 도달하고,
// 아니면 목업(요청 조립만 하고 성공 반환)으로 데모 화면을 유지한다.
// 인증 헤더는 여기가 아니라 BFF가 붙인다 — 클라 JS는 토큰을 만지지 않는다(경계 B, ADR-0001).
async function dispatch(method: Method, path: string, body?: unknown): Promise<AdminActionResult> {
  // 경로 오타는 런타임 404가 아니라 여기서 먼저 잡는다(계약은 api-paths.ts 단일 소스).
  if (!path.startsWith("/api/admin/")) return { success: false, error: "bad_path" }
  if (!isAdminHttpMode()) return { success: true }

  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) return { success: false, error: await errorCodeOf(res) }
  return { success: true }
}

// 실패 응답 → 에러 코드. FastAPI detail은 보통 문자열이지만, 화면이 문구가 아니라 코드로 갈라야 하는
// 에러(장소 CRUD의 라벨 충돌·사용 중 삭제, 운영자 부여의 없는 회원 등)는 {code, message} 객체로 온다 —
// 있으면 code를 우선 돌려준다. 422 필드 검증(배열)은 둘 다 아니라 상태코드만 간추린다.
async function errorCodeOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as
    | { detail?: string | { code?: string; message?: string } }
    | null
  const detail = data?.detail
  return typeof detail === "string"
    ? detail
    : typeof detail === "object" && detail !== null && typeof detail.code === "string"
      ? detail.code
      : `http_${res.status}`
}

// ── 행사 ─────────────────────────────────────────────────────────────────────

// POST /api/admin/events — 본문은 AdminEventCreateBody(평탄화된 실제 wire 계약, 위 참조).
export function createEvent(input: AdminEventCreateBody): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.events(), input)
}

// PATCH /api/admin/events/{event_id}
export function patchEvent(eventId: string, patch: AdminEventPatch): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.event(eventId), patch)
}

// PATCH /api/admin/events/{event_id}/settings
export function patchEventSettings(
  eventId: string,
  patch: AdminEventSettingsPatch,
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.eventSettings(eventId), patch)
}

// 행사 설정 화면의 저장 — 위와 같은 PATCH지만 **저장된 설정(응답 본문 EventSettingsOut)**을 돌려받는다.
// 화면은 서버가 저장했다고 답한 값만 "저장됨"으로 보인다(응답 전에 먼저 바꿔 보이지 않는다). dispatch는 본문을
// 버리므로 따로 둔다. 목업은 요청 없이 성공(settings 없음 — 화면이 보낸 값을 그대로 쓴다). 본문을 못 읽는
// 2xx도 settings 없이 성공으로 돌려준다. 네트워크 단절(fetch throw)은 실패로 접는다.
export interface EventSettingsSaveResult extends AdminActionResult {
  settings?: AdminEventSettings
}

export async function saveEventSettings(
  eventId: string,
  patch: AdminEventSettingsPatch,
): Promise<EventSettingsSaveResult> {
  if (!isAdminHttpMode()) return { success: true }
  try {
    const res = await fetch(adminApi.eventSettings(eventId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    if (!res.ok) return { success: false, error: await errorCodeOf(res) }
    const settings = await readEventSettings(res)
    return settings ? { success: true, settings } : { success: true }
  } catch {
    return { success: false, error: "network" }
  }
}

// GET /api/admin/events/{event_id}/settings — 저장이 실패한 뒤 서버의 지금 값을 다시 읽는다. 목업·실패는 null.
export async function loadEventSettings(eventId: string): Promise<AdminEventSettings | null> {
  if (!isAdminHttpMode()) return null
  try {
    const res = await fetch(adminApi.eventSettings(eventId))
    if (!res.ok) return null
    return (await readEventSettings(res)) ?? null
  } catch {
    return null
  }
}

async function readEventSettings(res: Response): Promise<AdminEventSettings | undefined> {
  const data = (await res.json().catch(() => null)) as Partial<EventSettingsOutSnake> | null
  if (!data || typeof data.event_id !== "string") return undefined
  return toAdminEventSettings(data as EventSettingsOutSnake)
}

// ── 기업 ─────────────────────────────────────────────────────────────────────

// PATCH .../organizations/{id}/profile?role=(직접 수정)은 여기 없다 — 저장된 프로필을 응답으로 받아
// 화면을 다시 그려야 해서(성공 여부만 돌려주는 dispatch로는 부족하다) 신청서 편집 패널의 전송
// (lib/admin/application-transport.ts)이 맡는다. 같은 PATCH를 두 군데서 조립하지 않는다.

// POST .../organizations/{id}/proxy-profile?role= — 대리작성.
// master는 approved, sub는 submitted로 전환된다(proxy-profile.ts 규칙).
export function postProxyProfile(
  eventId: string,
  organizationId: string,
  role: AdminOrgRole,
  patch: AdminOrgProfilePatch,
): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.organizationProxyProfile(eventId, organizationId, role), patch)
}

// PATCH .../organizations/{id}/unavailable-slots — 본문 키는 `slots`, 전체 치환.
export function patchUnavailableSlots(
  eventId: string,
  organizationId: string,
  slots: string[],
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.organizationUnavailableSlots(eventId, organizationId), {
    slots,
  })
}

// PATCH .../organizations/{id}/contact-password — 담당자 계정 비밀번호 설정/재설정.
// ⚠ 평문은 요청 본문으로만 나간다 — 결과에도 로그에도 남기지 않는다. 실패 코드는 백엔드 detail.code
// (PASSWORD_POLICY · OPERATOR_ACCOUNT · NO_CONTACT_MEMBER)가 그대로 온다(errorCodeOf).
export function setOrganizationContactPassword(
  eventId: string,
  organizationId: string,
  password: string,
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.organizationContactPassword(eventId, organizationId), {
    password,
  })
}

// PATCH .../organizations/{id}/role — 참가 역할 전환(바이어 ↔ 참가사).
export function patchOrganizationRole(
  eventId: string,
  organizationId: string,
  role: AdminOrgRole,
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.organizationRole(eventId, organizationId), { role })
}

// PATCH .../organizations/{id}/review — 신청서 검토 결정(승인/반려/수정요청). submitted가 아니면
// 백엔드가 409(사람이 읽을 수 있는 한글 사유)를 돌려준다 — 호출부는 result.error를 그대로 보여줘도 된다.
export function reviewOrganization(
  eventId: string,
  organizationId: string,
  status: "approved" | "rejected" | "changes_requested",
  note?: string,
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.organizationReview(eventId, organizationId), { status, note })
}

// ── 운영자(회원 역할) ────────────────────────────────────────────────────────

export interface GrantSubAdminResult extends AdminActionResult {
  // 서버가 확정한 배정 행(event_organizers.id + 회원 실명·이메일). 화면은 **이 값으로만** 행을 추가한다 —
  // 낙관적으로 지어낸 행은 실패 시 유령으로 남고, 지어낸 id로는 곧바로 회수할 수 없었다.
  organizer?: AdminOrganizer
}

// POST .../organizers — **서브어드민 부여 전용**. 대상은 가입된 회원의 로그인 이메일.
// permission_level 은 "sub" 리터럴로 못박는다 — 슈퍼어드민(master)은 DB에서만 부여하며,
// 이 함수로는 타입상 master를 보낼 수 없다(권한 상승 경로 차단, lib/admin/organizers 참조).
// 다른 액션과 달리 응답 본문(생성된 배정)이 필요해 dispatch 대신 직접 부른다. 던지지 않는다.
export async function grantSubAdmin(eventId: string, email: string): Promise<GrantSubAdminResult> {
  const body: AdminOrganizerGrantRequest = { email, permission_level: "sub" }
  if (!isAdminHttpMode()) {
    // 목업 — 회원 조회가 없으니 이메일을 이름 자리에 쓴다(데모 화면 유지용, 실연동에선 서버 값).
    return {
      success: true,
      organizer: {
        id: `adm-org-mock-${Date.now()}`,
        event_id: eventId,
        member_id: "",
        name: email,
        email,
        permission_level: "sub",
        trade_office: null,
        granted_at: new Date().toISOString(),
      },
    }
  }
  try {
    const res = await fetch(adminApi.organizers(eventId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { success: false, error: await errorCodeOf(res) }
    return { success: true, organizer: (await res.json()) as AdminOrganizer }
  } catch {
    return { success: false, error: "network" }
  }
}

// DELETE .../organizers/{organizer_id} — 권한 회수(서브어드민만).
export function revokeOrganizer(
  eventId: string,
  organizerId: string,
): Promise<AdminActionResult> {
  return dispatch("DELETE", adminApi.organizer(eventId, organizerId))
}

// ── 미팅 ─────────────────────────────────────────────────────────────────────

// POST .../meetings/{meeting_id}/cancel — 본문 키는 reason_text다(MeetingCancelIn, extra=forbid).
// reason_code는 운영자 취소 화면에 정형 사유 선택지가 없어 비운다(자유서술만 받는다).
export function cancelMeeting(
  eventId: string,
  meetingId: string,
  reason: string,
): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.meetingCancel(eventId, meetingId), { reason_text: reason })
}

// ── 알림 ─────────────────────────────────────────────────────────────────────

// POST .../notifications/{id}/resend (경로 확정 전 — api-paths.ts 주석 참조)
// 재발송 전용 경로다(공통 dispatch는 본문을 버린다). 백엔드는 재발송을 **시도한** 뒤 200을 주고, 실제로 전달됐는지는
// 본문의 delivered로 알린다 — 메일 서버 실패·주소 없음이면 200이어도 delivered=false다. 그 값을 돌려준다.
// 목업·본문 없음은 delivered가 없다(성공으로 본다). 409 PARTICIPANT_EMAIL_DISABLED 등 실패 코드는 error로.
export interface NotificationResendResult extends AdminActionResult {
  delivered?: boolean
}

export async function resendNotification(
  eventId: string,
  logId: string,
): Promise<NotificationResendResult> {
  if (!isAdminHttpMode()) return { success: true }
  const res = await fetch(adminApi.notificationResend(eventId, logId), { method: "POST" })
  if (!res.ok) return { success: false, error: await errorCodeOf(res) }
  const data = (await res.json().catch(() => null)) as { delivered?: unknown } | null
  return typeof data?.delivered === "boolean"
    ? { success: true, delivered: data.delivered }
    : { success: true }
}

// ── 통역사 ───────────────────────────────────────────────────────────────────

// POST .../interpreters — languages는 화면 자유텍스트(한글 라벨)라 backend Lang 코드로 바꿔
// 보낸다(InterpreterCreate.languages: list[Lang], toLangCodes 참조). 로컬 상태는 한글 라벨 그대로다.
export function createInterpreter(
  eventId: string,
  input: AdminInterpreterInput,
): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.interpreters(eventId), {
    ...input,
    languages: toLangCodes(input.languages),
  })
}

// PATCH .../interpreters/{interpreter_id} — languages를 보낼 때만 코드로 변환(다른 필드만 고치는
// 부분 PATCH는 languages 키 자체가 없다).
export function patchInterpreter(
  eventId: string,
  interpreterId: string,
  patch: Partial<AdminInterpreterInput>,
): Promise<AdminActionResult> {
  const body = patch.languages ? { ...patch, languages: toLangCodes(patch.languages) } : patch
  return dispatch("PATCH", adminApi.interpreter(eventId, interpreterId), body)
}

// DELETE .../interpreters/{interpreter_id}
export function deleteInterpreter(
  eventId: string,
  interpreterId: string,
): Promise<AdminActionResult> {
  return dispatch("DELETE", adminApi.interpreter(eventId, interpreterId))
}

// 배정/해제는 계약이 비대칭이다:
//   배정 = POST   .../assign            body { organization_id }
//   해제 = DELETE .../assign/{organization_id}
// 화면은 "기업 선택 또는 미배정" 한 동작으로 다루므로, 그 비대칭을 여기서 흡수한다.
export function assignInterpreterToOrg(
  eventId: string,
  interpreterId: string,
  organizationId: string,
): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.interpreterAssign(eventId, interpreterId), {
    organization_id: organizationId,
  })
}

export function unassignInterpreterFromOrg(
  eventId: string,
  interpreterId: string,
  organizationId: string,
): Promise<AdminActionResult> {
  return dispatch("DELETE", adminApi.interpreterUnassign(eventId, interpreterId, organizationId))
}

// 화면 편의 래퍼 — 다음 배정 대상이 있으면 배정, null이면 직전 기업에서 해제.
// 해제에 previousOrgId가 필요한 건 DELETE 경로가 기업 id를 요구하기 때문이다.
export function setInterpreterAssignment(
  eventId: string,
  interpreterId: string,
  nextOrgId: string | null,
  previousOrgId: string | null,
): Promise<AdminActionResult> {
  if (nextOrgId) return assignInterpreterToOrg(eventId, interpreterId, nextOrgId)
  if (previousOrgId) return unassignInterpreterFromOrg(eventId, interpreterId, previousOrgId)
  return Promise.resolve({ success: true }) // 이미 미배정 — 보낼 요청이 없다.
}

// ── 미팅 장소(zone_table·business_room) ─────────────────────────────────────
// booth는 자동 생성이라 이 액션들의 대상이 아니다(api-paths.ts 참고). 셋 다 master 전용 —
// sub가 호출하면 백엔드가 403을 돌려준다(화면은 readOnly로 애초에 버튼을 감춘다).

// POST .../venues — 라벨 중복 시 409(error: "VENUE_LABEL_TAKEN").
export function createVenue(eventId: string, input: AdminVenueInput): Promise<AdminActionResult> {
  return dispatch("POST", adminApi.venues(eventId), input)
}

// PATCH .../venues/{venue_id} — 라벨만 바꾼다. 라벨 중복 시 409(error: "VENUE_LABEL_TAKEN").
export function renameVenue(
  eventId: string,
  venueId: string,
  label: string,
): Promise<AdminActionResult> {
  return dispatch("PATCH", adminApi.venue(eventId, venueId), { label })
}

// DELETE .../venues/{venue_id} — 참조 미팅이 있으면 409(error: "VENUE_IN_USE").
export function deleteVenue(eventId: string, venueId: string): Promise<AdminActionResult> {
  return dispatch("DELETE", adminApi.venue(eventId, venueId))
}

// ── 엑셀 입출력 ──────────────────────────────────────────────────────────────

// GET /api/admin/export/{kind}.xlsx?event_id= — 실연동 시 이 URL로 바로 내려받는다.
// 목업 단계에서는 화면이 클라에서 직렬화해(lib/admin/export) 받으므로 경로만 계약으로 남긴다.
export const exportUrl = adminApi.export

// 명단 업로드(POST /api/admin/import/roster)는 여기 없다 — 두 콘솔이 공유하는 lib/roster/upload.ts가
// 같은 출처 BFF(app/api/organizer/members/roster)로 올린다(예전 importRosterFile은 그쪽으로 합쳤다).
