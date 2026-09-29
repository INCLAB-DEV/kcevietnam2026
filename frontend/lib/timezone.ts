// 행사 타임존(events.timezone, IANA 문자열) 표시·변환의 단일 지점 (H5/H9 근본원인 수정).
//
// Date의 로컬 게터(getHours/getMonth/getDate 등)는 **프로세스(서버) 또는 브라우저의 로컬 TZ**를
// 따른다 — 컨테이너는 보통 UTC, 로컬 macOS는 KST라 같은 미팅이 화면마다 다른 시각으로 보이던
// 근본 원인이었다(.e2e-artifacts/timezone-analysis.md §1). 이 파일 밖에서는 그 게터들을 쓰지
// 않는다 — ISO ↔ 행사 로컬 표시는 항상 아래 두 함수를 거친다.

export interface ZonedDateTime {
  date: string // "YYYY-MM-DD"
  time: string // "HH:MM" (24h)
}

// ISO(오프셋 무관 — UTC로 와도, 행사 로컬 오프셋이 이미 실려 와도 둘 다 정확하다) → timeZone
// 기준 날짜/시각. Intl이 절대시각을 그 zone으로 다시 투영하므로 입력 오프셋에 의존하지 않는다.
export function zonedParts(iso: string | null | undefined, timeZone: string): ZonedDateTime {
  if (!iso) return { date: "", time: "" }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: "", time: "" }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  // 일부 런타임은 hourCycle:"h23"이어도 자정을 "24"로 낼 수 있다(P0-2 경고, 분석문서 §4) — 보정.
  const hour = get("hour") === "24" ? "00" : get("hour")
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` }
}

// "YYYY-MM-DDTHH:MM"(timeZone 기준 벽시계) → 그 순간 그 zone의 UTC 오프셋 문자열("+07:00" 등).
// DST가 있는 zone도 정확하다(고정 상수로 두지 않는다) — **쓰기 경로**(슬롯키 → scheduled_start)
// 전용. 표준 트릭: 벽시계를 일단 UTC로 가정해 기준 순간을 만들고, 그 순간을 다시 timeZone으로
// 투영해 나온 값과의 차이가 곧 그 zone의 오프셋이다.
export function offsetAt(localIso: string, timeZone: string): string {
  const guess = new Date(`${localIso}:00Z`)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(guess)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0")
  const asIfLocal = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  )
  const offsetMinutes = Math.round((asIfLocal - guess.getTime()) / 60000)
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, "0")
  const mm = String(abs % 60).padStart(2, "0")
  return `${sign}${hh}:${mm}`
}

// "YYYY-MM-DDTHH:MM"(timeZone 벽시계) + 초 고정("00") → 그 zone에서 유효한 ISO8601(오프셋 포함).
export function localIsoWithOffset(localIso: string, timeZone: string): string {
  return `${localIso}:00${offsetAt(localIso, timeZone)}`
}
