import { afterEach, describe, expect, it, vi } from "vitest"
import { createHttpBuyerClient, fetchBuyerProfile, toApiBody, toBuyerProfileDraft } from "./http-buyer-client"
import type { ApiBuyerProfile } from "./http-buyer-client"

afterEach(() => {
  vi.unstubAllGlobals()
})

// 실 백엔드(FastAPI GET /api/bm/buyer/{id}, backend/app/bm/schemas.py BuyerProfileResponse)가
// 내려주는 확정 응답 페이로드로 매핑을 고정하는 계약 테스트 — lib/discover/http-discover-client.test.ts·
// lib/meeting/http-meetings-client.test.ts와 같은 패턴.

const BASE: ApiBuyerProfile = {
  org_event_role_id: "role-1",
  application_status: "submitted",
  organization_name_ko: "서울콘텐츠파트너스",
  organization_name_en: "Seoul Content Partners",
  business_reg_no: "123-45-67890",
  website: "https://seoulcontent.com",
  continent: "Asia",
  country: "KR",
  city_state: "Seoul",
  zip_code: "12345",
  address1: "테헤란로 1",
  address2: "3층",
  tel: "02-1234-5678",
  last_year_best_buyer: "홍길동",
  annual_sales_range: "usd_1m_5m",
  employee_range: "e_101plus",
  business_perf_korea_3y: "usd_1m_5m",
  travelers_korea_3y: "t_501_1000",
  org_types: ["private_commercial"],
  interest_categories: ["game_production", "content_production"],
  contact_name_ko: "박제인",
  contact_name_en: "Jane Park",
  contact_title_ko: "이사",
  contact_title_en: "Director",
  contact_email: "jane@example.com",
  contact_language: "vi",
  contact_interpreter_need: true,
  company_intro_ko: "국문 소개",
  company_intro_en: "A K-content investment company.",
  budget_range: "usd_1m_5m",
  adoption_timeline: "2027_h1",
  note: "메모",
  participation_route: "re_3_5",
  new_acquisition_channel: "edm",
  kst_available_time: "09:00-18:00",
  attendees: [
    {
      first_name: "Gil",
      last_name: "Hong",
      division: "구매",
      job_title: "매니저",
      email: "buyer01@seoulcontent.com",
      tel: "02-0000-0000",
      mobile: "010-0000-0000",
      whatsapp_id: "gilhong",
      messenger_id: null,
      languages: ["en", "vi"],
      interpreter_need: true,
      interpreter_languages: ["en"],
    },
  ],
  recommended_buyers: [
    {
      continent: "Europe",
      country: "DE",
      organization: "ToonBridge",
      person_in_charge: "Max",
      email: "max@rheinmetall.de",
      tel: "+49-000",
    },
  ],
}

describe("BuyerProfileResponse → BuyerProfileDraft", () => {
  it("백엔드에 있는 필드를 camelCase로 매핑한다", () => {
    const draft = toBuyerProfileDraft(BASE)
    expect(draft.organizationNameKo).toBe("서울콘텐츠파트너스")
    expect(draft.organizationNameEn).toBe("Seoul Content Partners")
    expect(draft.businessRegNo).toBe("123-45-67890")
    expect(draft.website).toBe("https://seoulcontent.com")
    expect(draft.continent).toBe("Asia")
    expect(draft.country).toBe("KR")
    expect(draft.cityState).toBe("Seoul")
    expect(draft.tel).toBe("02-1234-5678")
    expect(draft.annualSalesRange).toBe("usd_1m_5m")
    expect(draft.employeeRange).toBe("e_101plus")
    expect(draft.orgTypes).toEqual(["private_commercial"])
    expect(draft.interestCategories).toEqual(["game_production", "content_production"])
    expect(draft.companyIntroEn).toBe("A K-content investment company.")
    expect(draft.note).toBe("메모")
    expect(draft.participationRoute).toBe("re_3_5")
    expect(draft.newAcquisitionChannel).toBe("edm")
    expect(draft.kstAvailableTime).toBe("09:00-18:00")
  })

  it("담당자·추천 바이어를 매핑한다", () => {
    const draft = toBuyerProfileDraft(BASE)
    expect(draft.attendees).toEqual([
      {
        firstName: "Gil",
        lastName: "Hong",
        division: "구매",
        jobTitle: "매니저",
        email: "buyer01@seoulcontent.com",
        tel: "02-0000-0000",
        mobile: "010-0000-0000",
        whatsappId: "gilhong",
        messengerId: "",
        languages: ["en", "vi"],
        interpreterNeed: true,
        interpreterLanguages: ["en"],
      },
    ])
    expect(draft.recommendedBuyers).toEqual([
      {
        continent: "Europe",
        country: "DE",
        organization: "ToonBridge",
        personInCharge: "Max",
        email: "max@rheinmetall.de",
        tel: "+49-000",
      },
    ])
  })

  it("신청자 식별(contact*)·회사소개 국문·예산/도입시기(BM-001 실배선 신규 컬럼)를 camelCase로 매핑한다", () => {
    const draft = toBuyerProfileDraft(BASE)
    expect(draft.contactNameKo).toBe("박제인")
    expect(draft.contactNameEn).toBe("Jane Park")
    expect(draft.contactTitleKo).toBe("이사")
    expect(draft.contactTitleEn).toBe("Director")
    expect(draft.contactEmail).toBe("jane@example.com")
    // contact_language는 backend Literal 검증 없는 자유문자열 — FE Lang(en/vi)의 "vi"가 그대로 통과해야 한다.
    expect(draft.contactLanguage).toBe("vi")
    expect(draft.contactInterpreterNeed).toBe(true)
    expect(draft.companyIntroKo).toBe("국문 소개")
    expect(draft.budgetRange).toBe("usd_1m_5m")
    expect(draft.adoptionTimeline).toBe("2027_h1")
  })

  it("null/undefined 필드는 빈 문자열·빈 배열로 정직하게 비운다(등록만 된 신규 프로필)", () => {
    const draft = toBuyerProfileDraft({ org_event_role_id: "role-2", application_status: "registered" })
    expect(draft.organizationNameKo).toBe("")
    expect(draft.orgTypes).toEqual([])
    expect(draft.interestCategories).toEqual([])
    expect(draft.attendees).toEqual([])
    expect(draft.recommendedBuyers).toEqual([])
  })
})

