import type { Control } from "react-hook-form"
import type { BuyerProfileDraft } from "@/lib/apply/types"

// 각 단계 컴포넌트의 공통 계약 — RHF control(필드 배선)과 표시할 오류 키 집합.
// errors는 "다음" 시도에서 미충족으로 판정된 필드 키(Zod 스키마 이슈 경로 = validateStep의
// missing과 동일 키). 표시 시점 정책(시도 후에만·입력 시 해제)은 오케스트레이터(apply-form) 소유.
// 2026-07-06: draft/update(useState 수동 배선) → control(RHF) 전환 — 공용 rhf-fields 사용.
export interface StepProps {
  control: Control<BuyerProfileDraft>
  errors: Set<string>
}
