import { describe, expect, it } from "vitest"
import { eventDateIds, eventLabel, formatEventDate, resolveSelectedEvent } from "./events"
import { KADEX_EVENT_ID, MOCK_EVENTS, VIETNAM_EVENT_ID } from "./admin-mock"

describe("행사 선택(멀티 행사 스코프)", () => {
  it("쿠키의 행사 id로 선택한다", () => {
    expect(resolveSelectedEvent(MOCK_EVENTS, VIETNAM_EVENT_ID)?.id).toBe(VIETNAM_EVENT_ID)
  })

  it("쿠키가 없으면 첫 행사로 폴백한다", () => {
    expect(resolveSelectedEvent(MOCK_EVENTS, null)?.id).toBe(KADEX_EVENT_ID)
    expect(resolveSelectedEvent(MOCK_EVENTS, undefined)?.id).toBe(KADEX_EVENT_ID)
    expect(resolveSelectedEvent(MOCK_EVENTS, "")?.id).toBe(KADEX_EVENT_ID)
  })

  it("알 수 없는 id도 첫 행사로 폴백한다 — 콘솔이 빈 화면이 되지 않게", () => {
    expect(resolveSelectedEvent(MOCK_EVENTS, "evt-deleted")?.id).toBe(KADEX_EVENT_ID)
  })

  it("행사가 하나도 없으면 null", () => {
    expect(resolveSelectedEvent([], KADEX_EVENT_ID)).toBeNull()
  })

  it("목업에는 정책이 서로 다른 행사가 2개 이상 있다 (전환 시연용)", () => {
    expect(MOCK_EVENTS.length).toBeGreaterThanOrEqual(2)
    expect(eventLabel(MOCK_EVENTS[0])).toBe(MOCK_EVENTS[0].name)
  })
})

describe("전시 기간 → 날짜 목록", () => {
  it("양끝을 포함해 편다", () => {
    expect(eventDateIds({ exhibition_start: "2026-09-16", exhibition_end: "2026-09-18" })).toEqual([
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ])
  })

  it("하루짜리 행사도 1일로 편다", () => {
    expect(eventDateIds({ exhibition_start: "2026-09-16", exhibition_end: "2026-09-16" })).toEqual(["2026-09-16"])
  })

  it("월을 넘어가도 이어진다", () => {
    expect(eventDateIds({ exhibition_start: "2026-11-30", exhibition_end: "2026-12-02" })).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ])
  })

  it("역전·무효 기간은 빈 목록", () => {
    expect(eventDateIds({ exhibition_start: "2026-09-18", exhibition_end: "2026-09-16" })).toEqual([])
    expect(eventDateIds({ exhibition_start: "bad", exhibition_end: "2026-09-16" })).toEqual([])
  })
})

describe("날짜 라벨", () => {
  it("월/일 (요일) 형태", () => {
    expect(formatEventDate("2026-09-16")).toBe("9/16 (수)")
  })

  it("파싱 불가한 값은 그대로 돌려준다", () => {
    expect(formatEventDate("bad")).toBe("bad")
  })
})
