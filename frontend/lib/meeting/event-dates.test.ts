import { describe, it, expect } from "vitest"
import { buildEventDates } from "./event-dates"

describe("buildEventDates", () => {
  it("시작~종료(양끝 포함)를 하루 단위 탭으로 펼친다", () => {
    expect(buildEventDates("2026-10-20", "2026-10-22")).toEqual([
      { id: "2026-10-20", label: "10/20", weekday: "화" },
      { id: "2026-10-21", label: "10/21", weekday: "수" },
      { id: "2026-10-22", label: "10/22", weekday: "목" },
    ])
  })

  it("하루짜리 행사도 탭 1개로 만든다", () => {
    expect(buildEventDates("2026-10-20", "2026-10-20")).toEqual([
      { id: "2026-10-20", label: "10/20", weekday: "화" },
    ])
  })

  it("월을 넘어가도 날짜가 이어진다", () => {
    const dates = buildEventDates("2026-10-30", "2026-11-01")
    expect(dates?.map((d) => d.id)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ])
    expect(dates?.[2].label).toBe("11/1")
  })

  // 가짜 날짜를 만들지 않는다 — 호출부가 폴백을 고를 수 있게 null을 준다.
  it("값이 없거나 형식이 틀리면 null", () => {
    expect(buildEventDates(null, "2026-10-22")).toBeNull()
    expect(buildEventDates("2026-10-20", undefined)).toBeNull()
    expect(buildEventDates("", "")).toBeNull()
    expect(buildEventDates("2026/10/20", "2026-10-22")).toBeNull()
  })

  it("종료가 시작보다 앞서면 null", () => {
    expect(buildEventDates("2026-10-22", "2026-10-20")).toBeNull()
  })

  it("기간이 비정상적으로 길어도 탭이 무한정 늘지 않는다", () => {
    const dates = buildEventDates("2026-01-01", "2027-01-01")
    expect(dates).not.toBeNull()
    expect(dates!.length).toBeLessThanOrEqual(31)
  })
})
