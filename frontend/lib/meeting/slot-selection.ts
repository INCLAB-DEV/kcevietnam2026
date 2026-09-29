// 연속 슬롯 선택 규칙(F-MT-001 D4 / User Story 3)을 캡슐화한 순수 모듈.
// 규칙: ① 스팬이 maxMeetingMinutes 이하 ② 연속(인접)만 ③ 해제는 가장자리에서만(중간 해제 불가)
//       ④ 불가 슬롯 선택 불가.
//
// ⚠ 칸 **길이**와 칸 **간격**은 다른 값이다(mt003gap0001 — 발주사 운영표가 "40분 상담 + 5분 텀").
// 그래서 모든 산술은 SlotShape를 인자로 받는다. 구버전은 30분을 상수로 박아둬서(구 `slotCount * 30`,
// `addMinutes(last.time, 30)`) 40분 행사에서 참가자 화면이 "10:00 - 10:30"을 찍었고, 연속 상한도
// "3칸"으로 고정돼 있어 40분 3칸 = 130분(기준 1시간 반 초과)을 허용했다.
// 기본값을 일부러 두지 않는다 — 호출부가 행사값을 넘기는 걸 잊어도 테스트가 통과해버리면
// 이 회귀가 다시 조용히 돌아오기 때문이다(백엔드 format_meetings_rows의 slot_minutes와 같은 방침).

import type { MeetingDate, TimeSlot } from "./types"
import type { Translator } from "./meeting-projection"

/// 격자 모양. 간격(stride) = slotMinutes + slotGapMinutes.
export interface SlotShape {
  /// 칸 하나의 길이(분) — 상담 시간.
  slotMinutes: number
  /// 칸 사이 텀(분). 어느 미팅에도 점유되지 않는다.
  slotGapMinutes: number
  /// 연속 슬롯을 이은 미팅 1건의 **스팬** 상한(분). 칸 수 상한이 아니다.
  maxMeetingMinutes: number
}

// t 미주입 호출부(단위 테스트 등 i18n 범위 밖) 보존용 한국어 폴백 — messages/ko.json의
// meeting.request와 동일 문구를 유지한다(값이 바뀌면 양쪽 다 갱신).
const defaultT: Translator = (key, values) => {
  if (key === "durationMinutes") return `${values?.count}분`
  if (key === "durationHours") return `${values?.count}시간`
  if (key === "durationHoursMinutes") return `${values?.hours}시간 ${values?.minutes}분`
  return key
}

/// 칸 하나의 시작에서 다음 칸의 시작까지(분).
export function strideMinutes(shape: SlotShape): number {
  return shape.slotMinutes + shape.slotGapMinutes
}

/// n칸을 이은 미팅의 스팬(분) = (n-1) * stride + slotMinutes.
/// 마지막 칸 **뒤의** 텀은 미팅에 포함되지 않는다(백엔드 validate_slot_run의 스팬 정의와 동일 —
/// 마지막 칸 end − 첫 칸 start). n칸의 중간 텀 (n-1)개는 스팬에 **포함**된다.
export function spanMinutes(slotCount: number, shape: SlotShape): number {
  if (slotCount <= 0) return 0
  return (slotCount - 1) * strideMinutes(shape) + shape.slotMinutes
}

/// 상한 안에 들어오는 최대 칸 수. 스팬이 상한을 넘는 순간부터는 붙일 수 없다.
export function maxRunSlots(shape: SlotShape): number {
  if (shape.slotMinutes <= 0) return 0
  let n = 0
  while (spanMinutes(n + 1, shape) <= shape.maxMeetingMinutes) n += 1
  return n
}

// 한 날짜의 슬롯을 시간순 단일 배열로(오전→오후). 인접 판정의 기준 순서가 된다.
//
// ⚠ 이 순서는 **그리드 순서**다. 40분/텀5분 격자에서 오전 마지막 칸(11:30)과 오후 첫 칸(13:00)은
// 배열로는 이웃하지만 시각으로는 90분 벌어져 있다(사이에 점심). 그래서 인접 판정은 배열 인덱스뿐
// 아니라 **시각 차이 == stride** 도 함께 본다 — 안 하면 점심을 가로지르는 선택이 허용된다.
export function orderedSlots(date: MeetingDate): TimeSlot[] {
  return [...date.morning, ...date.afternoon]
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}

