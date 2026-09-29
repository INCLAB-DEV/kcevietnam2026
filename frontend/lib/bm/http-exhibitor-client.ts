// 실 백엔드(FastAPI) 호출 클라이언트 — 실 로그인 세션(exhibitor-client.ts의 realSession)일 때 mock
// 대신 쓴다. 같은 출처 BFF(app/api/bm/[[...path]]/route.ts)를 상대경로로 호출한다 — 세션은 httpOnly
// 쿠키(브라우저가 same-origin 요청에 자동 첨부)라 이 클라 코드는 토큰을 직접 만지지 않는다. BFF가
// 서버 측에서 쿠키→Authorization: Bearer로 바꿔 FastAPI에 전달한다(예전엔 credentials:include로
// 백엔드를 cross-origin 직접 호출해 Authorization이 전혀 안 실려 전부 401이었다 — 그 방식 폐기).
// Cognito JWT 검증·소유권(403/401)은 백엔드(app/bm/router.py) 소관. FE 는 이 HTTP 경계만 호출.
//
// 경계 매핑: FE camelCase ↔ API snake_case. 단계별 PATCH(/steps/{step})·조회(GET)·제출(/submit)은
// backend/app/bm/router.py 의 참가사 라우트와 1:1. 목록(products·attendees·추천)은 전체 교체.

import type {
  EditableStep,
  ExhibitorAttendee,
  ExhibitorProfile,
  ExhibitorProfileClient,
  ExhibitorStepPatch,
  Product,
  RecommendedBuyer,
} from "./types"

// ── snake_case(API) → camelCase(FE) ───────────────────────────────────────────
interface ApiProduct {
  name_ko: string
  name_en?: string | null
  business_field?: Product["businessField"] | null // 사업분야(8종) 코드
  category_ko?: string | null
  category_en?: string | null
  hs_code?: string | null
  hs_description?: string | null
  spec?: string | null
  spec_en?: string | null
  price_range?: Product["priceRange"] | null // 제품별 가격대(백엔드 후속)
}
interface ApiAttendee {
  last_name_ko?: string | null
  last_name_en?: string | null
  first_name_ko?: string | null
  first_name_en?: string | null
  division_ko?: string | null
  division_en?: string | null
  title_ko?: string | null
  title_en?: string | null
  email?: string | null
  tel?: string | null
  mobile?: string | null
  whatsapp_id?: string | null
  languages?: string[] | null
}
interface ApiRecommended {
  continent?: string | null
  country?: string | null
  org_name_en?: string | null
  person_name_en?: string | null
  email?: string | null
  contact?: string | null
}
interface ApiProfile {
  org_event_role_id: string
  application_status: ExhibitorProfile["applicationStatus"]
  organization_name_ko?: string | null
  organization_name_en?: string | null
  business_reg_no?: string | null
  // ⚠ 신규 로스터 컬럼 — 백엔드(#26) 미반영. 스키마 추가 전까지 실연동 시 무시/누락(nil 처리).
  booth_hall?: string | null
  booth_pavilion?: string | null
  booth_location?: string | null
  booth_type?: string | null
  booth_count?: number | null
  representative_name_ko?: string | null
  representative_name_en?: string | null
  company_email?: string | null
  zip_code?: string | null
  address_detail?: string | null
  business_type?: string | null
  business_item?: string | null
  website?: string | null
  main_tel?: string | null
  fax?: string | null
  address_ko?: string | null
  address_en?: string | null
  annual_sales_range?: ExhibitorProfile["annualSalesRange"] | null
  employee_range?: ExhibitorProfile["employeeRange"] | null
  available_languages?: ExhibitorProfile["availableLanguages"] | null
  org_types?: ExhibitorProfile["orgTypes"] | null
  exhibition_categories?: ExhibitorProfile["exhibitionCategories"] | null
  content_category?: ExhibitorProfile["contentCategory"] | null
  products?: ApiProduct[] | null
  intro_ko?: string | null
  intro_en?: string | null
  preferred_buyer_countries?: string[] | null // 신규(백엔드 후속)
  preferred_buyer_types?: ExhibitorProfile["orgTypes"] | null // 신규(백엔드 후속)
  participation_route?: ExhibitorProfile["participationRoute"] | null
  new_acquisition_channel?: ExhibitorProfile["newAcquisitionChannel"] | null
  unavailable_meeting_slots?: string[] | null // 신규(백엔드 후속)
  attendees?: ApiAttendee[] | null
  recommended_buyers?: ApiRecommended[] | null
}

