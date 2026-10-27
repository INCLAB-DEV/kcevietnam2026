// 행사·설정 검증 — API로 나가기 전 프론트에서 한 번 거른다. 백엔드가 최종 권위지만, 잘못된 값을
// 보내 400을 받고 나서야 알려주는 대신 폼에서 즉시 막는다.
//
// 검증기가 둘인 이유는 **엔드포인트가 둘이기 때문**이다(백엔드 확정 계약):
//   · validateEvent         → PATCH /events/{id}          (이름·장소·전시기간·신청기간)
//   · validateEventSettings → PATCH /events/{id}/settings (슬롯 길이·장소유형·동일역할 열람·참가자 메뉴·
//                                                          참가자 알림 메일)
// 폼이 두 리소스를 한 화면에서 다루더라도 검증·전송은 리소스별로 갈라 계약과 1:1로 맞춘다.

import {
  PARTICIPANT_MENUS,
  parseParticipantMenu,
  type ParticipantMenu,
} from "@/lib/event/participant-menu"
import {
  DEFAULT_PARTICIPANT_EMAIL_ENABLED,
  SLOT_MINUTES_OPTIONS,
  VENUE_TYPES,
  type AdminEvent,
  type AdminEventPatch,
  type AdminEventSettings,
  type AdminEventSettingsPatch,
  type SlotMinutes,
  type VenueType,
} from "./types"

export function isSlotMinutes(value: unknown): value is SlotMinutes {
  return typeof value === "number" && (SLOT_MINUTES_OPTIONS as readonly number[]).includes(value)
}

export function isVenueType(value: unknown): value is VenueType {
  return typeof value === "string" && (VENUE_TYPES as readonly string[]).includes(value)
}

// 저장할 값 검증용 — 어휘 밖이면 거른다. (응답을 읽을 때의 관대한 해석은 parseParticipantMenu가 한다:
// 읽기는 모르는 값을 기본값으로 접고, 쓰기는 모르는 값을 보내지 않는다.)
export function isParticipantMenu(value: unknown): value is ParticipantMenu {
  return typeof value === "string" && (PARTICIPANT_MENUS as readonly string[]).includes(value)
}

// YYYY-MM-DD 형태 + 실재하는 날짜인지. 2026-13-01·2026-02-30 같은 값은 거른다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isEventDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

// ── 오류 어휘 ────────────────────────────────────────────────────────────────

export type SettingsError =
  | "slot-minutes-invalid"
  | "venue-types-empty"
  | "slot-gap-invalid"
  | "max-meeting-invalid"
  | "participant-menu-invalid"
  | "participant-email-invalid"

export type EventError =
  | "name-required"
  | "exhibition-start-invalid"
  | "exhibition-end-invalid"
  | "exhibition-period-reversed"
  | "application-start-invalid"
  | "application-end-invalid"
  | "application-period-reversed"

export const SETTINGS_ERROR_MESSAGES: Record<SettingsError, string> = {
  "slot-minutes-invalid": "미팅 시간 단위는 10 / 20 / 30 / 40 / 60분 중에서 선택해 주세요.",
  "venue-types-empty": "미팅 장소 유형을 최소 1개 이상 선택해 주세요.",
  "slot-gap-invalid": "슬롯 간격(텀)은 0~30분 사이로 입력해 주세요.",
  "max-meeting-invalid": "미팅 최대 길이는 10~480분 사이로 입력해 주세요.",
  "participant-menu-invalid": "참가자 메뉴는 ‘미팅만’ 또는 ‘전체 메뉴’ 중에서 선택해 주세요.",
  "participant-email-invalid": "참가사·바이어 알림 메일은 ‘보내지 않음’ 또는 ‘보냄’ 중에서 선택해 주세요.",
}

export const EVENT_ERROR_MESSAGES: Record<EventError, string> = {
  "name-required": "행사명을 입력해 주세요.",
  "exhibition-start-invalid": "전시 시작일을 YYYY-MM-DD 형식으로 입력해 주세요.",
  "exhibition-end-invalid": "전시 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.",
  "exhibition-period-reversed": "전시 종료일은 시작일과 같거나 그 이후여야 합니다.",
  "application-start-invalid": "신청 시작일을 YYYY-MM-DD 형식으로 입력해 주세요.",
  "application-end-invalid": "신청 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.",
  "application-period-reversed": "신청 종료일은 시작일과 같거나 그 이후여야 합니다.",
}

// ── 설정 검증 (PATCH /events/{id}/settings) ──────────────────────────────────

export type SettingsValidation =
  | { valid: true; settings: AdminEventSettings }
  | { valid: false; errors: SettingsError[] }

