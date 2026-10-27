// 슬롯 격자 산술 공유 커널 — "하루의 칸 시각 목록"을 만드는 **단일 규칙**.
//
// 왜 한 곳에 두나: 운영자 배정 그리드(lib/organizer/schedule.ts)와 참가자 미팅 타임라인
// (lib/meeting/timeline.ts)이 각자 격자를 만들면 두 화면의 시간축이 조용히 갈린다. 실제로
// 타임라인 쪽만 09:00~18:00 하드코딩으로 남아 있어서, 발주사 운영표(10:00~18:10 · 40분 상담 +
// 5분 텀 · 점심 12:10~13:00)로 넘어가면 참가자 격자(09:00,09:45,…)와 백엔드 격자
// (10:00,10:45,…)가 **공유하는 시각이 한 개도 없어진다**. 규칙을 복제하지 않기 위한 모듈이다.
//
// ⚠ 규칙은 백엔드 app/matching/slot_grid.py._day_slots와 반드시 1:1이어야 한다(Phase 1 계약서 §1):
//   · 칸 전진 = stride = slotMinutes + slotGapMinutes — 길이와 간격은 **다른 축**이라 step 하나로
//     겸할 수 없다(40분 상담인데 칸은 45분마다 시작한다).
//   · 종료 판정은 **칸 끝** 기준(cursor + slotMinutes <= endTime) — 시작 기준이면 종료를 넘겨 끝나는
//     칸이 살아남는다.
//   · 점심은 칸 시작이 아니라 **칸 구간 전체**의 겹침으로 판정한다 — 끝이 점심 시작과 맞닿기만 하면
//     겹침이 아니다(11:30~12:10 칸은 점심 12:10~13:00이어도 유효하다).

export interface SlotGridShape {
  startTime: string // "10:00" — 운영 시작(event_schedule_settings.operating_start)
  endTime: string // "18:10" — 배타적 끝(칸 끝까지 이 시각 안에 들어와야 한다)
  slotMinutes: number // 칸 하나의 길이(상담 길이) = events.slot_minutes(진실원천, ADR-0014 결정 5)
  slotGapMinutes: number // 칸 사이 텀 — 전진 간격(stride) = slotMinutes + 이 값. 0이면 간격 = 길이.
  lunchStart: string // "12:10" — 포함. 점심 미설정이면 lunchStart === lunchEnd("00:00")
  lunchEnd: string // "13:00" — 배타적
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

// "HH:MM"(24시간) 형식인가. 백엔드 롤아웃 중이라 운영시간 필드가 없거나 엉뚱한 값일 수 있어,
// 호출부가 "지어낸 기본값" 대신 폴백을 고를 수 있도록 검사만 제공한다.
export function isHHMM(value: unknown): value is string {
  return typeof value === "string" && HHMM.test(value)
}

// "HH:MM" → 분(자정 기준). 형식 검사는 하지 않는다(호출부가 isHHMM으로 거른다).
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

// 분(자정 기준) → "HH:MM".
export function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

// 하루의 칸 시각 목록. 잘못된 설정(슬롯 길이 ≤ 0, stride ≤ 0, 시작 ≥ 끝)은 빈 목록으로 폴백한다 —
// 지어낸 격자를 그리는 것보다 아무것도 안 그리는 쪽이 낫다(호출부가 빈 목록을 보고 판단한다).
export function slotGridTimes(shape: SlotGridShape): string[] {
  const start = toMinutes(shape.startTime)
  const end = toMinutes(shape.endTime)
  const lunchStart = toMinutes(shape.lunchStart)
  const lunchEnd = toMinutes(shape.lunchEnd)
  const length = shape.slotMinutes
  const stride = length + shape.slotGapMinutes
  const out: string[] = []
  if (length <= 0 || stride <= 0 || start >= end) return out
  for (let t = start; t + length <= end; t += stride) {
    if (t < lunchEnd && t + length > lunchStart) continue // 칸 구간 전체가 점심과 겹치면 제외
    out.push(toHHMM(t))
  }
  return out
}
