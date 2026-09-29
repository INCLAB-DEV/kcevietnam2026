import { describe, it, expect } from "vitest"
import {
  canSubmitStep1,
  isNoshow,
  normalizeStep1,
  step2Available,
} from "./review-step"
import type { Step1Input } from "./types"

const proceeded: Step1Input = {
  proceeded: "proceeded",
  satisfaction: 5,
  followUpIntent: "yes",
}

describe("review-step", () => {
  it("noshow detection", () => {
    expect(isNoshow("proceeded")).toBe(false)
    expect(isNoshow("counterpart_noshow")).toBe(true)
    expect(isNoshow("self_noshow")).toBe(true)
  })

  it("step2 only available when proceeded", () => {
    expect(step2Available("proceeded")).toBe(true)
    expect(step2Available("counterpart_noshow")).toBe(false)
  })

  it("noshow normalization clears followups", () => {
    const n = normalizeStep1({ ...proceeded, proceeded: "counterpart_noshow" })
    expect(n.satisfaction).toBeNull()
    expect(n.followUpIntent).toBeNull()
  })

  it("proceeded keeps values, clamps satisfaction", () => {
    expect(normalizeStep1(proceeded).satisfaction).toBe(5)
    expect(normalizeStep1({ ...proceeded, satisfaction: 9 }).satisfaction).toBeNull()
  })

  it("canSubmitStep1: noshow always ok, proceeded needs satisfaction+intent", () => {
    expect(canSubmitStep1({ ...proceeded, proceeded: "counterpart_noshow" })).toBe(true)
    expect(canSubmitStep1(proceeded)).toBe(true)
    expect(canSubmitStep1({ ...proceeded, satisfaction: null })).toBe(false)
    expect(canSubmitStep1({ ...proceeded, followUpIntent: null })).toBe(false)
  })
})
