import { describe, expect, test } from "vitest"
import {
  EMPTY_PROFILE_FORM,
  PROXY_BODY_FIELDS,
  proxyPatchConflicts,
  toFormState,
  toProxyProfilePatch,
  type ProfileFormState,
} from "./proxy-profile-form"
import type { OperatorOrgDetailApi } from "@/lib/operator/application-client"

// 대리작성 본문 조립 — "다이얼로그에 보이는 칸 중 운영자가 바꾼 칸만 보낸다"를 고정한다. 화면에 없는
// 칸의 옛 값을 다시 보내면 그 사이 바뀐 서버 값을 되돌리거나(부스·사업자등록번호), 다른 칸으로 옮겨
// 적는다(담당자 이름). 보이는 칸도 손대지 않았으면 보내지 않는다 — 미신청은 참가자가 작성 중일 수 있어,
// 옛 값을 되보내면 참가자가 방금 고친 값을 덮는다. 초깃값은 다이얼로그를 열 때 서버에서 읽은 상세로 만든다.

type Detail = Pick<OperatorOrgDetailApi, "buyer_profile" | "exhibitor_profile">

const PRODUCT = {
  name_ko: "지휘통제 시스템",
  name_en: "Command System",
  business_field: "content_production",
  category_ko: "구 카테고리",
  hs_code: "8517.62",
  hs_description: "통신기기",
  price_range: "krw_70_100m",
  spec: "주요 사양",
  spec_en: "Key specs",
}

// 서버가 돌려준 참가사 상세 — 다이얼로그에 없는 칸(담당자·부스·사업자등록번호 등)도 채워져 있다.
const exhibitorDetail = {
  buyer_profile: null,
  exhibitor_profile: {
    org_event_role_id: "role-1",
    application_status: "registered",
    organization_name_ko: "기업",
    business_reg_no: "123-45-67890",
    website: "https://old.example",
    representative_name_ko: "김대표",
    company_email: "old@corp.example",
    main_tel: "02-000-0000",
    address_ko: "서울",
    booth_location: "A-12",
    annual_sales_range: "krw_10_50",
    employee_range: "e_11_50",
    org_types: ["media"],
    exhibition_categories: ["content_production"],
    intro_ko: "소개",
    intro_en: "Intro",
    available_languages: ["en"],
    preferred_buyer_countries: ["vietnam"],
    preferred_buyer_types: ["media"],
    attendees: [{ first_name_ko: "민수", last_name_ko: "김", email: "minsu@corp.example" }],
    products: [PRODUCT],
  },
} as unknown as Detail

const buyerDetail = {
  exhibitor_profile: null,
  buyer_profile: {
    org_event_role_id: "role-2",
    application_status: "registered",
    organization_name_en: "Hanoi Media",
    website: "https://buyer-old.example",
    contact_name_ko: "민수 김",
    contact_language: "en",
    contact_interpreter_need: null,
    annual_sales_range: "usd_1m_5m",
    employee_range: "e_51_100",
    org_types: ["media", "private_commercial", "exhibition_agent"],
    interest_categories: ["animation_distribution"],
    company_intro_ko: "바이어 소개",
    company_intro_en: "Buyer intro",
  },
} as unknown as Detail

const stale = toFormState(exhibitorDetail, "exhibitor")
const empty: ProfileFormState = toFormState(null, "exhibitor")

