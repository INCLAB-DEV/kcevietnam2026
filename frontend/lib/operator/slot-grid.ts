// 미팅 불가 시간 격자(행사 기간 × 하루 슬롯)의 축 — 운영자 콘솔 세 곳(행사 설정, 대리작성 다이얼로그,
// 신청서 편집 패널)이 같은 축으로 같은 칸 id(`${YYYY-MM-DD}T${HH:MM}`)를 만들게 한다.
//
// 산술은 새로 만들지 않는다 — 세로축은 lib/admin/events.eventDateIds(전시 기간), 가로축은
// lib/schedule/slot-grid.slotGridTimes(백엔드 app/matching/slot_grid.py와 1:1인 공유 커널)다.
// 여기는 "행사·설정 응답 → 그 둘의 입력"을 한 번만 적어 두는 자리다.

import { eventDateIds } from "@/lib/admin/events"
import { slotGridTimes } from "@/lib/schedule/slot-grid"

export interface UnavailableSlotGrid {
  dateIds: string[] // "2026-10-20" — 전시 기간(양끝 포함)
  times: string[] // "10:00" — 하루 슬롯 시작 시각
}

// 행사·설정에서 격자가 쓰는 필드만. 콘솔 타입(AdminEvent·AdminEventSettings)과 백엔드 원응답
// (EventOut·EventSettingsOut) 둘 다 이 형상을 만족한다 — 시각은 "HH:MM"·"HH:MM:SS" 어느 쪽이든 받는다.
export interface SlotGridEventInput {
  exhibition_start?: string | null
  exhibition_end?: string | null
}

export interface SlotGridSettingsInput {
  operating_start: string
  operating_end: string
  lunch_start?: string | null
  lunch_end?: string | null
  slot_minutes: number
  slot_gap_minutes?: number | null
}

const hhmm = (value: string): string => value.slice(0, 5)

// 격자를 만들 수 없으면(행사·설정 조회 실패, 전시 기간 미정, 잘못된 운영시간) null —
// 화면은 지어낸 격자를 그리지 않고 "만들 수 없다"고 안내한다.
export function buildUnavailableSlotGrid(
  event: SlotGridEventInput | null | undefined,
  settings: SlotGridSettingsInput | null | undefined,
): UnavailableSlotGrid | null {
  if (!event || !settings) return null
  if (!event.exhibition_start || !event.exhibition_end) return null
  const dateIds = eventDateIds({
    exhibition_start: event.exhibition_start,
    exhibition_end: event.exhibition_end,
  })
  // 점심 미설정(null)은 백엔드 _assignment_settings_out과 같은 "00:00" 폴백(빈 구간) —
  // 아무 칸도 걸러내지 않는다.
  const times = slotGridTimes({
    startTime: hhmm(settings.operating_start),
    endTime: hhmm(settings.operating_end),
    lunchStart: hhmm(settings.lunch_start ?? "00:00"),
    lunchEnd: hhmm(settings.lunch_end ?? "00:00"),
    slotMinutes: settings.slot_minutes,
    slotGapMinutes: settings.slot_gap_minutes ?? 0,
  })
  if (dateIds.length === 0 || times.length === 0) return null
  return { dateIds, times }
}

// 칸 하나를 켜거나 끈 **전체 목록** — 저장은 부분 토글이 아니라 전체 치환(PATCH .../unavailable-slots)이라
// 호출부는 이 결과를 통째로 보낸다. 정렬해 두어 같은 집합이 늘 같은 순서로 저장된다.
export function toggleUnavailableSlot(slots: readonly string[], slot: string): string[] {
  return slots.includes(slot) ? slots.filter((s) => s !== slot) : [...slots, slot].sort()
}
