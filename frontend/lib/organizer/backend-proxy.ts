// OP-005 Phase 5 — 운영자 배정(강제·포화) 실세션 프록시 공용 헬퍼.
//
// app/api/admin/[...path]/route.ts와 같은 Bearer 전달 원칙(클라 JS는 토큰을 만지지 않는다).
// event_id 해석은 OP-003(app/api/organizer/members/[memberId]/status/route.ts)이 쓴 방식 그대로
// 재사용한다 — GET /api/admin/events(그 운영자가 배정된 행사 목록)에서 **선택된 행사**를 고른다.
// 3개 라우트(assignments·saturation·saturation/confirm)가 이 해석을 공유하므로 여기로 뽑아둔다.
//
// ⚠ 행사 스코프 divergence 사고(2026-09-30): 슈퍼어드민 콘솔의 모든 READ 뷰는 선택 행사 쿠키
// (nabi_admin_event, lib/admin/events.ts)로 스코프되는데, 이 WRITE 프록시는 그 쿠키를 무시하고
// 항상 items[0](최신 행사)을 썼다. 행사가 2개 이상이면 운영자가 "보는" 행사와 쓰기가 "착지하는"
// 행사가 갈려, 화면에 보이던 슬롯 id를 다른 행사로 보내 백엔드가 422(slot outside event period)로
// 거절했다. 이제 resolveSelectedEvent(admin/events.ts, 셸이 쓰는 것과 같은 선택 로직)로 고른다 —
// 선택 로직을 여기서 다시 짜지 않는다.

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { ADMIN_EVENT_COOKIE, resolveSelectedEvent } from "@/lib/admin/events"
import type { AdminEvent } from "@/lib/admin/types"

export const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// 선택 행사 쿠키 읽기 — next/headers의 cookies()는 요청 스코프 밖에서 부르면 던진다. 이 헬퍼
// (resolveEventContext/resolveEventId)는 라우트 핸들러뿐 아니라 http-members-client·
// http-ops-metrics-client·http-assignment-schedule-client·console-access 등 여러 서버 전용
// 어댑터에서도 불리고, 그중 다수의 기존 vitest 스위트가 next/headers를 mock하지 않은 채 이
// 경로를 통과한다. 그래서 쿠키 읽기 실패(요청 스코프 없음·쿠키 없음)는 예외를 던지지 않고
// undefined로 돌려 아래 resolveSelectedEvent가 조용히 items[0] 폴백을 타게 한다.
async function readSelectedEventCookie(): Promise<string | undefined> {
  try {
    const jar = await cookies()
    return jar.get(ADMIN_EVENT_COOKIE)?.value
  } catch {
    return undefined
  }
}

// 실패에는 백엔드가 준 **이유**를 그대로 싣는다 — error(코드)만 남기고 message를 버리던 시절엔 화면이
// 모든 실패를 "네트워크 확인 후 다시 시도"로 뭉갰다(2026-10-01 고객 신고 "배정 저장에 실패했어요").
//   · message: 사람이 읽는 문장(MeetingError.message) — 화면 문구의 재료.
//   · busyRoles: SLOT_TAKEN일 때 그 시각에 막힌 쪽("exhibitor"/"buyer") — 누가 바쁜지 구분용.
//   · code: 백엔드가 **구조화된 detail**({code, message})로 준 코드. 문자열 detail이면 없다 — error는 둘 다
//     담으므로, 평문 문장과 코드를 갈라야 하는 호출부(예: 삭제 영향 미리보기의 "기업 없음")가 이것을 본다.
export type ProxyFailure = {
  ok: false
  status: number
  error: string
  message?: string
  busyRoles?: string[]
  code?: string
}
export type ProxyResult<T> = { ok: true; value: T } | ProxyFailure

type BackendErrorDetail = { code?: string; message?: string; busy_roles?: unknown }