describe("대리작성 폼 상태 — 서버 상세에서 만든다", () => {
  test("참가사: 다이얼로그 칸을 읽고, 제품은 백엔드 원본 행(숨은 칸 포함)을 그대로 싣는다", () => {
    expect(stale).toEqual({
      website: "https://old.example",
      annual_sales: "krw_10_50",
      employee_range: "e_11_50",
      categories: ["content_production"],
      company_intro_ko: "소개",
      company_intro_en: "Intro",
      contact_language: "",
      products: [PRODUCT],
      available_languages: ["en"],
      preferred_buyer_countries: ["vietnam"],
      preferred_buyer_types: ["media"],
    })
  })

  test("바이어: 역할에 맞는 프로필만 읽는다 — 참가사 전용 칸은 빈 채다", () => {
    expect(toFormState(buyerDetail, "buyer")).toEqual({
      ...EMPTY_PROFILE_FORM,
      website: "https://buyer-old.example",
      annual_sales: "usd_1m_5m",
      employee_range: "e_51_100",
      categories: ["animation_distribution"],
      company_intro_ko: "바이어 소개",
      company_intro_en: "Buyer intro",
      contact_language: "en",
    })
    // 행의 역할과 프로필이 어긋나면(역할 전환 직후) 다른 역할의 값으로 채우지 않는다.
    expect(toFormState(exhibitorDetail, "buyer")).toEqual(EMPTY_PROFILE_FORM)
  })

  test("프로필이 없으면(아직 읽지 못함·프로필 없음) 빈 폼이다", () => {
    expect(empty).toEqual(EMPTY_PROFILE_FORM)
    expect(toFormState({ buyer_profile: null, exhibitor_profile: null }, "exhibitor")).toEqual(
      EMPTY_PROFILE_FORM,
    )
  })

  test("다이얼로그에 없는 칸은 폼 상태에 들이지 않는다", () => {
    const form = stale as unknown as Record<string, unknown>
    for (const key of [
      "business_reg_no",
      "representative_name",
      "company_email",
      "main_tel",
      "address",
      "contact_name",
      "contact_email",
      "contact_phone",
      "org_type",
      "org_types",
      "interpreter_need",
      "booth_location",
      "attendees",
    ]) {
      expect(form).not.toHaveProperty(key)
    }
  })

  test("폼 상태는 서버 응답 객체와 배열을 공유하지 않는다(폼에서 고쳐도 읽은 값이 바뀌지 않는다)", () => {
    const form = toFormState(exhibitorDetail, "exhibitor")
    form.categories.push("game_production")
    form.products[0].name_ko = "바뀐 이름"
    expect(exhibitorDetail.exhibitor_profile?.exhibition_categories).toEqual(["content_production"])
    expect(exhibitorDetail.exhibitor_profile?.products?.[0].name_ko).toBe("지휘통제 시스템")
  })
})