const nil = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v)

function fromApiProduct(p: ApiProduct): Product {
  return {
    nameKo: p.name_ko,
    nameEn: nil(p.name_en),
    businessField: nil(p.business_field),
    categoryKo: nil(p.category_ko),
    categoryEn: nil(p.category_en),
    hsCode: nil(p.hs_code),
    hsDescription: nil(p.hs_description),
    spec: nil(p.spec),
    specEn: nil(p.spec_en),
    priceRange: nil(p.price_range),
  }
}
function fromApiAttendee(a: ApiAttendee): ExhibitorAttendee {
  return {
    lastNameKo: nil(a.last_name_ko),
    lastNameEn: nil(a.last_name_en),
    firstNameKo: nil(a.first_name_ko),
    firstNameEn: nil(a.first_name_en),
    divisionKo: nil(a.division_ko),
    divisionEn: nil(a.division_en),
    titleKo: nil(a.title_ko),
    titleEn: nil(a.title_en),
    email: nil(a.email),
    tel: nil(a.tel),
    mobile: nil(a.mobile),
    whatsappId: nil(a.whatsapp_id),
    languages: nil(a.languages) as ExhibitorAttendee["languages"],
  }
}
function fromApiRecommended(r: ApiRecommended): RecommendedBuyer {
  return {
    continent: nil(r.continent),
    country: nil(r.country),
    orgNameEn: nil(r.org_name_en),
    personNameEn: nil(r.person_name_en),
    email: nil(r.email),
    contact: nil(r.contact),
  }
}

function fromApi(p: ApiProfile): ExhibitorProfile {
  return {
    orgEventRoleId: p.org_event_role_id,
    applicationStatus: p.application_status,
    organizationNameKo: nil(p.organization_name_ko),
    organizationNameEn: nil(p.organization_name_en),
    businessRegNo: nil(p.business_reg_no),
    hall: nil(p.booth_hall),
    pavilion: nil(p.booth_pavilion),
    boothLocation: nil(p.booth_location),
    boothType: nil(p.booth_type),
    boothCount: nil(p.booth_count),
    representativeNameKo: nil(p.representative_name_ko),
    representativeNameEn: nil(p.representative_name_en),
    companyEmail: nil(p.company_email),
    zipCode: nil(p.zip_code),
    addressDetail: nil(p.address_detail),
    businessType: nil(p.business_type),
    businessItem: nil(p.business_item),
    website: nil(p.website),
    mainTel: nil(p.main_tel),
    fax: nil(p.fax),
    addressKo: nil(p.address_ko),
    addressEn: nil(p.address_en),
    annualSalesRange: nil(p.annual_sales_range),
    employeeRange: nil(p.employee_range),
    availableLanguages: nil(p.available_languages) ?? [],
    orgTypes: nil(p.org_types) ?? [],
    products: (p.products ?? []).map(fromApiProduct),
    exhibitionCategories: nil(p.exhibition_categories) ?? [],
    contentCategory: nil(p.content_category),
    introKo: nil(p.intro_ko),
    introEn: nil(p.intro_en),
    preferredBuyerCountries: nil(p.preferred_buyer_countries) ?? [],
    preferredBuyerTypes: nil(p.preferred_buyer_types) ?? [],
    participationRoute: nil(p.participation_route),
    newAcquisitionChannel: nil(p.new_acquisition_channel),
    unavailableMeetingSlots: nil(p.unavailable_meeting_slots) ?? [],
    attendees: (p.attendees ?? []).map(fromApiAttendee),
    recommendedBuyers: (p.recommended_buyers ?? []).map(fromApiRecommended),
  }
}

