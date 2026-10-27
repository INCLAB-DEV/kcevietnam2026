// 행사 전시기간(YYYY-MM-DD 시작·종료) → 미팅 타임라인 날짜 탭(EventDate[]).
//
// 왜 필요한가: 날짜 탭을 상수로 박아두면 행사일이 바뀌는 순간 그날 잡힌 실 미팅이 탭에서 조용히
// 사라진다(buildTimeline이 eventDates에 없는 날짜의 미팅을 버린다). 그래서 실 세션에서는 백엔드가
// 준 행사 기간(/api/me의 exhibition_start/end)으로 탭을 만든다.
//
// 날짜 계산은 UTC 기준으로 한다 — 입력이 이미 행사 현지 달력의 YYYY-MM-DD라, 실행 환경 타임존에
// 따라 하루가 밀리지 않게 하려면 UTC 산술이 맞다.

import type { EventDate } from "./timeline"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"
import { isHHMM } from "@/lib/schedule/slot-grid"

// 요일 라벨은 요일 문자열 표를 두지 않고 Intl로 만든다(ko="화", en="Tue"). 입력이 UTC 자정이라
// 타임존도 UTC로 고정해야 실행 환경에 따라 하루 밀리지 않는다.
function weekdayFormatter(locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ko-KR", {
    weekday: "short",
    timeZone: "UTC",
  })
}

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
 * `grid` 는 그 행사의 격자 모양(운영시간·점심·칸 길이·칸 사이 텀)이다. 함께 실어 보내지 않으면
 * `timeline.ts` 가 기본값 09:00~18:00 / 30분 / 텀0 으로 행을 끊어서, 40분/텀5분 행사에서는
 * 10:45 미팅이 10:30 행에 그려지고(mt003gap0001), 10:00 시작 행사에서는 참가자 격자(09:00,09:45…)와
 * 백엔드 격자(10:00,10:45…)가 **공유하는 시각이 하나도 없어진다**. 값이 없거나 엉터리면 **필드
 * 자체를 생략**한다 — 지어낸 기본값을 넣어 호출부가 폴백을 고를 기회를 빼앗지 않는다(이 모듈의
 * "가짜 값을 만들지 않는다" 원칙과 같다).
 *
 * `locale` 은 `weekday` 필드의 언어다. 참가자 타임라인은 이 필드를 쓰지 않고 날짜(id)에서 요일을
 * 다시 파생하지만(`timeline.ts` weekdayLabel), 이 값을 그대로 그리는 호출부가 생겨도 로케일이
 * 어긋나지 않게 요청 로케일을 받는다.
 */
export function buildEventDates(
  start: string | null | undefined,
  end: string | null | undefined,
  grid?: {
    slotMinutes?: number | null
    slotGapMinutes?: number | null
    operatingStart?: string | null
    operatingEnd?: string | null
    lunchStart?: string | null
    lunchEnd?: string | null
  },
  locale: Locale = DEFAULT_LOCALE,
): EventDate[] | null {
  if (!start || !end) return null
  const from = parseUtc(start)
  const to = parseUtc(end)
  if (!from || !to || to < from) return null

  const shape: Partial<
    Pick<
      EventDate,
      "slotMinutes" | "slotGapMinutes" | "operatingStart" | "operatingEnd" | "lunchStart" | "lunchEnd"
    >
  > = {}
  if (typeof grid?.slotMinutes === "number" && grid.slotMinutes > 0) {
    shape.slotMinutes = grid.slotMinutes
  }
  if (typeof grid?.slotGapMinutes === "number" && grid.slotGapMinutes >= 0) {
    shape.slotGapMinutes = grid.slotGapMinutes
  }
  if (isHHMM(grid?.operatingStart)) shape.operatingStart = grid.operatingStart
  if (isHHMM(grid?.operatingEnd)) shape.operatingEnd = grid.operatingEnd
  // 점심은 둘 다 유효할 때만 — 한쪽만 실어 보내면 구간을 지어내는 꼴이다(없는 점심을 만들지 않는다).
  if (isHHMM(grid?.lunchStart) && isHHMM(grid?.lunchEnd)) {
    shape.lunchStart = grid.lunchStart
    shape.lunchEnd = grid.lunchEnd
  }

  const weekday = weekdayFormatter(locale)
  const dates: EventDate[] = []
  for (let cursor = from; cursor <= to && dates.length < MAX_DAYS; ) {
    dates.push({
      id: toId(cursor),
      label: `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`,
      weekday: weekday.format(cursor),
      ...shape,
    })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return dates.length > 0 ? dates : null
}