describe("대리작성 본문 — 참가사", () => {
  test("손대지 않고 저장하면 아무것도 보내지 않는다(읽어 둔 값을 되보내지 않는다)", () => {
    // 다이얼로그는 초깃값을 그대로 든 채 저장한다 — 값이 같은 **다른 객체**여도 변경이 아니다.
    const form: ProfileFormState = JSON.parse(JSON.stringify(stale))

    expect(toProxyProfilePatch(form, "exhibitor", stale)).toEqual({})
  })

  test("바꾼 칸만 나간다 — 손대지 않은 칸과 다이얼로그에 없는 칸(담당자·부스 등)은 없다", () => {
    const form: ProfileFormState = {
      ...stale,
      website: " https://new.example ",
      company_intro_en: "New intro",
      employee_range: "e_101plus",
      preferred_buyer_countries: ["vietnam", "thailand"],
    }

    const patch = toProxyProfilePatch(form, "exhibitor", stale)

    expect(patch).toEqual({
      website: "https://new.example",
      intro_en: "New intro",
      employee_range: "e_101plus",
      preferred_buyer_countries: ["vietnam", "thailand"],
    })
  })

  test("모든 칸을 바꿔도 다이얼로그에 없는 칸은 나가지 않는다", () => {
    const form: ProfileFormState = {
      ...stale,
      website: "https://new.example",
      company_intro_ko: "새 소개",
      company_intro_en: "New intro",
      annual_sales: "krw_50plus",
      employee_range: "e_101plus",
      categories: ["game_production"],
      available_languages: ["en", "vi"],
      preferred_buyer_countries: ["thailand"],
      preferred_buyer_types: ["exhibition_agent"],
      products: [],
    }

    const patch = toProxyProfilePatch(form, "exhibitor", stale)

    expect(Object.keys(patch).sort()).toEqual(
      [
        "annual_sales_range",
        "available_languages",
        "employee_range",
        "exhibition_categories",
        "intro_en",
        "intro_ko",
        "preferred_buyer_countries",
        "preferred_buyer_types",
        "products",
        "website",
      ].sort(),
    )
    // 충돌 비교가 쓰는 표(본문 키 → 폼 칸)도 본문이 낼 수 있는 키와 정확히 같아야 한다 — 표에 없는 키는
    // 견줄 서버 값을 못 찾는다.
    expect(Object.keys(PROXY_BODY_FIELDS.exhibitor).sort()).toEqual(Object.keys(patch).sort())
    // 예전 결함: 담당자 이름을 성 칸에 옮겨 적고(이름 중복), 부스를 빈 값으로 덮어썼다.
    for (const key of [
      "attendees",
      "booth_location",
      "business_reg_no",
      "representative_name_ko",
      "company_email",
      "main_tel",
      "address_ko",
      "org_types",
    ]) {
      expect(patch).not.toHaveProperty(key)
    }
  })

  test("목록은 고른 집합이 달라졌을 때만 보낸다(껐다 켜서 순서만 바뀐 것은 변경이 아니다)", () => {
    const initial: ProfileFormState = {
      ...stale,
      categories: ["content_production", "game_production"],
    }
    const reordered = toProxyProfilePatch(
      { ...initial, categories: ["game_production", "content_production"] },
      "exhibitor",
      initial,
    )
    expect(reordered).not.toHaveProperty("exhibition_categories")

    const added = toProxyProfilePatch(
      { ...initial, categories: ["game_production", "content_production", "music_production"] },
      "exhibitor",
      initial,
    )
    expect(added).toEqual({
      exhibition_categories: ["game_production", "content_production", "music_production"],
    })
  })

  test("제품은 손대지 않으면 보내지 않고, 한 행이라도 고치면 목록 전체를 보낸다", () => {
    const second = { name_ko: "둘째 제품", name_en: "Second", business_field: null, hs_code: "", price_range: null, spec: "" }
    const initial: ProfileFormState = { ...stale, products: [...stale.products, second] }

    // 편집 다이얼로그를 열었다 그대로 닫으면 같은 값이 키 순서만 달라져 돌아올 수 있다 — 변경이 아니다.
    const reopened = {
      spec: second.spec,
      price_range: second.price_range,
      hs_code: second.hs_code,
      business_field: second.business_field,
      name_en: second.name_en,
      name_ko: second.name_ko,
    }
    const untouched = toProxyProfilePatch(
      { ...initial, products: [initial.products[0], reopened] },
      "exhibitor",
      initial,
    )
    expect(untouched).not.toHaveProperty("products")

    const edited = toProxyProfilePatch(
      { ...initial, products: [initial.products[0], { ...second, name_en: "Second (renamed)" }] },
      "exhibitor",
      initial,
    ) as { products: unknown[] }
    // 전체 교체라 고치지 않은 첫 행(숨은 칸 포함)도 함께 나간다 — 빠지면 서버에서 삭제된다.
    expect(edited.products).toEqual([
      initial.products[0],
      { ...second, name_en: "Second (renamed)" },
    ])
  })

  test("제품을 고치면 그 행의 숨은 칸이 보존되고, 새 행에는 다른 행의 값이 묻어 가지 않는다", () => {
    const form: ProfileFormState = {
      ...stale,
      products: [
        // 첫 행을 지우고 새 제품을 같은 순번에 넣었다.
        { name_ko: " 새 제품 ", name_en: "New", business_field: "game_production", hs_code: "", price_range: null, spec: "" },
      ],
    }

    const patch = toProxyProfilePatch(form, "exhibitor", stale) as { products: unknown[] }

    expect(patch.products).toEqual([
      { name_ko: "새 제품", name_en: "New", business_field: "game_production", hs_code: "", price_range: null, spec: "" },
    ])
    expect(JSON.stringify(patch.products)).not.toContain("구 카테고리")
    expect(JSON.stringify(patch.products)).not.toContain("통신기기")
  })

  test("원래 있던 목록을 다 빼면 빈 배열로 보내 지운다", () => {
    const patch = toProxyProfilePatch(
      { ...stale, products: [], preferred_buyer_countries: [], categories: [] },
      "exhibitor",
      stale,
    )
    expect(patch).toMatchObject({ products: [], preferred_buyer_countries: [], exhibition_categories: [] })
  })

  test("원래도 비어 있고 지금도 비어 있는 목록은 보내지 않는다(그 사이 채워진 서버 값을 지우지 않는다)", () => {
    const patch = toProxyProfilePatch(empty, "exhibitor", empty)
    expect(patch).toEqual({})
  })

  test("빈 문자열은 지움이 아니라 안 건드림이다", () => {
    const patch = toProxyProfilePatch(
      { ...stale, website: "  ", company_intro_ko: "" },
      "exhibitor",
      stale,
    )
    expect(patch).not.toHaveProperty("website")
    expect(patch).not.toHaveProperty("intro_ko")
  })

  test("선택지에 없는 코드는 보내지 않는다(backend Literal 밖 값은 422)", () => {
    const patch = toProxyProfilePatch(
      { ...stale, annual_sales: "usd_1m_5m", employee_range: "많음" },
      "exhibitor",
      stale,
    )
    expect(patch).not.toHaveProperty("annual_sales_range") // 바이어 코드(USD)는 참가사에 없다
    expect(patch).not.toHaveProperty("employee_range")
  })
})

