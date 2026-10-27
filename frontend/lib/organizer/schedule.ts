// schedule (F-OP-005 D9 / ADR-0006 / ADR-0014) — 운영 변수에서 슬롯 유니버스를 파생한다.
//
// 운영 시작/종료·슬롯 길이·점심 블록·최소 보장 슬롯 N은 하드코딩하지 않고 **행사 설정이 소유한다**.
// 진실원천은 백엔드다(ADR-0014 결정 5): 슬롯 길이 = `events.slot_minutes`, 운영시간·점심·보장 N =
// `event_schedule_settings`. 화면은 그 값을 GET /api/admin/events/{id}/assignment-schedule의
// `settings`로 받아(lib/organizer/http-assignment-schedule-client.ts toSettings) 그리드를 만든다.
//
// slotMinutes는 "칸 하나의 길이"(상담 길이)다. 칸을 전진시키는 간격(step)은 slotMinutes 하나가
// 아니라 stride = slotMinutes + slotGapMinutes다(Phase 1 계약서 §1 — 40분 상담 + 5분 텀처럼 길이와
// 텀이 갈리는 격자를 표현하기 위해서다). slotGapMinutes=0이면 stride===slotMinutes로 예전과 동일하다.
// 회의 1건의 길이는 미팅의 durationMinutes가 따로 들고 있고, spanOf가 그 길이를 stride 기준 칸
// 수로 환산한다 — 그 값이 배정 payload의 scheduled_end를 정한다.

import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import { sortSlotMeetings } from "@/lib/meeting/slot-pick"
import { slotGridTimes, toHHMM, toMinutes } from "@/lib/schedule/slot-grid"

export interface ScheduleSettings {
  startTime: string // "09:00" — event_schedule_settings.operating_start
  endTime: string // "18:00" — 배타적 끝(칸 끝까지 이 시각 안에 들어와야 한다)
  slotMinutes: number // 30 — 칸 하나의 길이(상담 길이) = events.slot_minutes(진실원천, ADR-0014 결정 5)
  // 칸 사이 텀(분) = event_schedule_settings.slot_gap_minutes(Phase 1, 기본 0). 칸을 전진시키는
  // 간격(stride)은 slotMinutes + slotGapMinutes다 — slotMinutes 자체는 더 이상 step이 아니다.
  slotGapMinutes: number
  lunchStart: string // "12:00" — 포함. 점심 미설정이면 lunchStart === lunchEnd("00:00")
  lunchEnd: string // "13:00" — 배타적
  minSlots: number // N(기본 10) — 포화배정 보장 슬롯 수 = min_guaranteed_slots
  // 연속 예약(멀티슬롯) 상한(분). 기본 90 — 기존 "3칸(=30분×3)" 상한과 동치라 하위호환된다.
  maxMeetingMinutes: number
}

// ⚠ 이 상수는 **폴백일 뿐이다** — 실세션 화면은 언제나 백엔드가 내려준 settings를 쓴다(위 모듈 주석).
// 목업 모드(dev 스위처, 세션 쿠키 없음)와 백엔드 설정을 못 읽은 경로에서만 쓰인다.
//
// 값은 백엔드 컬럼 server_default와 1:1로 맞춘다(backend/app/models.py):
//   events.slot_minutes = 30 · operating_start '09:00' · operating_end '18:00'
//   lunch_start/lunch_end = NULL · min_guaranteed_slots = 10
// 점심 NULL은 백엔드 응답에서 "00:00"/"00:00"으로 내려오고(app/admin/schemas.py
// AssignmentScheduleSettingsOut), 그때 slotTimes()의 [lunchStart, lunchEnd) 판정이 빈 구간이 되어
// 아무 칸도 건너뛰지 않는다 — 지어낸 점심시간을 만들지 않기 위해 폴백도 같은 표현을 쓴다.
//
// 예전 값(10:00~18:10 / 45분 / 점심 12:10~13:00)은 폐기된 REQ-05 PPT 스펙(상담 40분 + 텀 5분)이었다.
// 공식 스펙은 30분이고(F-OP-005 D9, ADR-0014), 그 45분 폴백이 배정 payload의 scheduled_end를
// "시작 + 45분"으로 만들어 10:00~10:30 배정이 10:00~10:45로 저장되던 QA 지적(B1/B2)의 원인이었다.
export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  startTime: "09:00",
  endTime: "18:00",
  slotMinutes: 30,
  slotGapMinutes: 0,
  lunchStart: "00:00",
  lunchEnd: "00:00",
  minSlots: 10,
  maxMeetingMinutes: 90,
}

export interface ScheduleSlot {
  id: string // `${dateId}T${time}` — 미팅·그리드 셀 키
  dateId: string // "2026-09-16"
  time: string // "09:00"
}

export function slotId(dateId: string, time: string): string {
  return `${dateId}T${time}`
}

// "HH:MM" + 분 → "HH:MM". 멀티슬롯 점유 칸 계산 등에 쓴다.
export function addMinutes(time: string, mins: number): string {
  return toHHMM(toMinutes(time) + mins)
}