// 백엔드 에러 바디는 {"detail":{"code","message",...extra}}(MeetingError.to_detail) — FastAPI 자동
// 검증 실패는 detail이 배열/문자열일 수도 있어 방어적으로 읽는다.
async function backendJson<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ProxyResult<T>> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { detail?: BackendErrorDetail | string }
      | null
    const detail = errBody?.detail
    // 문자열 detail(HTTPException — 예: 403 "운영자(master) 권한이 필요합니다")은 그 자체가 사람이
    // 읽는 이유다. error는 기존 계약대로 그 문자열을 유지하고, 화면용 message로도 싣는다.
    if (typeof detail === "string") {
      return { ok: false, status: res.status, error: detail, message: detail }
    }
    const failure: ProxyFailure = {
      ok: false,
      status: res.status,
      error: detail?.code ?? `http_${res.status}`,
    }
    if (typeof detail?.code === "string") failure.code = detail.code
    if (typeof detail?.message === "string" && detail.message) failure.message = detail.message
    if (Array.isArray(detail?.busy_roles)) {
      failure.busyRoles = detail.busy_roles.filter((r): r is string => typeof r === "string")
    }
    return failure
  }
  return { ok: true, value: (await res.json()) as T }
}

// 운영자가 배정된 첫 행사 — id + IANA 타임존(events.timezone) + 슬롯 길이(events.slot_minutes).
// 셋 다 백엔드 EventOut이 이미 내려주는 필드라 추가 왕복이 없다.
//
// · timezone: 슬롯키 ↔ scheduled_start 변환(assignments·saturation 라우트)이 반드시 이 값을 써야
//   한다 — +09:00을 코드에 박으면 행사 타임존이 KST가 아닐 때(베트남 ICT 등) 미팅이 몇 시간씩
//   어긋나 생성된다(H5/P0-2).
// · slotMinutes: 미팅 길이가 지정되지 않은 배정의 scheduled_end = 시작 + 슬롯 1칸이다. 이 값을
//   FE 상수로 대신하면 행사 설정과 어긋난 구간이 저장된다 — 10:00~10:30 배정이 10:00~10:45로
//   저장되던 QA 지적(B1/B2)이 정확히 그 사고였다(진실원천은 events.slot_minutes, ADR-0014 결정 5).
export async function resolveEventContext(
  token: string,
  opts?: { withSlotGap?: boolean },
): Promise<
  ProxyResult<{
    id: string
    timezone: string
    slotMinutes?: number
    slotGapMinutes?: number
  }>
> {
  const result = await backendJson<{
    items?: { id: string; timezone?: string; slot_minutes?: number }[]
  }>(token, "/api/admin/events")
  if (!result.ok) return result
  const items = result.value.items ?? []
  const cookieValue = await readSelectedEventCookie()
  // resolveSelectedEvent(lib/admin/events.ts)는 AdminEvent(id/name/venue_name/exhibition_start/…)를
  // 요구하지만, 실제로 읽는 필드는 id뿐이다(쿠키 id로 find, 없으면 첫 항목). 여기서 fetch하는
  // 항목은 id·timezone·slot_minutes만 보장하므로, 이 헬퍼를 위해 AdminEvent 형태로 재조립하는
  // 대신 좁은 캐스트로 넘긴다 — 런타임 값은 그대로이고 find(id) 비교만 쓰이므로 안전하다.
  const event = resolveSelectedEvent(items as unknown as AdminEvent[], cookieValue) as unknown as
    | { id: string; timezone?: string; slot_minutes?: number }
    | null
  if (!event) return { ok: false, status: 404, error: "no_event" }
  // timezone은 백엔드가 항상 채워 보내지만(모델 server_default), 방어적으로 폴백한다.
  // slot_minutes는 못 읽으면 undefined로 남겨 호출부가 폴백을 고르게 한다(0·NaN을 흘리지 않는다).
  const slotMinutes =
    typeof event.slot_minutes === "number" && event.slot_minutes > 0
      ? event.slot_minutes
      : undefined
  // 칸 사이 텀은 EventOut이 아니라 event_schedule_settings 값이라 행사 설정을 한 번 더 읽어야 한다.
  // EventOut에 넣으려면 list_events가 행사마다 settings를 조인해야 하고, 여러 엔드포인트가 공용하는
  // _event_out 시그니처까지 바뀌어 파급이 크다.
  //
  // ⚠ 그래서 **opt-in**이다(`withSlotGap`). 이 헬퍼는 resolveEventId까지 포함해 12곳이 호출하므로
  // 조건 없는 추가 왕복은 텀이 필요 없는 경로(회원 등록·수정·내보내기·미팅 취소·운영지표·콘솔 접근)까지
  // 전부 느리게 만들고, fetch 횟수를 가정한 BFF 테스트들도 깨뜨린다. 텀이 실제로 필요한 곳은
  // occupiedSlotIds로 slot_ids를 만드는 강제배정·재트리거(app/api/organizer/assignments)뿐이다.
  //
  // 이 값이 없으면 40분/텀5분 행사에서 occupiedSlotIds가 10:00·10:40·11:20 같은 존재하지 않는
  // 슬롯키를 만들어 백엔드 validate_slot_run에 422로 튕긴다(mt003gap0001).
  //
  // 설정 조회 실패는 **치명적이지 않게** 다룬다 — 이 실패 때문에 강제배정 전체가 죽으면 안 된다.
  // 못 읽으면 undefined(호출부가 텀 없음으로 폴백)이고, 그때는 텀이 있는 행사에서만 422가 난다.
  let slotGapMinutes: number | undefined
  if (opts?.withSlotGap) {
    const settings = await backendJson<{ slot_gap_minutes?: number }>(
      token,
      `/api/admin/events/${encodeURIComponent(event.id)}/settings`,
    )
    if (
      settings.ok &&
      typeof settings.value.slot_gap_minutes === "number" &&
      settings.value.slot_gap_minutes >= 0
    ) {
      slotGapMinutes = settings.value.slot_gap_minutes
    }
  }
  return {
    ok: true,
    value: {
      id: event.id,
      timezone: event.timezone ?? "Asia/Seoul",
      slotMinutes,
      slotGapMinutes,
    },
  }
}

