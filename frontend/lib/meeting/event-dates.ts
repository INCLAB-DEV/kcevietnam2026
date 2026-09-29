// 행사 전시기간(YYYY-MM-DD 시작·종료) → 미팅 타임라인 날짜 탭(EventDate[]).
//
// 왜 필요한가: 날짜 탭을 상수로 박아두면 행사일이 바뀌는 순간 그날 잡힌 실 미팅이 탭에서 조용히
// 사라진다(buildTimeline이 eventDates에 없는 날짜의 미팅을 버린다). 그래서 실 세션에서는 백엔드가
// 준 행사 기간(/api/me의 exhibition_start/end)으로 탭을 만든다.
//
// 날짜 계산은 UTC 기준으로 한다 — 입력이 이미 행사 현지 달력의 YYYY-MM-DD라, 실행 환경 타임존에
// 따라 하루가 밀리지 않게 하려면 UTC 산술이 맞다.

import type { EventDate } from "./timeline"

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"] as const

// 안전장치 — 잘못된 기간(예: 종료가 시작보다 한참 뒤)이 들어와도 탭이 무한정 늘어나지 않게.
const MAX_DAYS = 31

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseUtc(date: string): Date | null {
  if (!ISO_DATE.test(date)) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toId(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * 시작·종료일(둘 다 포함)을 하루 단위로 펼쳐 날짜 탭을 만든다.
 * 입력이 비었거나 형식이 어긋나면 `null` — 호출부가 폴백을 고르게 한다(가짜 날짜를 만들지 않는다).
 *
 * `grid` 는 그 행사의 격자 모양(칸 길이·칸 사이 텀)이다. 함께 실어 보내지 않으면 `timeline.ts` 가
 * 기본값 30분/텀0 으로 행을 끊어서, 40분/텀5분 행사에서는 10:45 미팅이 10:30 행에 그려진다
 * (mt003gap0001). 값이 없거나 엉터리면 **필드 자체를 생략**한다 — 지어낸 기본값을 넣어 호출부가
 * 폴백을 고를 기회를 빼앗지 않는다(이 모듈의 "가짜 값을 만들지 않는다" 원칙과 같다).
 */
export function buildEventDates(
  start: string | null | undefined,
  end: string | null | undefined,
  grid?: { slotMinutes?: number | null; slotGapMinutes?: number | null },
): EventDate[] | null {
  if (!start || !end) return null
  const from = parseUtc(start)
  const to = parseUtc(end)
  if (!from || !to || to < from) return null

  const shape: Partial<Pick<EventDate, "slotMinutes" | "slotGapMinutes">> = {}
  if (typeof grid?.slotMinutes === "number" && grid.slotMinutes > 0) {
    shape.slotMinutes = grid.slotMinutes
  }
  if (typeof grid?.slotGapMinutes === "number" && grid.slotGapMinutes >= 0) {
    shape.slotGapMinutes = grid.slotGapMinutes
  }

  const dates: EventDate[] = []
  for (let cursor = from; cursor <= to && dates.length < MAX_DAYS; ) {
    dates.push({
      id: toId(cursor),
      label: `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`,
      weekday: WEEKDAYS_KO[cursor.getUTCDay()],
      ...shape,
    })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return dates.length > 0 ? dates : null
}