// 소요시간 → 점유 슬롯 수. 칸은 stride(=slotMinutes+slotGapMinutes) 간격으로 이어지므로, n칸이
// 덮는 실제 시간은 (n-1)*stride + slotMinutes(마지막 칸의 텀은 포함하지 않는다)다. 그 값이
// durationMinutes 이상이 되는 최소 n을 구한다. slotGapMinutes=0이면 stride===slotMinutes라
// 예전 공식(ceil(duration/slotMinutes))과 정확히 같은 값을 낸다. 미지정·0 이하는 1칸(F-MY-001 D4).
export function spanOf(
  durationMinutes: number | undefined,
  slotMinutes: number,
  slotGapMinutes = 0,
): number {
  const stride = slotMinutes + slotGapMinutes
  if (slotMinutes <= 0 || stride <= 0) return 1
  const duration = durationMinutes ?? slotMinutes
  return Math.max(1, 1 + Math.ceil((duration - slotMinutes) / stride))
}

// 시작 슬롯 id + 소요시간 → 점유하는 모든 슬롯 id(시작 포함, 같은 날짜의 연속 칸). 빈슬롯 판정·렌더에 공용.
// 칸 사이는 stride만큼 떨어져 있다(5분 텀은 어느 쪽도 점유하지 않는다).
export function occupiedSlotIds(
  startSlotId: string,
  durationMinutes: number | undefined,
  slotMinutes: number,
  slotGapMinutes = 0,
): string[] {
  const sep = startSlotId.indexOf("T")
  if (sep < 0) return [startSlotId]
  const dateId = startSlotId.slice(0, sep)
  const time = startSlotId.slice(sep + 1)
  const span = spanOf(durationMinutes, slotMinutes, slotGapMinutes)
  const stride = slotMinutes + slotGapMinutes
  const ids: string[] = []
  for (let i = 0; i < span; i++) ids.push(slotId(dateId, addMinutes(time, i * stride)))
  return ids
}

// 하루의 슬롯 시각 목록 — 시작~끝 사이를 stride(=slotMinutes+slotGapMinutes) 간격으로 전진하고,
// 칸 자체(길이 slotMinutes)가 점심 블록[lunchStart, lunchEnd)과 겹치면 건너뛴다. 점심이 설정돼
// 있지 않으면(lunchStart === lunchEnd) 구간이 비어 아무 칸도 건너뛰지 않는다. 잘못된 설정
// (슬롯 길이 ≤ 0, 시작 ≥ 끝)은 빈 목록으로 폴백한다.
//
// ⚠ 규칙은 백엔드 app/matching/slot_grid.py._day_slots와 반드시 1:1이어야 한다(Phase 1 계약서 §1,
// H9 §2.5) — 루프 종료 조건은 **칸 끝**(cursor + slotMinutes <= closing) 기준이고, 전진은 stride
// 기준이다(길이와 간격이 갈리므로 step 하나로 겸할 수 없다). 점심 겹침도 칸의 시작이 아니라
// "칸 구간 전체의 겹침"으로 판정한다 — 끝이 점심 시작과 맞닿기만 하면(예: 11:30~12:10, 점심
// 12:10~13:00) 겹침이 아니라 유효 슬롯이다.
//
// 산술 자체는 lib/schedule/slot-grid.ts가 소유한다 — 참가자 미팅 타임라인도 같은 함수를 쓰게 해
// 두 화면의 시간축이 갈리지 않게 하려는 것이다(ScheduleSettings는 SlotGridShape의 상위집합이라
// 그대로 넘긴다). 이 래퍼는 기존 호출부(운영자 그리드·ops-metrics·이벤트 설정 콘솔)를 위한 이름이다.
export function slotTimes(settings: ScheduleSettings): string[] {
  return slotGridTimes(settings)
}

// 운영자 배정 그리드의 한 칸(기업 × 슬롯)에 걸린 미팅 **전부**를 표시 순서로 돌려준다(#10).
// 참가자 타임라인과 같은 규칙(lib/meeting/slot-pick)을 쓰므로 두 화면의 정렬·대표 선택이 갈리지
// 않는다 — 예전엔 각자 배열 순서에 우연히 기대다가 확정 자리가 "거절"로 표시되는 사고가 났다(#2).
// ⚠ list는 백엔드 계약대로 created_at **오름차순**(오래된 것 먼저)이라, slot-pick의 "배열 앞쪽=최신"
// 전제에 맞추려면 뒤집어서 넘겨야 한다. 그 뒤집기를 호출부마다 반복하지 않도록 여기서 한 번만 한다.
export function slotMeetingsFor<
  T extends { slotId: string; exhibitorId: string; buyerId: string; status: ScheduleStatus },
>(list: readonly T[], orgId: string, slot: string): T[] {
  const candidates = list.filter(
    (m) => m.slotId === slot && (m.exhibitorId === orgId || m.buyerId === orgId),
  )
  return sortSlotMeetings([...candidates].reverse())
}

// 행사 전체 날짜 × 하루 슬롯 = 슬롯 유니버스. 날짜는 ISO(YYYY-MM-DD) 문자열로 받는다.
export function buildSlotUniverse(dateIds: string[], settings: ScheduleSettings): ScheduleSlot[] {
  const times = slotTimes(settings)
  return dateIds.flatMap((dateId) =>
    times.map((time) => ({ id: slotId(dateId, time), dateId, time })),
  )
}
