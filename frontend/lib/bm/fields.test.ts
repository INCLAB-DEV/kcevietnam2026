import { describe, expect, it } from "vitest"
import {
  ANNUAL_SALES_SELLER_OPTIONS,
  BUSINESS_FIELD_LABELS_EN,
  BUSINESS_FIELD_OPTIONS,
  BUYER_COUNTRY_OPTIONS,
  CONTENT_CATEGORY_OPTIONS,
  EMPLOYEE_RANGE_OPTIONS,
  LANGUAGE_OPTIONS,
  ORG_TYPE_OPTIONS,
  PRODUCT_PRICE_RANGE_OPTIONS,
  annualSalesSellerOptionsFor,
  businessFieldOptionsFor,
  buyerCountryOptionsFor,
  contentCategoryOptionsFor,
  employeeRangeOptionsFor,
  languageOptionsFor,
  orgTypeOptionsFor,
  productPriceRangeOptionsFor,
} from "./fields"

// backend keywords 마스터(demo_seed.py DEMO_BUSINESS_FIELDS / migrations/kct001tax01_kcontent_
// taxonomy_pivot.py의 _BUSINESS_FIELD_LABELS)와 문자열 단위로 동치여야 한다 — discover는 이미 이
// label_en을 그대로 쓰고 있어서, 여기서 새로 번역하면 화면마다 다른 영문이 뜬다(이슈 #7).
const BACKEND_BUSINESS_FIELD_LABELS_EN: Record<string, string> = {
  game_production: "Game Production",
  animation_distribution: "Animation Distribution",
  content_production: "Content Production",
  music_platform: "Music Platform",
  newtech_content: "New-Tech Convergence Content",
  character_licensor: "Character Licensor",
  webtoon_production: "Comics & Webtoon Production",
  music_production: "Music Production",
}

describe("fields.ts — 참가자 화면 영문 라벨(이슈 #7)", () => {
  it("BUSINESS_FIELD_LABELS_EN은 backend keywords 마스터(label_en)와 문자열 단위로 일치한다", () => {
    expect(BUSINESS_FIELD_LABELS_EN).toEqual(BACKEND_BUSINESS_FIELD_LABELS_EN)
  })

  it("locale 인자를 생략하면 기존 ko 옵션과 동일하다(운영자 화면 회귀 방지)", () => {
    expect(businessFieldOptionsFor("ko")).toEqual(BUSINESS_FIELD_OPTIONS)
    expect(contentCategoryOptionsFor("ko")).toEqual(CONTENT_CATEGORY_OPTIONS)
    expect(orgTypeOptionsFor("ko")).toEqual(ORG_TYPE_OPTIONS)
    expect(languageOptionsFor("ko")).toEqual(LANGUAGE_OPTIONS)
    expect(annualSalesSellerOptionsFor("ko")).toEqual(ANNUAL_SALES_SELLER_OPTIONS)
    expect(employeeRangeOptionsFor("ko")).toEqual(EMPLOYEE_RANGE_OPTIONS)
    expect(productPriceRangeOptionsFor("ko")).toEqual(PRODUCT_PRICE_RANGE_OPTIONS)
    expect(buyerCountryOptionsFor("ko")).toEqual(BUYER_COUNTRY_OPTIONS)
  })

  it("locale='en'은 코드 집합이 ko 옵션과 동일하고(순서·개수 불변), 라벨만 영어다", () => {
    const pairs: [readonly { code: string; label: string }[], readonly { code: string; label: string }[]][] = [
      [BUSINESS_FIELD_OPTIONS, businessFieldOptionsFor("en")],
      [CONTENT_CATEGORY_OPTIONS, contentCategoryOptionsFor("en")],
      [ORG_TYPE_OPTIONS, orgTypeOptionsFor("en")],
      [LANGUAGE_OPTIONS, languageOptionsFor("en")],
      [ANNUAL_SALES_SELLER_OPTIONS, annualSalesSellerOptionsFor("en")],
      [EMPLOYEE_RANGE_OPTIONS, employeeRangeOptionsFor("en")],
      [PRODUCT_PRICE_RANGE_OPTIONS, productPriceRangeOptionsFor("en")],
      [BUYER_COUNTRY_OPTIONS, buyerCountryOptionsFor("en")],
    ]
    for (const [ko, en] of pairs) {
      expect(en.map((o) => o.code)).toEqual(ko.map((o) => o.code))
      for (const opt of en) {
        expect(opt.label).not.toMatch(/[가-힣]/)
      }
    }
  })

  it("웹툰 사업분야는 discover가 이미 쓰는 문구('Comics & Webtoon Production')와 동일하다", () => {
    const opt = businessFieldOptionsFor("en").find((o) => o.code === "webtoon_production")
    expect(opt?.label).toBe("Comics & Webtoon Production")
  })

  it("comics_game_music 카테고리 국문 라벨은 쉼표(공백 없음)를 쓴다(2026-09-17 발주사 라벨 변경)", () => {
    // '만화·웹툰/게임/음악'(가운뎃점) → '만화,웹툰/게임/음악'(쉼표, 공백 없음). 코드값·영문은 불변.
    const opt = contentCategoryOptionsFor("ko").find((o) => o.code === "comics_game_music")
    expect(opt?.label).toBe("만화,웹툰/게임/음악")
  })
})
