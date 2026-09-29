// OP-005 Phase 5 — 운영자 배정(강제·포화) 실세션 프록시 공용 헬퍼.
//
// app/api/admin/[...path]/route.ts와 같은 Bearer 전달 원칙(클라 JS는 토큰을 만지지 않는다).
// event_id 해석은 OP-003(app/api/organizer/members/[memberId]/status/route.ts)이 쓴 방식 그대로
// 재사용한다 — GET /api/admin/events(그 운영자가 배정된 행사 목록)의 첫 번째 행사(구 organizer
// 콘솔은 아직 행사 선택 UI가 없는 단일 행사 전제). 3개 라우트(assignments·saturation·
// saturation/confirm)가 이 해석을 공유하므로 여기로 뽑아둔다.

export const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export type ProxyResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

// 백엔드 에러 바디는 {"detail":{"code","message"}}(MeetingError.to_detail) — FastAPI 자동 검증
// 실패는 detail이 배열/문자열일 수도 있어 방어적으로 읽는다.
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
      | { detail?: { code?: string; message?: string } | string }
      | null
    const detail = errBody?.detail
    const error = typeof detail === "string" ? detail : (detail?.code ?? `http_${res.status}`)
    return { ok: false, status: res.status, error }
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
  const event = result.value.items?.[0]
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

// 강제 배정 기본 장소 — 구 organizer 콘솔의 빈 슬롯 시트에는 장소 선택 UI가 없다(venue는 상세
// 표시용 기본값 "비즈매칭존 테이블"뿐). zone_table을 우선한다(포화배정 자동선택과 동일 원칙 —
// app/matching/assignment_service.py _SATURATION_VENUE_PRIORITY 미러), 없으면 첫 장소로 폴백.
export async function resolveDefaultVenueId(token: string, eventId: string): Promise<ProxyResult<string>> {
  const result = await backendJson<{ id: string; venue_type: string }[]>(
    token,
    `/api/admin/events/${encodeURIComponent(eventId)}/venues`,
  )
  if (!result.ok) return result
  const venues = result.value
  const preferred = venues.find((v) => v.venue_type === "zone_table") ?? venues[0]
  if (!preferred) return { ok: false, status: 404, error: "no_venue" }
  return { ok: true, value: preferred.id }
}

export { backendJson }