describe("대리작성 본문 — 바이어", () => {
  test("다이얼로그 칸만 나간다 — 구분·통역 필요·담당자는 건드리지 않는다", () => {
    const form: ProfileFormState = {
      ...empty,
      website: "https://buyer.example",
      company_intro_en: "A buyer",
      contact_language: "vi",
      annual_sales: "usd_1m_5m",
      employee_range: "e_51_100",
      categories: ["animation_distribution", "content_production"],
    }

    const patch = toProxyProfilePatch(form, "buyer", empty)

    expect(patch).toEqual({
      website: "https://buyer.example",
      company_intro_en: "A buyer",
      contact_language: "vi",
      annual_sales_range: "usd_1m_5m",
      employee_range: "e_51_100",
      interest_categories: ["animation_distribution", "content_production"],
    })
    // 충돌 비교가 쓰는 표도 바이어 본문이 낼 수 있는 키와 정확히 같다(기업소개 국문 포함).
    expect(Object.keys(PROXY_BODY_FIELDS.buyer).sort()).toEqual(
      [...Object.keys(patch), "company_intro_ko"].sort(),
    )
    // 예전 결함: 구분을 [하나]로 보내 여러 개가 1개로 줄었고, 통역 필요 미응답을 false로 덮어썼다.
    expect(patch).not.toHaveProperty("org_types")
    expect(patch).not.toHaveProperty("contact_interpreter_need")
    expect(patch).not.toHaveProperty("contact_name_ko")
  })

  test("손대지 않고 저장하면 아무것도 보내지 않는다(구분 3개·통역 필요 미응답이 그대로 남는다)", () => {
    const initial = toFormState(buyerDetail, "buyer")
    expect(toProxyProfilePatch({ ...initial }, "buyer", initial)).toEqual({})
  })

  test("참가사 전용 칸(제품·선호 바이어·상담 가능 언어)은 바이어 본문에 섞이지 않는다", () => {
    // 빈 초깃값에서 참가사 칸까지 전부 채워진 폼 — 바이어 본문에는 바이어 칸만 나가야 한다.
    const patch = toProxyProfilePatch(stale, "buyer", empty)
    expect(patch).toHaveProperty("website", "https://old.example")
    for (const key of [
      "products",
      "available_languages",
      "preferred_buyer_countries",
      "preferred_buyer_types",
      "exhibition_categories",
      "intro_ko",
    ]) {
      expect(patch).not.toHaveProperty(key)
    }
  })
})

