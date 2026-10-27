import { describe, it, expect } from "vitest"
import { saturationRunStatus, type SaturationRun } from "./saturation-status"

function run(over: Partial<SaturationRun>): SaturationRun {
  return { runNumber: 1, status: "confirmed", createdAt: "2026-09-11T10:00:00+09:00", minGuaranteedSlots: 10, ...over }
}

describe("saturationRunStatus", () => {
  it("미실행(0회차)이면 hasRun=false, 검토대기 아님", () => {
    expect(saturationRunStatus([])).toMatchObject({ hasRun: false, latestRunNumber: null, reviewPending: false, confirmedRuns: 0 })
  })

  it("최근 회차는 run_number 최대로 정한다(입력 순서 무관)", () => {
    const status = saturationRunStatus([
      run({ runNumber: 2, status: "confirmed", createdAt: "2026-09-12T09:00:00+09:00" }),
      run({ runNumber: 1, status: "confirmed" }),
      run({ runNumber: 3, status: "draft", createdAt: "2026-09-13T15:00:00+09:00", minGuaranteedSlots: 12 }),
    ])
    expect(status.latestRunNumber).toBe(3)
    expect(status.latestRunAt).toBe("2026-09-13T15:00:00+09:00")
    expect(status.latestMinGuaranteedSlots).toBe(12)
  })

  it("최근 회차가 draft면 검토 대기로 표시한다", () => {
    expect(saturationRunStatus([run({ runNumber: 1, status: "draft" })]).reviewPending).toBe(true)
  })

  it("최근 회차가 confirmed면 검토 대기 아님", () => {
    expect(saturationRunStatus([run({ runNumber: 1, status: "confirmed" })]).reviewPending).toBe(false)
  })

  it("confirmedRuns는 확정된 회차만 센다", () => {
    const status = saturationRunStatus([
      run({ runNumber: 1, status: "confirmed" }),
      run({ runNumber: 2, status: "discarded" }),
      run({ runNumber: 3, status: "confirmed" }),
      run({ runNumber: 4, status: "draft" }),
    ])
    expect(status.confirmedRuns).toBe(2)
    expect(status.reviewPending).toBe(true) // 최근(4회차)은 draft
  })
})
