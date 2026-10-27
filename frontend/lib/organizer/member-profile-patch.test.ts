import { describe, expect, it } from "vitest"

import type { OperatorOrgDetailApi } from "@/lib/operator/application-client"

import {
  ORGANIZER_PROXY_KEYS,
  hasOrganizerProxyField,
  organizerProxyConflicts,
  organizerProxyHasName,
  organizerProxyServerValues,
  toOrganizerProfilePatch,
  type OrganizerProxyValues,
} from "./member-profile-patch"

// 미신청 행의 간이 대리작성 — "값의 기준은 명단이 아니라 서버의 현재 프로필"을 고정한다.
// 미신청은 참가자가 신청서를 작성하는 중일 수 있는 상태라, 폼에 값이 있다고 전부 보내면 참가자의 초안을
// 명단 값으로 덮는다(리뷰 지적 A). 폼 초깃값은 서버 값뿐이다 — 명단 행의 값은 같은 컬럼에서 온 것이 아니라
// (회사 이메일 칸에 담당자 개인 이메일이 들어가는 식) 빈 칸을 채우는 데도 쓰지 않는다.

const blank = Object.fromEntries(ORGANIZER_PROXY_KEYS.map((key) => [key, ""])) as OrganizerProxyValues

// 참가자가 써 둔 초안이 있는 참가사.
const exhibitorDetail = {
  buyer_profile: null,
  exhibitor_profile: {
    org_event_role_id: "role-1",
    application_status: "registered",
    organization_name_ko: "픽셀아츠 스튜디오",
    organization_name_en: "PixelArts Studio",
    business_reg_no: "123-45-67890",
    website: "https://draft.example",
    company_email: "draft@pixelarts.example",
    main_tel: "02-111-1111",
    address_ko: "서울 마포구 초안로 1",
    content_category: "broadcasting",
    // 폼에 없는 칸 — 어떤 경우에도 본문에 실리면 안 된다.
    intro_ko: "참가자가 쓴 소개",
    products: [{ name_ko: "참가자가 넣은 제품" }],
    attendees: [{ first_name_ko: "민수", email: "minsu@pixelarts.example" }],
  },
} as unknown as Pick<OperatorOrgDetailApi, "buyer_profile" | "exhibitor_profile">

const buyerDetail = {
  exhibitor_profile: null,
  buyer_profile: {
    org_event_role_id: "role-2",
    application_status: "registered",
    organization_name_ko: null,
    organization_name_en: "Hanoi Media",
    business_reg_no: null,
    website: "https://hanoimedia.example",
    contact_name_ko: "응우옌 반 안",
    contact_email: "an@hanoimedia.example",
    tel: null,
    address1: null,
    org_types: ["media", "private_commercial"],
  },
} as unknown as Pick<OperatorOrgDetailApi, "buyer_profile" | "exhibitor_profile">

describe("서버 프로필 → 폼 칸 값", () => {
  it("참가사: 역할에 맞는 프로필의 대응 필드를 읽는다(담당자 칸은 없다)", () => {
    expect(organizerProxyServerValues(exhibitorDetail, "exhibitor")).toEqual({
      name: "픽셀아츠 스튜디오",
      nameEn: "PixelArts Studio",
      businessRegNo: "123-45-67890",
      website: "https://draft.example",
      primaryContact: "",
      contactEmail: "draft@pixelarts.example",
      mainTel: "02-111-1111",
      address: "서울 마포구 초안로 1",
      contentCategory: "broadcasting",
    })
    expect(hasOrganizerProxyField("exhibitor", "primaryContact")).toBe(false)
    expect(hasOrganizerProxyField("exhibitor", "contentCategory")).toBe(true)
  })

  it("바이어: 신청자 성명·이메일·기관 전화·주소를 읽고, 없는 값은 빈 칸이다(카테고리 칸은 없다)", () => {
    expect(organizerProxyServerValues(buyerDetail, "buyer")).toEqual({
      name: "",
      nameEn: "Hanoi Media",
      businessRegNo: "",
      website: "https://hanoimedia.example",
      primaryContact: "응우옌 반 안",
      contactEmail: "an@hanoimedia.example",
      mainTel: "",
      address: "",
      contentCategory: "",
    })
    expect(hasOrganizerProxyField("buyer", "contentCategory")).toBe(false)
    expect(hasOrganizerProxyField("buyer", "primaryContact")).toBe(true)
  })

  it("프로필이 아직 없으면 전부 빈 칸이다", () => {
    expect(
      organizerProxyServerValues({ buyer_profile: null, exhibitor_profile: null }, "exhibitor"),
    ).toEqual(blank)
  })
})