// 저장 직전 재조회 — 운영자가 바꾼 칸이 다이얼로그를 연 뒤 서버에서도 달라졌으면 보내지 않는다.
describe("대리작성 충돌 — 운영자가 바꾼 칸이 그 사이 서버에서도 달라졌는가", () => {
  const added = { name_ko: "참가자가 추가한 제품", name_en: "Added by participant" }

  test("운영자가 제품을 고쳤는데 서버에서도 제품이 추가됐으면 충돌이다(보내면 추가분이 삭제된다)", () => {
    const form: ProfileFormState = {
      ...stale,
      products: [{ ...stale.products[0], name_en: "Renamed by operator" }],
    }
    const latest: ProfileFormState = { ...stale, products: [...stale.products, added] }
    expect(proxyPatchConflicts(form, "exhibitor", stale, latest)).toEqual(["products"])
  })

  test("운영자가 손대지 않은 칸이 서버에서 바뀐 것은 충돌이 아니다(그 칸은 보내지 않는다)", () => {
    const form: ProfileFormState = { ...stale, website: "https://operator.example" }
    const latest: ProfileFormState = {
      ...stale,
      products: [...stale.products, added],
      company_intro_en: "Participant rewrote this",
      preferred_buyer_countries: ["vietnam", "japan"],
    }
    expect(proxyPatchConflicts(form, "exhibitor", stale, latest)).toEqual([])
    expect(toProxyProfilePatch(form, "exhibitor", stale)).toEqual({
      website: "https://operator.example",
    })
  })

  test("같은 문자열·코드·목록 칸을 양쪽이 바꿨으면 충돌이다", () => {
    const form: ProfileFormState = {
      ...stale,
      company_intro_en: "Operator intro",
      employee_range: "e_101plus",
      categories: ["content_production", "game_production"],
    }
    const latest: ProfileFormState = {
      ...stale,
      company_intro_en: "Participant intro",
      employee_range: "e_51_100",
      categories: ["content_production", "music_production"],
    }
    expect(proxyPatchConflicts(form, "exhibitor", stale, latest).sort()).toEqual(
      ["employee_range", "exhibition_categories", "intro_en"].sort(),
    )
  })

  test("서버가 그대로면 충돌이 없다", () => {
    const form: ProfileFormState = { ...stale, company_intro_ko: "새 소개", categories: [] }
    expect(proxyPatchConflicts(form, "exhibitor", stale, { ...stale })).toEqual([])
  })

  // 본문 조립은 빈 값을 "안 건드림"으로 다뤄 키를 뺀다. 충돌 비교까지 그 규칙으로 하면 서버에서 **비워진**
  // 칸이 "변경 없음"이 돼, 참가자가 지운 값을 운영자의 저장이 되살린다(교차 리뷰 지적).
  test("서버에서 비워진 칸도 달라진 것이다 — 값이 있던 칸을 참가자가 지웠는데 운영자가 새 값을 넣으면 충돌", () => {
    // baseline "Intro" → 운영자 "Operator intro" / 그 사이 서버는 ""(참가자가 지움)
    const form: ProfileFormState = { ...stale, company_intro_en: "Operator intro" }
    const cleared: ProfileFormState = { ...stale, company_intro_en: "" }
    expect(proxyPatchConflicts(form, "exhibitor", stale, cleared)).toEqual(["intro_en"])
    // 공백만 남은 것도 비워진 것이다.
    expect(
      proxyPatchConflicts(form, "exhibitor", stale, { ...stale, company_intro_en: "   " }),
    ).toEqual(["intro_en"])
  })

  test("코드·목록·제품이 서버에서 비워진 경우도 충돌이다", () => {
    const form: ProfileFormState = {
      ...stale,
      employee_range: "e_101plus",
      categories: ["content_production", "game_production"],
      preferred_buyer_countries: ["vietnam", "thailand"],
      products: [{ ...stale.products[0], name_en: "Renamed by operator" }],
    }
    const cleared: ProfileFormState = {
      ...stale,
      employee_range: "",
      categories: [],
      preferred_buyer_countries: [],
      products: [],
    }
    expect(proxyPatchConflicts(form, "exhibitor", stale, cleared).sort()).toEqual(
      ["employee_range", "exhibition_categories", "preferred_buyer_countries", "products"].sort(),
    )
  })

  test("원래도 비어 있던 칸은 서버가 여전히 비어 있으면 충돌이 아니다(빈 값끼리는 같다)", () => {
    const initial: ProfileFormState = { ...stale, company_intro_ko: "", preferred_buyer_types: [] }
    const form: ProfileFormState = {
      ...initial,
      company_intro_ko: "운영자가 채운 소개",
      preferred_buyer_types: ["media"],
    }
    expect(proxyPatchConflicts(form, "exhibitor", initial, { ...initial })).toEqual([])
  })

  test("운영자가 손대지 않은 칸은 서버에서 비워졌어도 충돌이 아니다(그 칸은 보내지 않는다)", () => {
    const form: ProfileFormState = { ...stale, website: "https://operator.example" }
    const cleared: ProfileFormState = { ...stale, company_intro_en: "", products: [] }
    expect(proxyPatchConflicts(form, "exhibitor", stale, cleared)).toEqual([])
  })

  test("바이어: 관심분야를 양쪽이 바꿨으면 충돌이다", () => {
    const initial = toFormState(buyerDetail, "buyer")
    const form = { ...initial, categories: ["animation_distribution", "content_production"] }
    const latest = { ...initial, categories: ["animation_distribution", "music_platform"] }
    expect(proxyPatchConflicts(form, "buyer", initial, latest)).toEqual(["interest_categories"])
  })
})