// 규칙:
//  · slot_minutes ∈ {10,20,30,40,60} — 그리드 열 수와 미팅 길이가 이 값에서 파생되므로 임의 값 금지.
//  · enabled_venue_types 최소 1개 — 전부 끄면 어떤 미팅도 장소를 못 가져 배정이 불가능해진다.
//  · slot_gap_minutes ∈ [0,30] — 계약서 §3.1. 칸 사이 텀(분).
//  · max_meeting_minutes ∈ [10,480] — 계약서 §3.1. 연속 예약(멀티슬롯) 상한(분).
//  · participant_menu ∈ {meetings_only, full} — 백엔드 Literal(extra=forbid)이 어휘 밖 값을 422로 거른다.
//  · participant_email_enabled ∈ {true, false} — 백엔드 StrictBool이 그 밖의 값(null·문자열·숫자)을 422로 거른다.
export function validateEventSettings(
  current: AdminEventSettings,
  patch: AdminEventSettingsPatch,
): SettingsValidation {
  const next: AdminEventSettings = { ...current, ...patch }
  const errors: SettingsError[] = []

  if (!isSlotMinutes(next.slot_minutes)) errors.push("slot-minutes-invalid")
  if (
    !Array.isArray(next.enabled_venue_types) ||
    next.enabled_venue_types.filter(isVenueType).length === 0
  ) {
    errors.push("venue-types-empty")
  }
  if (
    !Number.isInteger(next.slot_gap_minutes) ||
    next.slot_gap_minutes < 0 ||
    next.slot_gap_minutes > 30
  ) {
    errors.push("slot-gap-invalid")
  }
  if (
    !Number.isInteger(next.max_meeting_minutes) ||
    next.max_meeting_minutes < 10 ||
    next.max_meeting_minutes > 480
  ) {
    errors.push("max-meeting-invalid")
  }
  if (!isParticipantMenu(next.participant_menu)) errors.push("participant-menu-invalid")
  if (typeof next.participant_email_enabled !== "boolean") errors.push("participant-email-invalid")

  if (errors.length > 0) return { valid: false, errors }
  // 중복·미지원 장소유형은 정규화해 저장한다(순서는 VENUE_TYPES 기준으로 안정화).
  const enabled_venue_types = VENUE_TYPES.filter((v) => next.enabled_venue_types.includes(v))
  return { valid: true, settings: { ...next, enabled_venue_types } }
}

// ── 행사 검증 (PATCH /events/{id}) ───────────────────────────────────────────

export type EventValidation =
  | { valid: true; event: Omit<AdminEvent, "id"> }
  | { valid: false; errors: EventError[] }

// 규칙:
//  · name 필수 — 스위처·목록의 유일한 식별 표시.
//  · 전시기간·신청기간 각각 시작 ≤ 종료. 역전 기간은 신청 게이트(ADR-0002)를 영구히 닫아버린다.
// 첫 에러에서 끊지 않고 전부 돌려준다 — 폼이 모든 문제를 한 번에 보여줄 수 있게.
export function validateEvent(
  current: Omit<AdminEvent, "id">,
  patch: AdminEventPatch,
): EventValidation {
  const next = { ...current, ...patch }
  const errors: EventError[] = []

  if (!next.name?.trim()) errors.push("name-required")

  if (!isEventDate(next.exhibition_start)) errors.push("exhibition-start-invalid")
  if (!isEventDate(next.exhibition_end)) errors.push("exhibition-end-invalid")
  if (
    isEventDate(next.exhibition_start) &&
    isEventDate(next.exhibition_end) &&
    next.exhibition_start > next.exhibition_end
  ) {
    errors.push("exhibition-period-reversed")
  }

  if (!isEventDate(next.application_start)) errors.push("application-start-invalid")
  if (!isEventDate(next.application_end)) errors.push("application-end-invalid")
  if (
    isEventDate(next.application_start) &&
    isEventDate(next.application_end) &&
    next.application_start > next.application_end
  ) {
    errors.push("application-period-reversed")
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, event: { ...next, name: next.name.trim() } }
}

export type ApplicationPeriodError = Extract<
  EventError,
  "application-start-invalid" | "application-end-invalid" | "application-period-reversed"
>

export type ApplicationPeriodValidation =
  | { valid: true }
  | { valid: false; errors: ApplicationPeriodError[] }