function addMinutes(time: string, mins: number): string {
  const total = toMinutes(time) + mins
  const hh = Math.floor(total / 60)
  const mm = total % 60
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`
}

/// 인덱스로 이웃한 두 칸이 시각으로도 stride만큼 떨어져 있는지. 점심(또는 운영 중단)으로 끊긴
/// 경계는 false가 된다.
function isTimeAdjacent(a: TimeSlot, b: TimeSlot, shape: SlotShape): boolean {
  return Math.abs(toMinutes(b.time) - toMinutes(a.time)) === strideMinutes(shape)
}

// 슬롯 클릭 시 새 선택 목록을 반환. 규칙 위반 입력은 합리적으로 흡수한다(불변).
export function toggleSlot(
  ordered: TimeSlot[],
  selection: string[],
  clickedId: string,
  shape: SlotShape
): string[] {
  const clicked = ordered.find((s) => s.id === clickedId)
  if (!clicked || !clicked.available) return selection

  const selIdx = selection.indexOf(clickedId)
  if (selIdx !== -1) {
    // 이미 선택됨 — 가장자리만 해제, 중간은 그대로.
    if (selIdx === 0) return selection.slice(1)
    if (selIdx === selection.length - 1) return selection.slice(0, -1)
    return selection
  }

  if (selection.length === 0) return [clickedId]

  // 칸 수 대신 **분**으로 제한한다. 한 칸 더 붙였을 때의 스팬이 상한을 넘으면 확장하지 않는다.
  if (spanMinutes(selection.length + 1, shape) > shape.maxMeetingMinutes) return [clickedId]

  const idx = ordered.findIndex((s) => s.id === clickedId)
  const firstIdx = ordered.findIndex((s) => s.id === selection[0])
  const lastIdx = ordered.findIndex((s) => s.id === selection[selection.length - 1])

  // 앞/뒤로 인접(인덱스 + 시각 stride 둘 다)하면 확장, 아니면 새 선택 시작.
  if (idx === firstIdx - 1 && isTimeAdjacent(clicked, ordered[firstIdx], shape)) {
    return [clickedId, ...selection]
  }
  if (idx === lastIdx + 1 && isTimeAdjacent(ordered[lastIdx], clicked, shape)) {
    return [...selection, clickedId]
  }
  return [clickedId]
}

// 슬롯 개수 → 길이 표시("40분" / "1시간 25분"). t는 "meeting.request" 네임스페이스
// (messages/{ko,en}.json) — 미주입 시 한국어 폴백.
// 표시하는 값은 **스팬**(중간 텀 포함)이다 — 백엔드가 저장하는 scheduled_start~end와 같아야
// 화면과 DB가 다른 길이를 말하지 않는다.
export function durationLabel(
  slotCount: number,
  shape: SlotShape,
  t: Translator = defaultT
): string {
  const mins = spanMinutes(slotCount, shape)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return t("durationMinutes", { count: m })
  if (m === 0) return t("durationHours", { count: h })
  return t("durationHoursMinutes", { hours: h, minutes: m })
}

// 선택된 슬롯들의 "시작 - 끝 · 길이" 요약. 선택이 비면 null.
export function slotRangeLabel(
  ordered: TimeSlot[],
  selection: string[],
  shape: SlotShape,
  t: Translator = defaultT
): { range: string; duration: string } | null {
  if (selection.length === 0) return null
  const start = ordered.find((s) => s.id === selection[0])
  const last = ordered.find((s) => s.id === selection[selection.length - 1])
  if (!start || !last) return null
  return {
    // 끝은 **마지막 칸의 시작 + 칸 길이**다(마지막 칸 뒤의 텀은 미팅 시간이 아니다).
    range: `${start.time} - ${addMinutes(last.time, shape.slotMinutes)}`,
    duration: durationLabel(selection.length, shape, t),
  }
}
