import { describe, expect, it } from "vitest"
import { hasOrganizerProfilePatch, toOrganizerProfilePatch } from "./member-profile-patch"

describe("toOrganizerProfilePatch — 자유 텍스트 A층 폼 → 신청서 patch(enum-guard)", () => {
  it("바이어는 안전한 필드를 buyer 스키마 키로 매핑한다", () => {
    const patch = toOrganizerProfilePatch(
      {
        businessRegNo: "123-45-67890",
        website: "https://buyer.example",
        primaryContact: "조현우",
        contactEmail: "cho@dapa.go.kr",
        mainTel: "02-000-0000",
        address: "서울시 종로구",
        language: "영어",
      },
      "buyer",
    )
    expect(patch).toEqual({
      business_reg_no: "123-45-67890",
      website: "https://buyer.example",
      tel: "02-000-0000",
      address1: "서울시 종로구",
      contact_name_ko: "조현우",
      contact_email: "cho@dapa.go.kr",
      contact_language: "영어",
    })
  })

  it("참가사는 안전한 필드를 exhibitor 스키마 키로 매핑한다(담당자/전화는 attendees 전체교체 위험이라 뺀다)", () => {
    const patch = toOrganizerProfilePatch(
      {
        businessRegNo: "123-45-67890",
        website: "https://ex.example",
        primaryContact: "신담당",
        contactEmail: "biz@ex.example",
        mainTel: "02-111-2222",
        address: "서울시 강남구",
      },
      "exhibitor",
    )
    expect(patch).toEqual({
      business_reg_no: "123-45-67890",
      website: "https://ex.example",
      main_tel: "02-111-2222",
      address_ko: "서울시 강남구",
      company_email: "biz@ex.example",
    })
    // 참가사 담당자(대표 개인 성명)는 전체교체 attendees 배열이라 이 경로에선 손대지 않는다.
    expect(patch.contact_name_ko).toBeUndefined()
  })

  it("빈 문자열·공백은 값을 지우는 게 아니라 키 자체를 생략한다", () => {
    const patch = toOrganizerProfilePatch({ website: "   ", contactEmail: "" }, "buyer")
    expect(patch).toEqual({})
  })

  it("매핑 대상 밖 필드(HS코드 등)는 애초에 입력받지 않는다 — 타입에 없다", () => {
    const patch = toOrganizerProfilePatch({ businessRegNo: "1" }, "exhibitor")
    expect(Object.keys(patch)).toEqual(["business_reg_no"])
  })
})

describe("hasOrganizerProfilePatch", () => {
  it("빈 객체는 false", () => {
    expect(hasOrganizerProfilePatch({})).toBe(false)
  })
  it("필드가 하나라도 있으면 true", () => {
    expect(hasOrganizerProfilePatch({ website: "x" })).toBe(true)
  })
})

it("참가사의 카테고리 저장·명시적 비우기를 보존하고 바이어에는 보내지 않는다", () => {
  expect(toOrganizerProfilePatch({ contentCategory: "broadcasting" }, "exhibitor")).toEqual({ content_category: "broadcasting" })
  expect(toOrganizerProfilePatch({ contentCategory: null }, "exhibitor")).toEqual({ content_category: null })
  expect(toOrganizerProfilePatch({ contentCategory: "broadcasting" }, "buyer")).toEqual({})
})