// 행사 설정 화면(event-settings-console) 전용 — 신청기간만 검증한다.
// validateEvent는 행사 등록/수정 전체 폼(events-console)을 위한 것이라 전시기간까지 함께 요구하는데,
// 이 화면엔 전시기간 입력칸이 아예 없다. 백엔드가 전시기간을 아직 비워 보내면(exhibition_start/end
// 미확정 → "") validateEvent가 영원히 실패해 **신청기간만 고쳐도 저장이 안 나가던** 버그(H7)의
// 한 갈래였다 — 이 화면이 실제로 쓰는 필드만 검증한다.
export function validateApplicationPeriod(period: {
  application_start: string
  application_end: string
}): ApplicationPeriodValidation {
  const errors: ApplicationPeriodError[] = []

  if (!isEventDate(period.application_start)) errors.push("application-start-invalid")
  if (!isEventDate(period.application_end)) errors.push("application-end-invalid")
  if (
    isEventDate(period.application_start) &&
    isEventDate(period.application_end) &&
    period.application_start > period.application_end
  ) {
    errors.push("application-period-reversed")
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true }
}

// ── 보조 ─────────────────────────────────────────────────────────────────────

// 장소유형 토글 — 마지막 1개를 끄려는 시도는 무시한다(빈 배열 방지를 UI 단에서도 한 번 더).
export function toggleVenueType(current: VenueType[], target: VenueType): VenueType[] {
  const has = current.includes(target)
  if (has && current.length === 1) return current
  return has
    ? current.filter((v) => v !== target)
    : VENUE_TYPES.filter((v) => v === target || current.includes(v))
}

// 슬롯 길이(또는 간격)가 바뀌면 기존 슬롯 id(`날짜T시각`)가 새 격자와 어긋난다. 몇 건이 어긋나는지
// 세어 저장 전에 경고로 알려준다(운영자가 모르고 불가 시간대를 날리는 사고 방지).
//
// ⚠ 예전엔 "자정 기준 (h*60+m) % slotMinutes"로 판정했다 — 앵커(운영 시작 시각) 개념이 없어
// 피치가 슬롯 길이와 달라지면(계약서 §1 stride) 정상 슬롯을 어긋남으로 오판했다(계약서 §3.10:
// 10:00~18:10/40분/5분텀 격자에서 10:00은 600%45=15≠0이라 "정상인데 어긋남"으로 잘못 경고).
// 이제는 실제 격자를 만드는 단일 진실원천(schedule.slotTimes)이 낸 유효 시각 목록과 직접
// 대조한다 — 모듈로를 재발명하지 않으므로 stride·점심 규칙이 바뀌어도 항상 실제 격자와 일치한다.
export function countMisalignedSlots(slotIds: string[], validTimes: readonly string[]): number {
  const valid = new Set(validTimes)
  return slotIds.filter((id) => !valid.has(id.slice(id.indexOf("T") + 1))).length
}

// ── 응답 매핑 (GET·PATCH /events/{id}/settings 의 EventSettingsOut) ─────────────
// 서버 렌더(lib/admin/http-client)와 설정 화면(PATCH 응답 본문·실패 뒤 재조회)이 같은 규칙으로 읽는다.

// 백엔드는 time 컬럼을 "HH:MM:SS"로 직렬화한다 — 콘솔 타입은 "HH:MM"(H9, event-settings-console의
// slotTimes가 기대하는 형식)만 쓰므로 여기서 한 번만 잘라낸다.
function hhmm(value: string): string {
  return value.slice(0, 5)
}
function hhmmOrNull(value: string | null | undefined): string | null {
  return value ? hhmm(value) : null
}

export interface EventSettingsOutSnake {
  event_id: string
  slot_minutes: AdminEventSettings["slot_minutes"]
  enabled_venue_types: AdminEventSettings["enabled_venue_types"]
  allow_same_role_discovery: boolean
  operating_start: string // "HH:MM:SS"
  operating_end: string
  lunch_start?: string | null
  lunch_end?: string | null
  min_guaranteed_slots: number
  // Phase 1 계약서 §3.1 추가 필드 — 슬롯 간격(텀)·연속 예약 상한(분).
  slot_gap_minutes: number
  max_meeting_minutes: number
  // 참가자 메뉴(nv001menu0001). 이 필드가 생기기 전의 백엔드는 보내지 않는다 — 그때는 기본값으로 읽는다.
  participant_menu?: string | null
  // 참가자 알림 메일(nt004mail0001). 값을 알 수 없으면(필드 없음·불리언이 아님) 기본값(꺼짐) 하나로 접는다
  // (DEFAULT_PARTICIPANT_EMAIL_ENABLED). ⚠ 이 필드가 생기기 전의 백엔드는 실제로는 메일을 늘 보냈지만, FE·BE는
  // 같은 배포로 함께 올라가므로 그 조합을 따로 다루지 않는다.
  participant_email_enabled?: boolean | null
}