describe("대리작성 본문 — 열 때 읽은 서버 값과 달라진 칸만", () => {
  it("폼 초깃값(= 서버 값)을 그대로 저장하면 본문이 비어 있다 — 상태만 전이한다", () => {
    const server = organizerProxyServerValues(exhibitorDetail, "exhibitor")
    expect(toOrganizerProfilePatch({ ...server }, server, "exhibitor")).toEqual({})
  })

  it("서버에 비어 있는 칸은 무수정 저장에서 본문에 없다 — 비어 있던 칸도 운영자가 입력해야만 실린다", () => {
    const server = organizerProxyServerValues(buyerDetail, "buyer")
    // 사업자등록번호·기관 전화·주소·국문 기업명이 서버에 없다 — 폼에서도 빈 칸이다.
    expect(toOrganizerProfilePatch({ ...server }, server, "buyer")).toEqual({})
    expect(
      toOrganizerProfilePatch({ ...server, mainTel: "+84-24-0000-0000" }, server, "buyer"),
    ).toEqual({ tel: "+84-24-0000-0000" })
  })

  it("운영자가 고친 칸은 보낸다(그 칸만)", () => {
    const server = organizerProxyServerValues(exhibitorDetail, "exhibitor")
    const form = {
      ...server,
      website: " https://operator.example ",
      nameEn: "PixelArts Studio Inc.",
    }
    expect(toOrganizerProfilePatch(form, server, "exhibitor")).toEqual({
      website: "https://operator.example",
      organization_name_en: "PixelArts Studio Inc.",
    })
  })

  it("비운 칸은 지움이 아니라 안 건드림이다 — 카테고리만 '미입력'으로 바꾸면 지운다", () => {
    const server = organizerProxyServerValues(exhibitorDetail, "exhibitor")
    const form = { ...server, website: "", address: "   ", contentCategory: "" }
    expect(toOrganizerProfilePatch(form, server, "exhibitor")).toEqual({ content_category: null })
  })

  it("폼에 없는 칸(소개·제품·담당자·바이어 구분)과 다른 역할의 칸은 어떤 경우에도 싣지 않는다", () => {
    const filled = Object.fromEntries(
      ORGANIZER_PROXY_KEYS.map((key) => [key, `${key}-값`]),
    ) as OrganizerProxyValues
    const exhibitor = toOrganizerProfilePatch(filled, blank, "exhibitor")
    const buyer = toOrganizerProfilePatch(filled, blank, "buyer")

    expect(Object.keys(exhibitor).sort()).toEqual(
      [
        "address_ko",
        "business_reg_no",
        "company_email",
        "content_category",
        "main_tel",
        "organization_name_en",
        "organization_name_ko",
        "website",
      ].sort(),
    )
    expect(Object.keys(buyer).sort()).toEqual(
      [
        "address1",
        "business_reg_no",
        "contact_email",
        "contact_name_ko",
        "organization_name_en",
        "organization_name_ko",
        "tel",
        "website",
      ].sort(),
    )
    for (const patch of [exhibitor, buyer]) {
      for (const key of ["intro_ko", "products", "attendees", "org_types", "booth_location"]) {
        expect(patch).not.toHaveProperty(key)
      }
    }
  })
})

describe("충돌 — 보내려는 칸이 다이얼로그를 연 뒤 서버에서 달라졌는가", () => {
  const server = organizerProxyServerValues(exhibitorDetail, "exhibitor")

  it("운영자가 고친 칸이 그 사이 서버에서도 바뀌었으면 충돌이다", () => {
    const patch = toOrganizerProfilePatch(
      { ...server, website: "https://operator.example" },
      server,
      "exhibitor",
    )
    const latest = { ...server, website: "https://participant-new.example" }
    expect(organizerProxyConflicts(patch, server, latest, "exhibitor")).toEqual(["website"])
  })

  it("운영자가 손대지 않은 칸이 서버에서 바뀐 것은 충돌이 아니다(그 칸은 보내지 않는다)", () => {
    const patch = toOrganizerProfilePatch(
      { ...server, website: "https://operator.example" },
      server,
      "exhibitor",
    )
    const latest = { ...server, mainTel: "02-222-2222", address: "참가자가 고친 주소" }
    expect(organizerProxyConflicts(patch, server, latest, "exhibitor")).toEqual([])
    expect(patch).toEqual({ website: "https://operator.example" })
  })

  it("서버가 그대로면 충돌이 없다", () => {
    const patch = toOrganizerProfilePatch({ ...server, address: "새 주소" }, server, "exhibitor")
    expect(organizerProxyConflicts(patch, server, { ...server }, "exhibitor")).toEqual([])
  })

  // 본문 조립은 빈 칸을 "안 건드림"으로 다루지만 충돌 비교는 값의 뜻으로 한다 — 참가자가 그 사이 **지운**
  // 칸에 운영자의 새 값을 보내면 지움이 되살아난다.
  it("운영자가 고친 칸을 참가자가 그 사이 지웠으면(서버 값이 비었으면) 충돌이다", () => {
    const patch = toOrganizerProfilePatch(
      { ...server, website: "https://operator.example", mainTel: "02-333-3333" },
      server,
      "exhibitor",
    )
    const latest = { ...server, website: "", mainTel: "" }
    expect(organizerProxyConflicts(patch, server, latest, "exhibitor").sort()).toEqual(
      ["mainTel", "website"].sort(),
    )
  })
})

// 대리작성은 저장과 함께 상태가 전이한다(master면 즉시 승인 → 매칭 대상). 이름 없는 기업이 승인되지 않게 한다.
describe("기업명이 하나라도 남는가", () => {
  const named = organizerProxyServerValues(exhibitorDetail, "exhibitor")
  const nameless = { ...blank, website: "https://draft.example" }

  it("서버에 이름이 없고 폼에도 입력이 없으면 false다", () => {
    expect(organizerProxyHasName({ ...nameless }, nameless)).toBe(false)
    expect(organizerProxyHasName({ ...nameless, name: "   " }, nameless)).toBe(false)
  })

  it("폼에 국문이나 영문 이름을 입력하면 true다", () => {
    expect(organizerProxyHasName({ ...nameless, name: "새 기업" }, nameless)).toBe(true)
    expect(organizerProxyHasName({ ...nameless, nameEn: "New Co." }, nameless)).toBe(true)
  })

  it("서버에 이름이 있으면 폼에서 칸을 비워도 true다(빈 칸은 안 건드림 — 서버 이름이 남는다)", () => {
    expect(organizerProxyHasName({ ...named, name: "", nameEn: "" }, named)).toBe(true)
    // 영문명만 있는 기업(국문명 없음)도 이름이 있는 것이다.
    const englishOnly = organizerProxyServerValues(buyerDetail, "buyer")
    expect(organizerProxyHasName({ ...englishOnly }, englishOnly)).toBe(true)
  })
})
