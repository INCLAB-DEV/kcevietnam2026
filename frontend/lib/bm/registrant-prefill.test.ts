import { describe, expect, it } from "vitest"
import { buildRegistrantPrefill, type RegistrantInfo } from "./registrant-prefill"
import type { ExhibitorProfileDraft } from "./types"

// 전부 가상값(개인정보 아님).
const INFO: RegistrantInfo = {
  businessRegNo: "000-00-00000",
  organizationNameKo: "가상콘텐츠",
  organizationNameEn: "Virtual Content",
  boothType: "독립부스",
  boothCount: 2,
  representativeNameKo: "홍길동",
  mainTel: "02-0000-0000",
  addressKo: "서울특별시 강남구 테헤란로 123",
  businessType: "제조업",
  businessItem: "콘텐츠 제작",
  contactNameKo: "김담당",
  contactTitle: "차장",
  contactEmail: "manager@example.com",
  contactPhone: "010-0000-0000",
}

describe("buildRegistrantPrefill — 빈 칸만 채운다(기본정보=로스터 컬럼)", () => {
  it("빈 드래프트에 기본정보 스칼라 + 담당자 1명을 채우고 출처 키를 돌려준다", () => {
    const { patch, sources } = buildRegistrantPrefill({}, INFO)
    expect(patch.organizationNameKo).toBe("가상콘텐츠")
    expect(patch.boothCount).toBe(2)
    expect(patch.representativeNameKo).toBe("홍길동")
    expect(patch.businessType).toBe("제조업")
    expect(patch.attendees).toEqual([
      {
        firstNameKo: "김담당",
        firstNameEn: undefined,
        titleKo: "차장",
        email: "manager@example.com",
        mobile: "010-0000-0000",
      },
    ])
    expect(sources).toContain("organizationNameKo")
    expect(sources).toContain("boothCount")
    expect(sources).toContain("attendees")
  })

  it("이미 입력된 기업명은 덮어쓰지 않는다(이어쓰기 보존)", () => {
    const draft: ExhibitorProfileDraft = { organizationNameKo: "직접입력값" }
    const { patch, sources } = buildRegistrantPrefill(draft, INFO)
    expect(patch.organizationNameKo).toBeUndefined()
    expect(sources).not.toContain("organizationNameKo")
    // 비어 있던 다른 필드는 채워진다.
    expect(patch.representativeNameKo).toBe("홍길동")
  })

  it("이미 담당자가 있으면 새 담당자를 추가하지 않는다", () => {
    const draft: ExhibitorProfileDraft = { attendees: [{ email: "old@example.com" }] }
    const { patch, sources } = buildRegistrantPrefill(draft, INFO)
    expect(patch.attendees).toBeUndefined()
    expect(sources).not.toContain("attendees")
  })

  it("등록 정보가 비면 아무것도 채우지 않는다", () => {
    const { patch, sources } = buildRegistrantPrefill({}, {})
    expect(patch).toEqual({})
    expect(sources).toEqual([])
  })
})
