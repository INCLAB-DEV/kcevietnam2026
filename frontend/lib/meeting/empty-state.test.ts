import { describe, it, expect } from "vitest"
import { resolveMeetingEmptyState } from "./empty-state"

describe("resolveMeetingEmptyState (F-MY-001 D13)", () => {
  it("참가사 → AI 추천 바이어 확인(DV-001)", () => {
    const s = resolveMeetingEmptyState("exhibitor")
    expect(s.primary.href).toBe("/discover")
    expect(s.primary.label).toContain("AI 추천")
    expect(s.secondary).toBeUndefined()
  })

  it("바이어 → 관심 기업 탐색(DV-001)", () => {
    const s = resolveMeetingEmptyState("buyer")
    expect(s.primary.href).toBe("/discover")
    expect(s.secondary).toBeUndefined()
  })
})
