import { describe, it, expect } from "vitest"
import { createForcedMeeting, statusFromAcceptance } from "./forced-assignment"
import type { Organization } from "@/lib/types"

const exhibitor: Organization = { id: "e1", name: "참가사1", role: "exhibitor", keywords: [] }
const hostedBuyer: Organization = { id: "bh", name: "초청바이어", role: "buyer", keywords: [], buyerType: "hosted" }
const generalBuyer: Organization = { id: "bp", name: "사전바이어", role: "buyer", keywords: [], buyerType: "pre_registered" }

describe("forced-assignment (F-OP-005 / ADR-0005)", () => {
  it("초청 바이어가 받는 Forced → accepted 즉시 확정", () => {
    const m = createForcedMeeting(hostedBuyer, exhibitor, "s1", "m1")
    expect(m.status).toBe("accepted")
    expect(m.matchingType).toBe("forced")
    expect(m.buyerId).toBe("bh")
    expect(m.exhibitorId).toBe("e1")
  })

  // QA B3(2026-09-15) — 운영자가 직접 배정하면 받는 쪽이 누구든 바로 확정이다. 백엔드
  // acceptance_rule.resolve_entry_state가 FORCED를 최우선 분기해 ACCEPTED를 주므로 FE 낙관적
  // 표시도 같은 값이어야 한다(예전엔 여기서 proposed를 그려 "수락대기"로 보였다가 새로고침하면
  // "확정"으로 바뀌었다).
  it("일반 바이어가 받는 Forced도 accepted — FORCED 채널은 바이어 유형을 보지 않는다", () => {
    expect(createForcedMeeting(generalBuyer, exhibitor, "s1", "m2").status).toBe("accepted")
    expect(createForcedMeeting(generalBuyer, exhibitor, "s2", "m3").status).toBe("accepted")
  })

  it("durationMinutes를 주면 그대로 싣고, 안 주면 필드가 없다(=슬롯 한 칸)", () => {
    expect(createForcedMeeting(hostedBuyer, exhibitor, "s1", "m6", 60).durationMinutes).toBe(60)
    expect(createForcedMeeting(hostedBuyer, exhibitor, "s1", "m7").durationMinutes).toBeUndefined()
  })

  it("provenance는 항상 'forced' — 수락 규칙과 독립 축(ADR-0005 D6)", () => {
    expect(createForcedMeeting(hostedBuyer, exhibitor, "s1", "m4").matchingType).toBe("forced")
    expect(createForcedMeeting(generalBuyer, exhibitor, "s1", "m5").matchingType).toBe("forced")
  })

  it("역할이 어긋나면 거부 — 매칭은 바이어↔참가사 쌍만 유효", () => {
    expect(() => createForcedMeeting(exhibitor as Organization, exhibitor, "s1", "x")).toThrow()
    expect(() => createForcedMeeting(hostedBuyer, hostedBuyer as Organization, "s1", "x")).toThrow()
  })

  it("statusFromAcceptance: 초청=accepted / 그 외=proposed", () => {
    expect(statusFromAcceptance({ buyerType: "hosted" })).toBe("accepted")
    expect(statusFromAcceptance({ buyerType: "on_site" })).toBe("proposed")
  })
})