describe("fetchBuyerProfile — BFF(app/api/bm/[[...path]]/route.ts) 상대경로 호출", () => {
  it("GET /api/bm/buyer/{id} 를 호출하고 draft+status로 매핑한다", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(BASE),
    })
    vi.stubGlobal("fetch", fetchSpy)

    const result = await fetchBuyerProfile("role-1")

    expect(fetchSpy).toHaveBeenCalledWith("/api/bm/buyer/role-1")
    expect(result.status).toBe("submitted")
    expect(result.draft.organizationNameKo).toBe("서울콘텐츠파트너스")
  })

  it("응답이 실패(!ok)면 던진다(호출부가 에러 UI로 처리)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") }),
    )
    await expect(fetchBuyerProfile("role-x")).rejects.toThrow("API 403")
  })
})

// toApiBody — 회귀 계약: 빈 문자열("")은 undefined처럼 스킵돼야 한다. buyer 폼은
// useForm({defaultValues: emptyBuyerProfileDraft()})로 모든 필드가 ""부터 시작해(exhibitor 폼의
// useForm({defaultValues: {}})과 달리 undefined가 아니다), 이걸 그대로 보내면 손대지 않은 select
// 필드(annualSalesRange 등)까지 매 PATCH에 실려 백엔드 Literal[...] | None 검증에서 422가 난다
// (실기기 스모크 테스트에서 실제로 재현된 회귀 — PATCH /api/bm/buyer/{id}/steps/1 422).
describe("toApiBody", () => {
  it("빈 문자열 필드는 스킵한다(미제공과 동일 취급 — Literal 검증 422 회귀 방지)", () => {
    const body = toApiBody({
      contactNameEn: "Jane Park",
      annualSalesRange: "",
      employeeRange: "",
      budgetRange: "",
    })
    expect(body).toEqual({ contact_name_en: "Jane Park" })
  })

  it("undefined 필드도 스킵한다(부분 저장 — 그 단계가 준 필드만)", () => {
    const body = toApiBody({ contactNameEn: "Jane Park", contactEmail: undefined })
    expect(body).toEqual({ contact_name_en: "Jane Park" })
  })

  it("빈 배열([])은 스킵하지 않는다 — 명시적 비우기(orgTypes 등 목록 필드 계약)", () => {
    const body = toApiBody({ orgTypes: [] })
    expect(body).toEqual({ org_types: [] })
  })

  it("담당자·추천 바이어는 snake_case 배열로 변환한다", () => {
    const body = toApiBody({
      attendees: [{ firstName: "Gil", lastName: "Hong", email: "g@example.com" } as never],
      recommendedBuyers: [{ organization: "ToonBridge", email: "max@example.com" } as never],
    })
    expect(body.attendees).toEqual([
      expect.objectContaining({ first_name: "Gil", last_name: "Hong", email: "g@example.com" }),
    ])
    expect(body.recommended_buyers).toEqual([
      expect.objectContaining({ organization: "ToonBridge", email: "max@example.com" }),
    ])
  })
})

describe("createHttpBuyerClient — saveStep/submit (BFF 경유 PATCH/POST)", () => {
  it("saveStep은 PATCH /api/bm/buyer/{id}/steps/{step}을 호출하고 draft+status로 매핑한다", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BASE) })
    vi.stubGlobal("fetch", fetchSpy)

    const client = createHttpBuyerClient()
    const result = await client.saveStep("role-1", 1, { contactNameEn: "Jane Park", annualSalesRange: "" })

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/bm/buyer/role-1/steps/1",
      expect.objectContaining({ method: "PATCH" }),
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ contact_name_en: "Jane Park" }) // annual_sales_range("")는 실리지 않는다
    expect(result.status).toBe("submitted")
  })

  it("submit은 POST /api/bm/buyer/{id}/submit을 호출한다(patch 없으면 body 없음)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BASE) })
    vi.stubGlobal("fetch", fetchSpy)

    const client = createHttpBuyerClient()
    await client.submit("role-1")

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/bm/buyer/role-1/submit",
      expect.objectContaining({ method: "POST", body: undefined }),
    )
  })
})
