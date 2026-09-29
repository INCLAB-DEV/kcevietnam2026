import { describe, expect, it } from "vitest"
import { isStepComplete } from "./profile-form-state"
import { EXHIBITOR_STEP_SCHEMAS } from "./schemas"
import type { EditableStep, ExhibitorProfileDraft } from "./types"

// 검증 규칙 픽스처 고정 — isStepComplete()는 이제 Zod 스키마로 위임하므로(이중화 해소,
// 2026-07-06) 아래 픽스처들이 필수 규칙 자체(어떤 draft가 완료/미완인가)를 고정한다.
// (바이어 lib/apply/schemas.test.ts와 동일 패턴.)

const STEPS: readonly EditableStep[] = [1, 2, 3, 4]

function expectParity(draft: ExhibitorProfileDraft, steps: readonly EditableStep[] = STEPS) {
  for (const step of steps) {
    const legacy = isStepComplete(draft, step)
    const zod = EXHIBITOR_STEP_SCHEMAS[step].safeParse(draft).success
    expect(zod, `step ${step} 판정 불일치`).toBe(legacy)
  }
}

const attendee = { lastNameKo: "이", firstNameKo: "진", email: "jin@vc.com" }
const validProduct = {
  nameKo: "웹툰 시리즈",
  nameEn: "Webtoon Series",
  businessField: "webtoon_production" as const,
  hsCode: "4911.91",
}

function completeDraft(): ExhibitorProfileDraft {
  return {
    organizationNameKo: "가상콘텐츠",
    organizationNameEn: "Virtual Content",
    attendees: [attendee],
    introKo: "국문 소개",
    introEn: "English intro",
    products: [validProduct],
    exhibitionCategories: ["webtoon_production"],
  }
}

describe("Zod 스키마 ↔ isStepComplete 판정 동등성", () => {
  it("빈 draft — 네 단계 모두 같은 판정 (4단계만 통과)", () => {
    expectParity({})
  })

  it("완성 draft — 네 단계 모두 같은 판정 (전부 통과)", () => {
    expectParity(completeDraft())
  })

  it("1단계 — 기업명 국/영만 필수(담당자는 게이트 아님, 2026-09-09 ADR-0012 개정)", () => {
    const full = completeDraft()
    expectParity({ ...full, organizationNameKo: "" })
    expectParity({ ...full, organizationNameEn: "   " }) // 공백만 = 미충족
    // 담당자 유무는 1단계 판정에 영향 없다 — 어느 경우든 두 판정이 동일(제출 게이트 아님).
    expectParity({ ...full, attendees: [] })
    expectParity({ ...full, attendees: undefined })
  })

  it("2단계 — 소개 국/영 하나라도 빠지면 미완", () => {
    const full = completeDraft()
    expectParity({ ...full, introKo: undefined })
    expectParity({ ...full, introEn: "" })
  })

  it("3단계 — 제품·분야 조합별 판정", () => {
    const full = completeDraft()
    expectParity({ ...full, products: [] })
    expectParity({ ...full, products: [{ nameKo: "" }] }) // 빈 줄만 → cleanProducts 후 0개
    expectParity({ ...full, products: [{ ...validProduct, nameEn: "" }] }) // 영문명 누락
    expectParity({ ...full, products: [{ ...validProduct, businessField: undefined }] })
    expectParity({ ...full, products: [{ ...validProduct, hsCode: "" }] })
    expectParity({ ...full, exhibitionCategories: [] })
    // 빈 줄 + 유효 제품 혼합 — 빈 줄은 떨어지고 유효 제품만 판정.
    expectParity({ ...full, products: [{ nameKo: " " }, validProduct] })
  })

  it("사업자번호는 게이트가 아니다(D4) — 없어도 양쪽 다 통과", () => {
    const draft = completeDraft()
    expect(draft.businessRegNo).toBeUndefined()
    expectParity(draft)
  })
})
