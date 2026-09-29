// BM-001 3단계 폼의 검증 규칙 **정본** — validateStep(form-state)·폼(apply-form)·API 라우트가
// 전부 여기로 위임한다(2026-07-06 이중화 해소). schemas.test.ts가 판정을 픽스처로 고정한다.
//
// email/tel 형식 검사를 도입하려면 여기 한 곳만 강화하면 된다(폼·API·진행 게이트 동시 적용).
// 단, 그건 동작 변경(기존에 통과하던 입력이 막힘)이라 기획·백엔드와 합의 후에.

import { z } from "zod"
import type { StepNumber } from "./form-state"

// validateStep의 blank()와 동일 판정: null/undefined/trim 후 빈 문자열 → 미충족.
const requiredText = z
  .string()
  .nullish()
  .refine((v): v is string => v != null && v.trim() !== "", "필수 입력 항목입니다.")

// 1단계(기본정보) 필수 = 신청자 핵심(이름영문·소속영문·이메일·전화번호) + 국가.
// 직위·국문·언어·구분·기업규모는 선택 — 스키마에 두지 않는다(부분 패치와 무관하게 판정만 담당).
export const StepBasicInfoSchema = z.object({
  contactNameEn: requiredText,
  organizationNameEn: requiredText,
  contactEmail: requiredText,
  tel: requiredText,
  country: requiredText,
})

// 2단계(관심분야·소개) 필수 = 관심분야 1개 이상 + 영문 소개.
// 코드값(BusinessFieldCode) 유효성은 backend가 최종 검증 — validateStep과 동일하게 개수만 본다.
export const StepInterestsSchema = z.object({
  interestCategories: z.array(z.string()).min(1, "관심분야를 1개 이상 선택해 주세요."),
  companyIntroEn: requiredText,
})

// 확인(3) 단계는 입력이 없다 — validateStep(3)과 동일하게 항상 통과.
export const StepReviewSchema = z.object({})

export type StepBasicInfoValues = z.infer<typeof StepBasicInfoSchema>
export type StepInterestsValues = z.infer<typeof StepInterestsSchema>

// 단계 번호 → 스키마 (RHF 전환 시 resolver 선택, 테스트에서 동등성 순회에 사용).
export const STEP_SCHEMAS: Record<StepNumber, z.ZodTypeAny> = {
  1: StepBasicInfoSchema,
  2: StepInterestsSchema,
  3: StepReviewSchema,
}
