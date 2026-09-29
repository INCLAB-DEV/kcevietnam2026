// 행사·설정 검증 — API로 나가기 전 프론트에서 한 번 거른다. 백엔드가 최종 권위지만, 잘못된 값을
// 보내 400을 받고 나서야 알려주는 대신 폼에서 즉시 막는다.
//
// 검증기가 둘인 이유는 **엔드포인트가 둘이기 때문**이다(백엔드 확정 계약):
//   · validateEvent         → PATCH /events/{id}          (이름·장소·전시기간·신청기간)
//   · validateEventSettings → PATCH /events/{id}/settings (슬롯 길이·장소유형·동일역할 열람)
// 폼이 두 리소스를 한 화면에서 다루더라도 검증·전송은 리소스별로 갈라 계약과 1:1로 맞춘다.

import {
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