// H9 — 이 매핑이 없던 시절엔 콘솔 타입(AdminEventSettings)이 운영시간 5필드를 아예 선언하지 않아
// /admin/settings가 백엔드 값을 받고도 못 쓰고 FE 하드코딩(OPERATING_WINDOW, 10:00~18:10/45분)으로
// 대체했다 — 그 허구 상수와 DB 실값(09:00~18:00/30분)이 달라 화면마다 슬롯 격자가 갈렸다.
export function toAdminEventSettings(s: EventSettingsOutSnake): AdminEventSettings {
  return {
    event_id: s.event_id,
    slot_minutes: s.slot_minutes,
    enabled_venue_types: s.enabled_venue_types,
    allow_same_role_discovery: s.allow_same_role_discovery,
    operating_start: hhmm(s.operating_start),
    operating_end: hhmm(s.operating_end),
    lunch_start: hhmmOrNull(s.lunch_start),
    lunch_end: hhmmOrNull(s.lunch_end),
    min_guaranteed_slots: s.min_guaranteed_slots,
    slot_gap_minutes: s.slot_gap_minutes,
    max_meeting_minutes: s.max_meeting_minutes,
    participant_menu: parseParticipantMenu(s.participant_menu),
    participant_email_enabled:
      typeof s.participant_email_enabled === "boolean"
        ? s.participant_email_enabled
        : DEFAULT_PARTICIPANT_EMAIL_ENABLED,
  }
}

// ── 부분 저장 (PATCH /events/{id}/settings 본문 = 바뀐 필드만) ───────────────────
// 백엔드는 PATCH를 exclude_unset으로 받는다(보낸 키만 바꾼다). 화면을 열 때 읽은 값을 통째로 다시 보내면, 그
// 사이 다른 마스터가 바꾼 값(예: 참가자 알림 메일)을 오래 열어 둔 탭이 되돌려 버린다 — 그래서 운영자가 이 화면에서
// 실제로 바꾼 필드만 보낸다.

// 이 화면이 다루는(PATCH에 실을 수 있는) 설정 필드. min_guaranteed_slots는 이 화면에서 바꾸지 않는다.
export const EDITABLE_SETTINGS_FIELDS = [
  "slot_minutes",
  "enabled_venue_types",
  "allow_same_role_discovery",
  "operating_start",
  "operating_end",
  "lunch_start",
  "lunch_end",
  "slot_gap_minutes",
  "max_meeting_minutes",
  "participant_menu",
  "participant_email_enabled",
] as const satisfies readonly (keyof AdminEventSettings)[]

type EditableSettingsField = (typeof EDITABLE_SETTINGS_FIELDS)[number]

// 같은 값인가 — 배열(장소 유형)은 순서까지, 점심은 null과 ""를 같게 본다(입력칸은 빈 문자열, 서버는 null).
function sameSettingValue(field: EditableSettingsField, a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return ((a as unknown[] | null) ?? []).join(",") === ((b as unknown[] | null) ?? []).join(",")
  }
  if (field === "lunch_start" || field === "lunch_end") return (a ?? "") === (b ?? "")
  return a === b
}

// base → edited 사이에 바뀐 필드 이름들.
export function changedSettingsFields(
  base: AdminEventSettings,
  edited: AdminEventSettings,
): EditableSettingsField[] {
  return EDITABLE_SETTINGS_FIELDS.filter((f) => !sameSettingValue(f, base[f], edited[f]))
}

// PATCH 본문 — 고른 필드만 values에서 꺼낸다(values는 검증·정규화를 거친 값).
export function settingsPatchOf(
  values: AdminEventSettings,
  fields: readonly EditableSettingsField[],
): AdminEventSettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const f of fields) patch[f] = values[f]
  return patch as AdminEventSettingsPatch
}

// 서버 값(fresh)이 새로 왔을 때 편집 중인 값(draft)을 그 위에 다시 얹는다 — draft가 base와 같은(운영자가 손대지
// 않은) 필드는 서버 값을 따르고, 운영자가 바꾼 필드만 draft를 남긴다. 저장 성공(base=보낸 값, fresh=응답)과
// 실패 뒤 재조회(base=저장 전 값, fresh=서버 현재 값) 둘 다 이 규칙이다.
export function rebaseSettingsDraft(
  draft: AdminEventSettings,
  base: AdminEventSettings,
  fresh: AdminEventSettings,
): AdminEventSettings {
  const next: Record<string, unknown> = { ...fresh }
  for (const f of EDITABLE_SETTINGS_FIELDS) {
    if (!sameSettingValue(f, draft[f], base[f])) next[f] = draft[f]
  }
  return next as unknown as AdminEventSettings
}