// ── camelCase(FE) → snake_case(API) — PATCH/제출 바디. 제공된 키만 담는다(부분 저장). ─────────
const CAMEL_TO_SNAKE: Record<string, string> = {
  organizationNameKo: "organization_name_ko",
  organizationNameEn: "organization_name_en",
  businessRegNo: "business_reg_no",
  hall: "booth_hall",
  pavilion: "booth_pavilion",
  boothLocation: "booth_location",
  boothType: "booth_type",
  boothCount: "booth_count",
  representativeNameKo: "representative_name_ko",
  representativeNameEn: "representative_name_en",
  companyEmail: "company_email",
  zipCode: "zip_code",
  addressDetail: "address_detail",
  businessType: "business_type",
  businessItem: "business_item",
  website: "website",
  mainTel: "main_tel",
  fax: "fax",
  addressKo: "address_ko",
  addressEn: "address_en",
  annualSalesRange: "annual_sales_range",
  employeeRange: "employee_range",
  availableLanguages: "available_languages",
  orgTypes: "org_types",
  exhibitionCategories: "exhibition_categories",
  contentCategory: "content_category",
  introKo: "intro_ko",
  introEn: "intro_en",
  preferredBuyerCountries: "preferred_buyer_countries",
  preferredBuyerTypes: "preferred_buyer_types",
  // unavailableMeetingSlots는 write에서 제외 — 미팅 불가 슬롯은 운영자 전용으로 이관됐고(ExhibitorStep4),
  // 백엔드가 이 필드를 extra_forbid로 막는다(fail-closed). 값은 응답에서만 읽는다(fromApi 유지).
  participationRoute: "participation_route",
  newAcquisitionChannel: "new_acquisition_channel",
}

function toApiProduct(p: Product): ApiProduct {
  return {
    name_ko: p.nameKo,
    name_en: p.nameEn,
    business_field: p.businessField,
    category_ko: p.categoryKo,
    category_en: p.categoryEn,
    hs_code: p.hsCode,
    hs_description: p.hsDescription,
    spec: p.spec,
    spec_en: p.specEn,
    price_range: p.priceRange,
  }
}
function toApiAttendee(a: ExhibitorAttendee): ApiAttendee {
  return {
    last_name_ko: a.lastNameKo,
    last_name_en: a.lastNameEn,
    first_name_ko: a.firstNameKo,
    first_name_en: a.firstNameEn,
    division_ko: a.divisionKo,
    division_en: a.divisionEn,
    title_ko: a.titleKo,
    title_en: a.titleEn,
    email: a.email,
    tel: a.tel,
    mobile: a.mobile,
    whatsapp_id: a.whatsappId,
    languages: a.languages,
  }
}
function toApiRecommended(r: RecommendedBuyer): ApiRecommended {
  return {
    continent: r.continent,
    country: r.country,
    org_name_en: r.orgNameEn,
    person_name_en: r.personNameEn,
    email: r.email,
    contact: r.contact,
  }
}

function toApiBody(patch: ExhibitorStepPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === "products") {
      body.products = (value as Product[]).map(toApiProduct)
    } else if (key === "attendees") {
      body.attendees = (value as ExhibitorAttendee[]).map(toApiAttendee)
    } else if (key === "recommendedBuyers") {
      body.recommended_buyers = (value as RecommendedBuyer[]).map(toApiRecommended)
    } else if (CAMEL_TO_SNAKE[key]) {
      body[CAMEL_TO_SNAKE[key]] = value
    }
  }
  return body
}

export function createHttpExhibitorClient(): ExhibitorProfileClient {
  const jsonHeaders = { "Content-Type": "application/json" }

  async function req(path: string, init?: RequestInit): Promise<ApiProfile> {
    // 상대경로 = 같은 출처 BFF(app/api/bm/[[...path]]/route.ts). 같은 출처 요청이라 fetch 기본
    // credentials("same-origin")로 세션 쿠키가 자동 첨부된다 — 별도 옵션 불필요.
    const res = await fetch(`/api/bm/exhibitor${path}`, init)
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as ApiProfile
  }

  return {
    async getProfile(orgEventRoleId) {
      return fromApi(await req(`/${orgEventRoleId}`))
    },
    async saveStep(orgEventRoleId, step: EditableStep, patch) {
      return fromApi(
        await req(`/${orgEventRoleId}/steps/${step}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(toApiBody(patch)),
        }),
      )
    },
    async submit(orgEventRoleId, patch) {
      return fromApi(
        await req(`/${orgEventRoleId}/submit`, {
          method: "POST",
          headers: jsonHeaders,
          body: patch ? JSON.stringify(toApiBody(patch)) : undefined,
        }),
      )
    },
  }
}