// 운영자가 배정된 첫 행사 id. (타임존도 필요하면 resolveEventContext를 쓴다.)
export async function resolveEventId(token: string): Promise<ProxyResult<string>> {
  const result = await resolveEventContext(token)
  if (!result.ok) return result
  return { ok: true, value: result.value.id }
}

// ⚠ 강제 배정·⚡재보충의 **장소는 BFF가 고르지 않는다**(2026-10-01). 예전 resolveDefaultVenueId는
// GET .../venues(zone_table·business_room만 반환, booth 제외)에서 "첫 zone_table"을 빈 자리 확인 없이
// 골라 넘겼다 — 장소가 없는 부스 전용 행사에선 404 no_venue로 요청이 백엔드에 닿지도 못했고(9/30),
// 장소가 있으면 매번 같은 테이블이 박혀 한 시각에 행사 전체에서 미팅이 1건밖에 안 잡혔다(10/1).
// 이제 venue_id를 보내지 않고, 백엔드가 참가자 신청과 같은 정책(기본: 참가사 부스)으로 정한다
// (backend app/matching/assignment_service.py _auto_venue_resolver).

export { backendJson }

export type ProxyErrorBody = {
  success: false
  error: string
  message?: string
  busyRoles?: string[]
  savedCount?: number
}

// 세션 만료(upstream 401) 공통 응답 매핑 — assignments·saturation·saturation/confirm 세 write
// 라우트가 이 헬퍼로 upstream 실패를 NextResponse로 옮긴다. 401은 "session_expired"로 통일해
// 프론트가 일반 저장 실패와 구분해 재로그인으로 보낼 수 있게 한다.
// 401 이외 상태·코드(404 no_event, 409/422 백엔드 코드 등)는 원래 값 그대로 통과시키고, 백엔드가 준
// message·busyRoles도 함께 실어 보낸다 — 화면이 원인별 문구를 고를 재료다. extra(예: ⚡ 부분 저장
// 건수 savedCount)는 호출부가 덧붙인다.
export function sessionAwareErrorResponse(
  result: Omit<ProxyFailure, "ok">,
  extra?: { savedCount?: number },
): NextResponse<ProxyErrorBody> {
  if (result.status === 401) {
    return NextResponse.json({ success: false, error: "session_expired" }, { status: 401 })
  }
  const body: ProxyErrorBody = { success: false, error: result.error }
  if (result.message) body.message = result.message
  if (result.busyRoles && result.busyRoles.length > 0) body.busyRoles = result.busyRoles
  if (extra?.savedCount) body.savedCount = extra.savedCount
  return NextResponse.json(body, { status: result.status })
}
