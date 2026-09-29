import { describe, expect, it } from "vitest"
import { toOrganization } from "./http-discover-client"
import type { Organization } from "@/lib/types"

// 실 백엔드(FastAPI GET /api/discover/organizations*)가 내려주는 확정 응답 페이로드로 매핑을
// 고정하는 계약 테스트 — 백엔드 응답 형상이 바뀌면 여기가 먼저 깨진다. lib/meeting/http-meetings-client.test.ts와
// 같은 패턴.

describe("DiscoverOrgOut → Organization", () => {
  it("exhibitor 응답을 매핑한다(부스 포함)", () => {
    const org = toOrganization({
      org_id: "org-exh-1",
      role: "exhibitor",
      name: "픽셀아츠 스튜디오",
      buyer_subtype: null,
      booth: { hall_no: "7", hall_name: "7홀", code: "A-12" },
      keywords: ["콘텐츠 제작", "캐릭터 라이센서"],
      exhibits: ["오리지널 애니메이션 시리즈 '스타빔레인저'"],
      description: "애니메이션 스튜디오",
      employee_range: "11-50",
      content_category: "animation_character",
    })
    expect(org).toEqual<Organization>({
      id: "org-exh-1",
      name: "픽셀아츠 스튜디오",
      role: "exhibitor",
      keywords: ["콘텐츠 제작", "캐릭터 라이센서"],
      booth: { hallNo: "7", hallName: "7홀", code: "A-12" },
      exhibits: ["오리지널 애니메이션 시리즈 '스타빔레인저'"],
      buyerType: undefined,
      description: "애니메이션 스튜디오",
      employees: "11-50",
      contentCategory: "animation_character",
    })
  })

  it("buyer 응답을 매핑한다(부스 없음, buyer_subtype 있음)", () => {
    const org = toOrganization({
      org_id: "org-buyer-1",
      role: "buyer",
      name: "Seoul Content Partners",
      buyer_subtype: "hosted",
      booth: null,
      keywords: ["게임 제작", "콘텐츠 제작"],
      exhibits: [],
      description: null,
      employee_range: null,
      content_category: null,
    })
    expect(org.booth).toBeUndefined()
    expect(org.buyerType).toBe("hosted")
    expect(org.description).toBeUndefined()
    expect(org.employees).toBeUndefined()
    expect(org.contentCategory).toBeUndefined()
  })

  // 2026-09-10 — 기업 상세 "직원 수"에 employee_range 원시 코드(예: "e_51_100")가 라벨 없이 그대로
  // 노출되던 버그 수정. 맵에 없는 코드(레거시·드리프트)는 원문 그대로 폴백한다(데이터 유실 방지).
  it("employee_range 코드를 라벨로 변환한다 — 맵에 없는 코드는 원문 유지", () => {
    const known = toOrganization({
      org_id: "org-exh-3",
      role: "exhibitor",
      name: "테스트기업2",
      buyer_subtype: null,
      booth: null,
      keywords: [],
      exhibits: [],
      description: null,
      employee_range: "e_51_100",
      content_category: null,
    })
    expect(known.employees).toBe("51~100명")

    const unknown = toOrganization({
      org_id: "org-exh-4",
      role: "exhibitor",
      name: "테스트기업3",
      buyer_subtype: null,
      booth: null,
      keywords: [],
      exhibits: [],
      description: null,
      employee_range: "legacy-11-50",
      content_category: null,
    })
    expect(unknown.employees).toBe("legacy-11-50")
  })

  it("백엔드 계약에 없는 필드(strength·achievements·founded·budgetRange·adoptionTimeline)는 매핑하지 않는다(undefined)", () => {
    const org = toOrganization({
      org_id: "org-exh-2",
      role: "exhibitor",
      name: "테스트기업",
      buyer_subtype: null,
      booth: null,
      keywords: [],
      exhibits: [],
      description: null,
      employee_range: null,
      content_category: null,
    })
    expect(org.strength).toBeUndefined()
    expect(org.achievements).toBeUndefined()
    expect(org.founded).toBeUndefined()
    expect(org.budgetRange).toBeUndefined()
    expect(org.adoptionTimeline).toBeUndefined()
  })
})
