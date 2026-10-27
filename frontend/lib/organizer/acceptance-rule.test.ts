import { describe, it, expect } from "vitest"
import { resolveAcceptance, canForceImmediate, acceptancePreview } from "./acceptance-rule"

// ADR-0005 수락 규칙의 외부 동작 검증 — 초청 바이어만 즉시 확정, 일반(사전등록·현장)은 수락대기.
describe("acceptance-rule (ADR-0005 받는 쪽 유형 → 진입 상태)", () => {
  it("초청(hosted) 바이어 → immediate 즉시 확정", () => {
    expect(resolveAcceptance({ buyerType: "hosted" })).toBe("immediate")
    expect(canForceImmediate({ buyerType: "hosted" })).toBe(true)
  })

  it("사전등록 바이어 → pending 수락대기", () => {
    expect(resolveAcceptance({ buyerType: "pre_registered" })).toBe("pending")
    expect(canForceImmediate({ buyerType: "pre_registered" })).toBe(false)
  })

  it("현장 바이어 → pending 수락대기", () => {
    expect(resolveAcceptance({ buyerType: "on_site" })).toBe("pending")
    expect(canForceImmediate({ buyerType: "on_site" })).toBe(false)
  })

  it("유형 미상 → pending(안전한 기본값: 수락대기)", () => {
    expect(resolveAcceptance({})).toBe("pending")
    expect(canForceImmediate({})).toBe(false)
  })

  it("미리보기 카피는 모드별로 라벨이 갈린다", () => {
    expect(acceptancePreview({ buyerType: "hosted" }).label).toBe("즉시 확정")
    expect(acceptancePreview({ buyerType: "pre_registered" }).label).toBe("수락대기")
  })
})
