import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchOrganizerMembers, toMemberProfile, toMemberRow } from "./http-members-client"

// 실 백엔드(FastAPI GET /api/admin/events/{id}/organizations*)가 내려주는 확정 응답 페이로드로
// 매핑을 고정하는 계약 테스트 — lib/admin/http-client.test.ts와 같은 패턴.

describe("OrganizationListItem → MemberRow", () => {
  it("명단 행을 탭·상태로 매핑한다(신청서 미제출 기업은 확장 필드가 없어 비워둔다)", () => {
    const row = toMemberRow({
      id: "org-1",
      name_ko: "테스트기업",
      name_en: "Test Co",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
    })
    expect(row.id).toBe("org-1")
    expect(row.name).toBe("테스트기업")
    expect(row.nameEn).toBe("Test Co")
    expect(row.tab).toBe("exhibitor")
    expect(row.applicationStatus).toBe("approved")
    expect(row.primaryContact).toBeNull()
    expect(row.contactEmail).toBeNull()
    expect(row.productCategory).toBeNull()
    expect(row.boothLabel).toBeUndefined()
  })

  it("is_exhibitor가 false면 buyer 탭, 이름 없으면 영문/기본값으로 폴백한다", () => {
    const row = toMemberRow({
      id: "org-2",
      name_ko: null,
      name_en: "Fallback Inc",
      is_exhibitor: false,
      is_buyer: true,
      application_status: "submitted",
    })
    expect(row.tab).toBe("buyer")
    expect(row.name).toBe("Fallback Inc")

    const noName = toMemberRow({
      id: "org-3",
      name_ko: null,
      name_en: null,
      is_exhibitor: false,
      is_buyer: true,
      application_status: "registered",
    })
    expect(noName.name).toBe("(이름 없음)")
  })

  // 2026-09 — 운영자 콘솔 명단이 담당자·이메일·부스·사업분야를 전부 "-"로만 보여주던 버그 수정.
  // 백엔드가 LEFT JOIN으로 채워 보내는 표시 필드가 탭별로 올바른 MemberRow 필드에 매핑되는지 고정.
  it("참가사 행 — 공통 담당자(contact_name/email/phone)·부스·사업분야를 채운다", () => {
    const row = toMemberRow({
      id: "org-ex-1",
      name_ko: "게임기업",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
      contact_name: "김대표",
      contact_email: "rep@game.example",
      contact_phone: "02-1111-2222",
      representative_name_ko: "김대표",
      main_tel: "02-1111-2222",
      booth_hall: "9",
      booth_pavilion: "게임관",
      booth_location: "A-101",
      exhibition_categories: ["game_production", "content_production"],
    })
    expect(row.primaryContact).toBe("김대표")
    expect(row.contactEmail).toBe("rep@game.example")
    expect(row.contactPhone).toBe("02-1111-2222")
    expect(row.mainTel).toBe("02-1111-2222")
    expect(row.boothLabel).toBe("9 · 게임관 · A-101")
    // 코드가 그대로 노출되면 버그 — 라벨로 변환돼야 한다.
    expect(row.productCategory).toBe("게임 제작, 콘텐츠 제작")
  })

  it("참가사 행 — 부스 신고값이 하나도 없으면 boothLabel은 undefined(화면 '-')", () => {
    const row = toMemberRow({
      id: "org-ex-2",
      name_ko: "부스없는기업",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "registered",
    })
    expect(row.boothLabel).toBeUndefined()
  })

  it("바이어 행 — 이름/직위는 본인이 등록한 contact_name_ko/en·contact_title_ko/en, 언어는 라벨 변환", () => {
    const row = toMemberRow({
      id: "org-by-1",
      name_ko: "1등회사inc",
      is_exhibitor: false,
      is_buyer: true,
      application_status: "approved",
      // 공통 contact_name은 대표자 개념이 없는 바이어라 비어있을 수 있다(라이브 DB 실측 케이스) —
      // 그래도 바이어 본인 등록값(contact_name_ko/en)으로 이름을 채울 수 있어야 한다.
      contact_name: null,
      contact_email: "qwer@qwer.com",
      contact_phone: "010-4444-4444",
      contact_name_ko: "난몰라",
      contact_name_en: "nanmol",
      contact_title_ko: "팀장",
      contact_language: "en",
      interest_categories: ["webtoon_production", "game_production"],
    })
    expect(row.primaryContact).toBe("난몰라")
    expect(row.primaryContactEn).toBe("nanmol")
    expect(row.contactTitle).toBe("팀장")
    expect(row.contactEmail).toBe("qwer@qwer.com")
    expect(row.contactPhone).toBe("010-4444-4444")
    expect(row.language).toBe("영어")
    expect(row.productCategory).toBe("만화웹툰 제작, 게임 제작")
    // 참가사 전용 필드는 바이어 행에서 안 채운다.
    expect(row.boothLabel).toBeUndefined()
    expect(row.mainTel).toBeUndefined()
  })

  it("바이어 행 — contact_name_ko가 없으면 공통 contact_name(엑셀과 동일 폴백)으로 대체한다", () => {
    const row = toMemberRow({
      id: "org-by-2",
      name_ko: "이름미등록바이어",
      is_exhibitor: false,
      is_buyer: true,
      application_status: "submitted",
      contact_name: "첫 담당자 이름",
      contact_name_ko: null,
    })
    expect(row.primaryContact).toBe("첫 담당자 이름")
  })
})

