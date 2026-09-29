import { describe, expect, it } from "vitest"
import { localIsoWithOffset, offsetAt, zonedParts } from "./timezone"

describe("zonedParts", () => {
  // 핵심 시나리오(작업 지시서): DB UTC 2026-10-21T04:30Z + event.timezone=Asia/Ho_Chi_Minh
  // → 화면 표기 11:30.
  it("converts a UTC instant to the event-local wall clock (ICT)", () => {
    expect(zonedParts("2026-10-21T04:30:00Z", "Asia/Ho_Chi_Minh")).toEqual({
      date: "2026-10-21",
      time: "11:30",
    })
  })

  it("converts the same instant to KST for comparison", () => {
    expect(zonedParts("2026-10-21T04:30:00Z", "Asia/Seoul")).toEqual({
      date: "2026-10-21",
      time: "13:30",
    })
  })

  // 참가자 미팅 API는 UTC가 아니라 이미 행사 로컬 오프셋이 실린 ISO를 준다(backend
  // app.meetings.service._in_event_zone) — 입력 오프셋과 무관하게 같은 절대시각이면 같은 결과.
  it("gives the same result regardless of the input's own offset (same instant)", () => {
    const fromUtc = zonedParts("2026-10-21T04:30:00Z", "Asia/Ho_Chi_Minh")
    const fromIctOffset = zonedParts("2026-10-21T11:30:00+07:00", "Asia/Ho_Chi_Minh")
    expect(fromIctOffset).toEqual(fromUtc)
  })

  it("returns empty strings for null/invalid input instead of throwing", () => {
    expect(zonedParts(null, "Asia/Seoul")).toEqual({ date: "", time: "" })
    expect(zonedParts("not-a-date", "Asia/Seoul")).toEqual({ date: "", time: "" })
  })
})

describe("offsetAt", () => {
  it("computes +07:00 for Asia/Ho_Chi_Minh", () => {
    expect(offsetAt("2026-10-21T11:30", "Asia/Ho_Chi_Minh")).toBe("+07:00")
  })

  it("computes +09:00 for Asia/Seoul", () => {
    expect(offsetAt("2026-10-21T13:30", "Asia/Seoul")).toBe("+09:00")
  })

  it("handles DST-observing zones correctly (not a fixed offset)", () => {
    expect(offsetAt("2026-01-21T07:30", "America/New_York")).toBe("-05:00")
    expect(offsetAt("2026-07-21T07:30", "America/New_York")).toBe("-04:00")
  })
})

describe("localIsoWithOffset round-trip", () => {
  it("produces an ISO string that parses back to the intended UTC instant", () => {
    const iso = localIsoWithOffset("2026-10-21T11:30", "Asia/Ho_Chi_Minh")
    expect(iso).toBe("2026-10-21T11:30:00+07:00")
    expect(new Date(iso).toISOString()).toBe("2026-10-21T04:30:00.000Z")
  })
})
