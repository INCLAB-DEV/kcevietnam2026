import { describe, expect, it } from "vitest"
import {
  ADOPTION_TIMELINES,
  ANNUAL_SALES_BUYER,
  BUDGET_RANGES,
  BUSINESS_FIELDS,
  EMPLOYEE_RANGE,
  LANGUAGES,
  ORG_TYPE_CHOICES,
  adoptionTimelineOptionsFor,
  annualSalesBuyerOptionsFor,
  budgetRangeOptionsFor,
  businessFieldOptionsFor,
  employeeRangeOptionsFor,
  languageOptionsFor,
  orgTypeChoicesFor,
} from "./options"

// 이슈 #7 — 바이어 신청서(step-basic-info·step-interests·step-review)가 쓰는 옵션도 fields.ts와
// 같은 패턴으로 로케일을 지원한다. ko 인자를 생략하면 기존 배열과 동일해야 회귀가 없다.
describe("options.ts — 바이어 화면 로케일 옵션(이슈 #7)", () => {
  it("locale='ko'는 기존 배열과 동일하다", () => {
    expect(businessFieldOptionsFor("ko")).toEqual(BUSINESS_FIELDS)
    expect(orgTypeChoicesFor("ko")).toEqual(ORG_TYPE_CHOICES)
    expect(languageOptionsFor("ko")).toEqual(LANGUAGES)
    expect(annualSalesBuyerOptionsFor("ko")).toEqual(ANNUAL_SALES_BUYER)
    expect(budgetRangeOptionsFor("ko")).toEqual(BUDGET_RANGES)
    expect(adoptionTimelineOptionsFor("ko")).toEqual(ADOPTION_TIMELINES)
    expect(employeeRangeOptionsFor("ko")).toEqual(EMPLOYEE_RANGE)
  })

  it("locale='en'은 코드 집합이 그대로고 라벨만 영어다(한글 없음)", () => {
    const pairs: [readonly { code: string; label: string }[], readonly { code: string; label: string }[]][] = [
      [BUSINESS_FIELDS, businessFieldOptionsFor("en")],
      [ORG_TYPE_CHOICES, orgTypeChoicesFor("en")],
      [LANGUAGES, languageOptionsFor("en")],
      [ANNUAL_SALES_BUYER, annualSalesBuyerOptionsFor("en")],
      [BUDGET_RANGES, budgetRangeOptionsFor("en")],
      [ADOPTION_TIMELINES, adoptionTimelineOptionsFor("en")],
      [EMPLOYEE_RANGE, employeeRangeOptionsFor("en")],
    ]
    for (const [ko, en] of pairs) {
      expect(en.map((o) => o.code)).toEqual(ko.map((o) => o.code))
      for (const opt of en) {
        expect(opt.label).not.toMatch(/[가-힣]/)
      }
    }
  })

  it("예산 범위(en)는 원화 환산 부연을 달지 않는다", () => {
    const opt = budgetRangeOptionsFor("en").find((o) => o.code === "usd_500k_1m")
    expect(opt?.label).toBe("USD 500,000 - 1,000,000")
  })

  it("사업분야(en)는 fields.ts BUSINESS_FIELD_LABELS_EN과 동치다(discover 사전 일치)", () => {
    const opt = businessFieldOptionsFor("en").find((o) => o.code === "webtoon_production")
    expect(opt?.label).toBe("Comics & Webtoon Production")
  })
})