describe("OrgDetail(buyer_profile/exhibitor_profile) → MemberProfile", () => {
  it("바이어 신청서를 매핑한다", () => {
    const profile = toMemberProfile({
      id: "by-1",
      buyer_profile: {
        contact_name_ko: "조현우",
        contact_name_en: "Hyunwoo Cho",
        contact_email: "hw.cho@example.com",
        contact_language: "한국어",
        contact_interpreter_need: false,
        business_reg_no: "220-82-00012",
        website: "https://example.com",
        country: "대한민국",
        address1: "경기 과천시",
        address2: "관문로 47",
        tel: "02-2079-6114",
        annual_sales_range: "USD 500만 이상",
        employee_range: "101명 이상",
        org_types: ["정부 및 공공기관"],
        interest_categories: ["방송", "애니메이션/캐릭터"],
        company_intro_ko: "소개",
        budget_range: "USD 1천만 이상",
        adoption_timeline: "2027 상반기",
        kst_available_time: "9/9~9/10",
        participation_route: "재참가",
        attendees: [
          { first_name: "현우", last_name: "조", tel: "010-1111-2222", languages: ["한국어"], interpreter_need: false },
        ],
      },
      exhibitor_profile: null,
    })
    expect(profile.contactNameKo).toBe("조현우")
    expect(profile.contactEmail).toBe("hw.cho@example.com")
    expect(profile.country).toBe("대한민국")
    expect(profile.categories).toEqual(["방송", "애니메이션/캐릭터"])
    expect(profile.address).toBe("경기 과천시 관문로 47")
    expect(profile.budgetRange).toBe("USD 1천만 이상")
    expect(profile.attendees).toHaveLength(1)
    expect(profile.attendees?.[0].name).toBe("현우 조")
    expect(profile.attendees?.[0].tel).toBe("010-1111-2222")
  })

  it("참가사 신청서를 매핑한다(제품·부스 포함)", () => {
    const profile = toMemberProfile({
      id: "ex-1",
      buyer_profile: null,
      exhibitor_profile: {
        business_reg_no: "123-45-67890",
        representative_name_ko: "어성철",
        company_email: "contact@example.com",
        main_tel: "02-729-1114",
        fax: "02-729-1115",
        address_ko: "경기 성남시",
        address_detail: "판교로 309",
        business_type: "제조업",
        business_item: "애니메이션 유통",
        booth_pavilion: "제1전시관",
        booth_location: "A-12",
        booth_type: "독립부스",
        booth_count: 4,
        intro_ko: "회사소개",
        available_languages: ["한국어", "영어"],
        exhibition_categories: ["애니메이션/캐릭터"],
        products: [{ name_ko: "제품A", hs_code: "CL-11", price_range: "7천만~1억원" }],
        preferred_buyer_countries: ["일본", "미국"],
        attendees: [{ first_name_ko: "민수", last_name_ko: "김", title_ko: "부장", email: "ms.kim@example.com" }],
      },
    })
    expect(profile.representativeNameKo).toBe("어성철")
    expect(profile.address).toBe("경기 성남시 판교로 309")
    expect(profile.booth).toBe("제1전시관 A-12")
    expect(profile.boothCount).toBe(4)
    expect(profile.availableLanguages).toBe("한국어, 영어")
    expect(profile.products).toEqual([
      { nameKo: "제품A", nameEn: undefined, category: undefined, hsCode: "CL-11", hsDescription: undefined, priceRange: "7천만~1억원" },
    ])
    expect(profile.preferredBuyerCountries).toBe("일본, 미국")
    expect(profile.attendees?.[0].name).toBe("민수 김")
    expect(profile.attendees?.[0].title).toBe("부장")
  })

  it("둘 다 없으면(명단만) 빈 카테고리·undefined 필드로 접는다", () => {
    const profile = toMemberProfile({ id: "org-x", buyer_profile: null, exhibitor_profile: null })
    expect(profile.categories).toEqual([])
    expect(profile.attendees).toBeUndefined()
    expect(profile.website).toBeUndefined()
  })

  // 2026-09-10 — 신청서 조회 모달에 참가자구분·연매출 등이 backend 원시 코드로 그대로 노출되던 버그
  // 수정. 실 backend 코드(schemas.py Literal)를 넣어 라벨 변환을 검증하고, 맵에 없는 값은 원문이
  // 그대로 보존되는지(데이터 유실 방지 폴백)도 함께 고정한다.
  it("바이어 신청서의 코드(enum)를 라벨로 변환한다 — 모르는 코드는 원문 유지", () => {
    const profile = toMemberProfile({
      id: "by-2",
      buyer_profile: {
        contact_language: "vi",
        org_types: ["government", "legacy_unknown_code"],
        annual_sales_range: "usd_gt_5m",
        employee_range: "e_101plus",
        interest_categories: ["content_production"],
        budget_range: "usd_10m_plus",
        adoption_timeline: "2027_h1",
        participation_route: "re_1_2",
        attendees: [{ first_name: "현우", last_name: "조", languages: ["vi", "ko"] }],
      },
      exhibitor_profile: null,
    })
    expect(profile.contactLanguage).toBe("베트남어")
    expect(profile.orgTypes).toEqual(["정부 및 공공기관", "legacy_unknown_code"])
    expect(profile.annualSales).toBe("USD 5,000,000 초과") // buyer는 USD 맵(AnnualSalesBuyer)
    expect(profile.employeeRange).toBe("101명 이상")
    expect(profile.categories).toEqual(["콘텐츠 제작"])
    expect(profile.budgetRange).toBe("USD 10,000,000 이상")
    expect(profile.adoptionTimeline).toBe("2027년 상반기")
    expect(profile.participationRoute).toBe("재참가(1~2회)")
    expect(profile.attendees?.[0].languages).toBe("베트남어, 한국어")
  })

  it("참가사 신청서의 코드도 라벨로 변환한다 — 연매출은 KRW 맵, 제품·선호 바이어 필드도 함께", () => {
    const profile = toMemberProfile({
      id: "ex-2",
      buyer_profile: null,
      exhibitor_profile: {
        annual_sales_range: "krw_50plus",
        employee_range: "e_51_100",
        exhibition_categories: ["webtoon_production"],
        available_languages: ["en", "vi"],
        products: [{ name_ko: "제품B", business_field: "content_production", price_range: "krw_70_100m" }],
        preferred_buyer_countries: ["vietnam", "unknown_country_code"],
        preferred_buyer_types: ["media"],
      },
    })
    expect(profile.annualSales).toBe("50억원 이상") // exhibitor는 KRW 맵(AnnualSalesSeller)
    expect(profile.employeeRange).toBe("51~100명")
    expect(profile.categories).toEqual(["만화웹툰 제작"])
    expect(profile.availableLanguages).toBe("영어, 베트남어")
    expect(profile.products?.[0].category).toBe("콘텐츠 제작")
    expect(profile.products?.[0].priceRange).toBe("7천만~1억원")
    // 코드 목록(vietnam)은 라벨로, 목록에 없는 코드(unknown_country_code)는 원문 그대로.
    expect(profile.preferredBuyerCountries).toBe("베트남, unknown_country_code")
    expect(profile.preferredBuyerTypes).toBe("방송·미디어")
  })
})

