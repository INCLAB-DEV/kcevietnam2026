import { describe, it, expect } from "vitest"
import {
  canEnterStep,
  completedSteps,
  furthestStep,
  isStepComplete,
  isSubmittable,
  resolveEntryStep,
  stepPatch,
  validateStep,
} from "./form-state"
import { emptyBuyerProfileDraft, type BuyerProfileDraft } from "./types"

// 테스트는 구현 세부가 아니라 외부 동작만 본다(F-BM-001 Testing Decisions):
// "N단계까지 채우면 거기까지 열린다", "미완 단계는 완료로 안 잡힌다", "?step=N 보정".
// 2026-06-29: 담당자·참가정보 단계 제거 → 3단계(1.기본정보 · 2.관심분야소개 · 3.확인제출).

// 1단계(기본정보) 필수 = 신청자 핵심(이름영문·소속영문·이메일·전화번호) + 국가. 나머지는 선택.
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

describe("validateStep — 필수항목 충족", () => {
  it("빈 draft는 1단계가 미완이고 미충족 키를 보고한다", () => {
    const res = validateStep(1, emptyBuyerProfileDraft())
    expect(res.ok).toBe(false)
    expect(res.missing).toContain("contactNameEn")
    expect(res.missing).toContain("contactEmail")
  })

  it("규모·언어·직위 등은 비필수 — 신청자 핵심만 채워도 1단계 완료", () => {
    const draft = withStep1(emptyBuyerProfileDraft())
    expect(isStepComplete(1, draft)).toBe(true)
    expect(draft.annualSalesRange).toBe("")
    expect(validateStep(1, draft).missing).not.toContain("annualSalesRange")
  })

  it("2단계는 관심분야 1개 이상 + 영문 소개 필요", () => {
    const base = emptyBuyerProfileDraft()
    expect(validateStep(2, base).missing).toContain("interestCategories")
    expect(isStepComplete(2, withStep2(base))).toBe(true)
  })

  it("3단계(확인)는 입력이 없어 항상 통과한다", () => {
    expect(validateStep(3, emptyBuyerProfileDraft()).ok).toBe(true)
  })
})

describe("이어쓰기 진행 범위(furthestStep / canEnterStep)", () => {
  it("1단계만 채우면 2단계까지 열리고 3은 잠긴다", () => {
    const draft = withStep1(emptyBuyerProfileDraft())
    expect(furthestStep(draft)).toBe(2)
    expect(canEnterStep(2, draft)).toBe(true)
    expect(canEnterStep(3, draft)).toBe(false)
  })

  it("앞 단계가 비어 있으면 뒤 단계가 채워져도 진행 범위가 늘지 않는다", () => {
    // 1단계 미완 + 2단계만 채움 → 여전히 1단계까지만.
    const draft = withStep2(emptyBuyerProfileDraft())
    expect(furthestStep(draft)).toBe(1)
    expect(canEnterStep(2, draft)).toBe(false)
  })

  it("1~2단계 전부 채우면 확인(3)까지 열리고 제출 가능", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft()))
    expect(furthestStep(draft)).toBe(3)
    expect(canEnterStep(3, draft)).toBe(true)
    expect(isSubmittable(draft)).toBe(true)
    expect([...completedSteps(draft)].sort()).toEqual([1, 2])
  })
})

describe("stepPatch — 단계별 부분저장(그 단계 필드만)", () => {
  it("1단계 패치는 신청자·소속·국가 등만 담고 2단계 필드는 빼놓는다", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft()))
    const patch = stepPatch(1, draft)
    expect(patch.contactNameEn).toBe("Jin Lee")
    expect(patch.organizationNameEn).toBe("Hanwha Aerospace")
    expect(patch.country).toBe("Korea")
    // 회귀(2026-07-06): tel이 STEP_FIELDS[1]에 빠져 부분저장 시 전화번호가 유실됐다.
    expect(patch.tel).toBe("02-1234-5678")
    // 2단계 소유 필드는 포함되지 않는다.
    expect("interestCategories" in patch).toBe(false)
    expect("budgetRange" in patch).toBe(false)
  })

  it("2단계 패치는 관심분야·소개·예산·도입시기만 담는다", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft()))
    const patch = stepPatch(2, draft)
    expect(patch.interestCategories).toEqual(["game_production", "content_production"])
    expect("contactNameEn" in patch).toBe(false)
  })
})

describe("resolveEntryStep — /apply?step=N 직접 진입 보정", () => {
  it("step 미지정이면 진행 가능 최대 단계로 연다", () => {
    const draft = withStep1(emptyBuyerProfileDraft())
    expect(resolveEntryStep(undefined, draft)).toBe(2)
  })

  it("잠긴 단계를 요청하면 진행 가능 범위로 클램프", () => {
    const draft = withStep1(emptyBuyerProfileDraft()) // furthest = 2
    expect(resolveEntryStep(3, draft)).toBe(2)
  })

  it("완료된 프로필은 요청한 단계를 그대로 연다(BM-004 항목별 수정)", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft()))
    expect(resolveEntryStep(1, draft)).toBe(1)
    expect(resolveEntryStep(2, draft)).toBe(2)
    expect(resolveEntryStep(3, draft)).toBe(3)
  })

  it("범위를 벗어난 값(0, 99, NaN)도 안전하게 보정", () => {
    const draft = withStep2(withStep1(emptyBuyerProfileDraft())) // furthest = 3
    expect(resolveEntryStep(0, draft)).toBe(1)
    expect(resolveEntryStep(99, draft)).toBe(3)
    expect(resolveEntryStep(Number.NaN, draft)).toBe(3)
  })
})
