// F-BM-002 참가사(전시자) 프로필 폼의 검증 규칙 **정본** — profile-form-state의
// isStepComplete()가 여기로 위임한다(2026-07-06 이중화 해소). schemas.test.ts가 판정을
// 픽스처로 고정한다. businessRegNo는 어떤 단계에도 넣지 않는다(D4 — 미입력이어도 작성·제출 가능).

import { z } from "zod"
import type { EditableStep } from "./types"

const nonEmpty = (value: string | undefined | null): boolean =>
  typeof value === "string" && value.trim().length > 0

const requiredText = z
  .string()
  .nullish()
  .refine((v): v is string => nonEmpty(v), "필수 입력 항목입니다.")

// 1단계 기본정보: 기업명 국/영만 필수.
// ⚠ 담당자(attendees)는 제출 게이트가 아니다(2026-09-09, ADR-0012 개정) — 셀프가입 참가사는
// 신청서에 담당자 추가 UI가 없어 0명으로 제출된다. 백엔드 _validate_submit도 참가사 담당자를
// 요구하지 않으므로 FE 게이트를 백엔드와 정렬한다. 담당자는 제출 후 운영자가 대리작성으로 보강.
export const StepBasicSchema = z.object({
  organizationNameKo: requiredText,
  organizationNameEn: requiredText,
})

// 2단계 회사소개: 기업소개 국/영 둘 다.
export const StepIntroSchema = z.object({
  introKo: requiredText,
  introEn: requiredText,
})

// 3단계 전시품목: 유효 제품(제품명 국문) 최소 1개 + 모든 유효 제품의 영문명·사업분야·HS코드
// + 사업분야(exhibitionCategories) 최소 1개. 빈 줄 제거(isProductValid = 국문명 유무) 후 판정 —
// cleanProducts와 같은 규칙을 인라인으로 둔다(런타임 순환 import 방지: profile-form-state가
// 이 모듈로 위임하므로 이 모듈은 profile-form-state의 런타임 심볼을 가져오면 안 된다).
const ProductRowSchema = z
  .object({
    nameKo: z.string(),
    nameEn: z.string().nullish(),
    businessField: z.string().nullish(),
  })
  .passthrough()

export const StepProductsSchema = z
  .object({
    products: z.array(ProductRowSchema).nullish(),
    exhibitionCategories: z.array(z.string()).nullish(),
  })
  .superRefine((value, ctx) => {
    const cleaned = (value.products ?? []).filter((p) => nonEmpty(p.nameKo))
    if (cleaned.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["products"], message: "전시 제품을 1개 이상 입력해 주세요." })
    } else if (
      // HS코드는 실물 상품(굿즈 등)에만 해당해 필수가 아니다(2026-09-12, K-콘텐츠 판권 거래엔
      // HS코드 개념이 없다 — 발주자 결정). 영문명·사업분야만 게이트로 남긴다.
      !cleaned.every((p) => nonEmpty(p.nameEn) && p.businessField != null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["products"],
        message: "모든 전시 제품에 영문명·사업분야를 입력해 주세요.",
      })
    }
    if ((value.exhibitionCategories?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exhibitionCategories"],
        message: "사업분야를 1개 이상 선택해 주세요.",
      })
    }
  })

// 4단계 타겟: 모두 선택 — 필수 게이트 없음(isStepComplete와 동일하게 항상 통과).
export const StepTargetSchema = z.object({})

export const EXHIBITOR_STEP_SCHEMAS: Record<EditableStep, z.ZodTypeAny> = {
  1: StepBasicSchema,
  2: StepIntroSchema,
  3: StepProductsSchema,
  4: StepTargetSchema,
}