// unwrap()의 401 처리 — http-ops-metrics-client.test.ts와 동일 원칙/패턴의 회귀 테스트.
// (OP-002/003 명단 읽기도 같은 unwrap 형태를 갖고 있어 같은 버그·같은 수정이 적용된다.)
describe("fetchOrganizerMembers — 백엔드 인증 실패 처리", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("401이면 raw Error를 던지지 않고 /login으로 redirect한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "인증이 필요합니다" }), { status: 401 })),
    )

    await expect(fetchOrganizerMembers("stale-token")).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;.*;\/login;/),
    })
  })

  it("401이 아닌 실패(예: 500)는 기존처럼 Error로 전파한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "internal" }), { status: 500 })),
    )

    await expect(fetchOrganizerMembers("token")).rejects.toThrow(/organizer members read failed/)
  })
})

// resolveOrganizerToken — 토큰(SESSION_COOKIE) 자체가 없는 비실세션 경로는 401 redirect와 별개다.
// 호출부(lib/api-client/server.ts)가 null을 보고 기존 mock 폴백으로 분기하므로, 이 함수가 그 신호를
// 그대로 유지하는지만 고정한다(위 401 테스트와 섞이지 않도록 구분).
describe("resolveOrganizerToken — 세션 쿠키 없음", () => {
  afterEach(() => {
    vi.doUnmock("next/headers")
    vi.resetModules()
  })

  it("SESSION_COOKIE가 없으면 null을 반환한다(mock 폴백 신호)", async () => {
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
    }))
    vi.resetModules()
    const { resolveOrganizerToken: resolveWithNoCookie } = await import("./http-members-client")

    await expect(resolveWithNoCookie()).resolves.toBeNull()
  })
})
