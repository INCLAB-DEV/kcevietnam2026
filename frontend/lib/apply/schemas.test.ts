import { describe, it, expect } from "vitest"
import { validateStep, type StepNumber } from "./form-state"
import { STEP_SCHEMAS, StepBasicInfoSchema, StepInterestsSchema } from "./schemas"
import { emptyBuyerProfileDraft, type BuyerProfileDraft } from "./types"

// 검증 규칙 픽스처 고정 — validateStep()은 이제 Zod 스키마로 위임하므로(이중화 해소, 2026-07-06)
// 동등성 검사는 "validateStep 결과(ok+missing)와 스키마 직접 판정이 같은 형태로 나온다"는
// 위임 배선의 회귀 방지 + 아래 픽스처들이 필수 규칙 자체(어떤 입력이 통과/미통과인가)를 고정한다.

// form-state.test.ts의 빌더와 동일한 기준 데이터.
function withStep1(draft: BuyerProfileDraft): BuyerProfileDraft {
  return {
    ...draft,
    contactNameEn: "Jin Lee",
    organizationNameEn: "Hanwha Aerospace",
    contactEmail: "jin@hanwha.com",
    tel: "02-1234-5678",
    country: "Korea",
  }
}

function withStep2(draft: BuyerProfileDraft): BuyerProfileDraft {
  return { ...draft, interestCategories: ["game_production", "content_production"], companyIntroEn: "We buy." }
}

// 스키마 판정을 validateStep과 같은 (ok, missing) 형태로 변환.
function schemaVerdict(step: StepNumber, draft: BuyerProfileDraft) {
  const result = STEP_SCHEMAS[step].safeParse(draft)
  const missing = result.success
    ? []
    : [...new Set(result.error.issues.map((issue) => String(issue.path[0])))]
  return { ok: result.success, missing }
}

function expectParity(step: StepNumber, draft: BuyerProfileDraft) {
  const legacy = validateStep(step, draft)
  const zod = schemaVerdict(step, draft)
  expect(zod.ok).toBe(legacy.ok)
  expect([...zod.missing].sort()).toEqual([...legacy.missing].sort())
}

const STEP1_REQUIRED = [
  "contactNameEn",
  "organizationNameEn",
  "contactEmail",
  "tel",
  "country",
] as const

describe("Zod 스키마 ↔ validateStep 판정 동등성", () => {
  it("빈 draft — 세 단계 모두 같은 판정", () => {
    const draft = emptyBuyerProfileDraft()
    for (const step of [1, 2, 3] as const) expectParity(step, draft)
  })

  it("1단계 완성 draft — 세 단계 모두 같은 판정", () => {
    const draft = withStep1(emptyBuyerProfileDraft())
    for (const step of [1, 2, 3] as const) expectParity(step, draft)
  })

  it("1~2단계 완성 draft — 세 단계 모두 같은 판정", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft()))
    for (const step of [1, 2, 3] as const) expectParity(step, draft)
  })

  it("1단계 필수 필드를 하나씩 비우면 — 같은 필드를 미충족으로 보고", () => {
    const full = withStep1(emptyBuyerProfileDraft())
    for (const field of STEP1_REQUIRED) {
      expectParity(1, { ...full, [field]: "" })
      expectParity(1, { ...full, [field]: "   " }) // 공백만 = blank
    }
  })

  it("2단계 — 관심분야만 / 소개만 채운 경우 각각 같은 판정", () => {
    const base = emptyBuyerProfileDraft()
    expectParity(2, { ...base, interestCategories: ["game_production"] }) // 소개 미충족
    expectParity(2, { ...base, companyIntroEn: "We buy." }) // 관심분야 미충족
  })

  it("비필수 필드(annualSalesRange 등)는 비어 있어도 양쪽 다 통과", () => {
    const draft = withStep1(emptyBuyerProfileDraft())
    expect(draft.annualSalesRange).toBe("")
    expectParity(1, draft)
  })
})

describe("스키마 단독 동작", () => {
  it("StepBasicInfoSchema — 공백만 있는 값은 거부한다", () => {
    const result = StepBasicInfoSchema.safeParse({
      contactNameEn: "  ",
      organizationNameEn: "Hanwha Aerospace",
      contactEmail: "jin@hanwha.com",
      tel: "02-1234-5678",
      country: "Korea",
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path[0])).toContain("contactNameEn")
    }
  })

  it("StepInterestsSchema — 관심분야 0개는 거부, 1개부터 통과", () => {
    const base = { companyIntroEn: "We buy." }
    expect(StepInterestsSchema.safeParse({ ...base, interestCategories: [] }).success).toBe(false)
    expect(
      StepInterestsSchema.safeParse({ ...base, interestCategories: ["game_production"] }).success,
    ).toBe(true)
  })
})
