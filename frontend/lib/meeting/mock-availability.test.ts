import { describe, it, expect } from "vitest"
import { buildMeetingAvailability } from "./mock-availability"
import type { Organization } from "@/lib/types"

function org(partial: Partial<Organization>): Organization {
  return { id: "x", name: "테스트", role: "exhibitor", keywords: [], ...partial }
}

// 진입 상태 규칙(ADR-0005)은 실연동 시 backend가 소유한다. 목업 단계의 스탠드인인 이 seam 어댑터가
// provenance와 무관하게 "받는 쪽 유형"만으로 acceptanceMode를 내려주는지 검증한다(F-MT-001 D1).
describe("buildMeetingAvailability.acceptanceMode (ADR-0005 seam 스탠드인)", () => {
  it("초청 바이어(hosted)가 받으면 immediate(즉시 확정)", () => {
    expect(buildMeetingAvailability(org({ role: "buyer", buyerType: "hosted" })).acceptanceMode).toBe(
      "immediate"
    )
  })

  it("일반 바이어(사전등록·현장)가 받으면 pending(수락 대기)", () => {
    expect(buildMeetingAvailability(org({ role: "buyer", buyerType: "pre_registered" })).acceptanceMode).toBe(
      "pending"
    )
    expect(buildMeetingAvailability(org({ role: "buyer", buyerType: "on_site" })).acceptanceMode).toBe(
      "pending"
    )
  })

  it("Exhibitor가 받으면(Open 채널) pending", () => {
    expect(buildMeetingAvailability(org({ role: "exhibitor" })).acceptanceMode).toBe("pending")
  })

  it("buyerType이 없는 바이어는 pending으로 안전하게 떨어진다", () => {
    expect(buildMeetingAvailability(org({ role: "buyer" })).acceptanceMode).toBe("pending")
  })
})

// 장소 목록(F-MT-001)은 하드코딩이 아니라 행사 설정(lib/event/event-settings.ts)의 venueTypes로
// 걸러진다. 베트남 전시 mock 설정은 부스뿐이라 매칭존 테이블·비즈니스 룸은 내려가지 않는다.
describe("buildMeetingAvailability.venues (행사 설정 venueTypes 필터)", () => {
  it("mock 행사 설정(부스만)에서는 장소가 상대방 부스 하나뿐이다", () => {
    const { venues } = buildMeetingAvailability(org({ role: "exhibitor" }))
    expect(venues).toHaveLength(1)
    expect(venues[0].kind).toBe("booth")
  })
})
