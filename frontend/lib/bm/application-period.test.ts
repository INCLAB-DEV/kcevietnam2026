import { describe, expect, it } from "vitest"
import { isApplicationOpen, isApplicationClosed, resolveApplicationPeriod } from "./application-period"

const period = { opensAt: "2026-08-26", closesAt: "2026-09-11" }

describe("isApplicationOpen — 신청기간 동안만 수정 허용", () => {
  it("기간 내(경계 포함)면 열림", () => {
    expect(isApplicationOpen("2026-08-26", period)).toBe(true) // 시작일
    expect(isApplicationOpen("2026-09-01", period)).toBe(true)
    expect(isApplicationOpen("2026-09-11", period)).toBe(true) // 종료일
  })

  it("기간 전/후면 닫힘", () => {
    expect(isApplicationOpen("2026-08-25", period)).toBe(false)
    expect(isApplicationOpen("2026-09-12", period)).toBe(false)
  })
})

describe("isApplicationClosed — 종료일을 지나야 '종료'(경계일 당일은 아직 중)", () => {
  it("종료일 당일은 아직 종료가 아니다", () => {
    expect(isApplicationClosed("2026-09-11", period)).toBe(false)
  })
  it("종료일 다음날부터 종료", () => {
    expect(isApplicationClosed("2026-09-12", period)).toBe(true)
  })
  it("기간 전엔 종료 아님", () => {
    expect(isApplicationClosed("2026-08-01", period)).toBe(false)
  })
})

describe("resolveApplicationPeriod — dev ?period 오버라이드 → 실제 기간", () => {
  it("'open'은 항상 열림(now가 기간 안)", () => {
    const p = resolveApplicationPeriod({ override: "open", opensAt: "2026-08-26", closesAt: "2026-09-11" })
    expect(isApplicationOpen("2026-06-30", p)).toBe(true)
    expect(isApplicationClosed("2026-06-30", p)).toBe(false)
  })
  it("'closed'는 항상 종료(now가 기간 뒤)", () => {
    const p = resolveApplicationPeriod({ override: "closed", opensAt: "2026-08-26", closesAt: "2026-09-11" })
    expect(isApplicationOpen("2026-06-30", p)).toBe(false)
    expect(isApplicationClosed("2026-06-30", p)).toBe(true)
  })
  it("오버라이드 없으면 주입된 env 기간을 그대로 쓴다", () => {
    const p = resolveApplicationPeriod({ override: null, opensAt: "2026-08-26", closesAt: "2026-09-11" })
    expect(p).toEqual({ opensAt: "2026-08-26", closesAt: "2026-09-11" })
  })
  it("env 미설정이면 항상 열림으로 폴백(데모 기본)", () => {
    const p = resolveApplicationPeriod({})
    expect(isApplicationOpen("2026-06-30", p)).toBe(true)
  })
})
