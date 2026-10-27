// `profile-form-state` — BM-001 3단계 폼의 진행/검증/재개/직접진입을 캡슐화하는 순수 모듈.
// React·fetch에 의존하지 않는다(F-BM-001 식별 deep module). 외부 동작만 노출:
//   - 각 단계의 완료 여부(필수항목 충족) 판정
//   - 이어쓰기(재개) 시 어디까지 열려 있는가(reachable)
//   - /apply?step=N 직접 진입 시 안전한 단계로 보정
//   - 제출 가능 여부(1~2단계 전부 충족 — backend가 최종 검증)
//
// "필수"는 제출 게이트 기준이다. 단계별 부분저장은 항상 허용(빈 값도 PATCH 가능, #26 정합) —
// 이 모듈은 "막는" 게 아니라 "완료/진행"을 계산한다.

import type { BuyerProfileDraft } from "./types"
// 검증 규칙 정본 — schemas.ts는 이 모듈에서 type만 가져가므로(런타임 순환 없음) 안전.
import { STEP_SCHEMAS } from "./schemas"

// 2026-06-29: 담당자·참가정보·추천 단계 제거 → 3단계(기본정보·관심분야소개·확인제출).
export type StepNumber = 1 | 2 | 3
export const STEPS: readonly StepNumber[] = [1, 2, 3] as const
// 입력 단계(요약/제출 제외) — 완료율·진행 계산의 분모.
export const INPUT_STEPS: readonly StepNumber[] = [1, 2] as const
export const LAST_STEP: StepNumber = 3
export const REVIEW_STEP: StepNumber = 3

// 단계 제목은 이 모듈에 두지 않는다 — messages의 applyBuyer.stepTitles.{1|2|3}(화면 로케일)에서 뽑는다
// (components/apply/apply-stepper.tsx 등).

// 단계별 소유 필드 — 부분저장(PATCH)이 그 단계 필드만 보내도록(backend /steps/{step} 미러).
// 확인(3) 단계는 입력이 없어 비어 있다. 새 필드를 추가하면 해당 단계에 등록한다.
export const STEP_FIELDS: Record<StepNumber, (keyof BuyerProfileDraft)[]> = {
  1: [
    "contactNameKo",
    "contactNameEn",
    "contactTitleKo",
    "contactTitleEn",
    "contactEmail",
    "contactLanguage",
    "contactInterpreterNeed",
    "organizationNameKo",
    "organizationNameEn",
    "country",
    // tel은 1단계 필수(validateStep)인데 여기 빠져 있어 stepPatch가 버렸다 — 부분저장 시
    // 전화번호가 유실되는 버그(2026-07-06 발견, API 스모크 테스트에서 노출). 소유 단계에 등록.
    "tel",
    "orgTypes",
    "annualSalesRange",
    "employeeRange",
  ],
  2: ["interestCategories", "companyIntroKo", "companyIntroEn", "budgetRange", "adoptionTimeline"],
  3: [],
}

// 한 단계의 필드만 뽑아 부분 패치를 만든다(다른 단계 값은 건드리지 않음).
export function stepPatch(
  step: StepNumber,
  draft: BuyerProfileDraft,
): Partial<BuyerProfileDraft> {
  const patch: Partial<BuyerProfileDraft> = {}
  for (const key of STEP_FIELDS[step]) {
    // 키별 타입은 BuyerProfileDraft에 일치하지만 동적 인덱싱이라 단언이 필요하다.
    ;(patch as Record<string, unknown>)[key] = draft[key]
  }
  return patch
}

export interface ValidationResult {
  ok: boolean
  // 미충족 필드 키 목록(폼이 해당 입력에 오류 표시를 붙이는 데 사용).
  missing: string[]
}

// ── 단계별 필수 검증 (제출 게이트 기준) ────────────────────────────────────────
// 규칙의 정본은 Zod 스키마(schemas.ts) 하나다 — 2026-07-06 이중화 해소(전환기 병행 유지 종료).
// 필수 규칙 요약(스키마와 동일): 1단계 = 신청자 핵심(이름영문·소속영문·이메일·전화번호) + 국가,
// 2단계 = 관심분야 1개 이상 + 영문 소개, 3단계(확인) = 입력 없음.
// email/tel 형식 검사 도입 시 schemas.ts 한 곳만 바꾸면 폼·API·이 함수가 함께 강화된다.
export function validateStep(step: StepNumber, draft: BuyerProfileDraft): ValidationResult {
  const result = STEP_SCHEMAS[step].safeParse(draft)
  if (result.success) return { ok: true, missing: [] }
  const missing = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))]
  return { ok: false, missing }
}

export function isStepComplete(step: StepNumber, draft: BuyerProfileDraft): boolean {
  return validateStep(step, draft).ok
}

// 완료된 입력 단계 집합(1~2 중).
export function completedSteps(draft: BuyerProfileDraft): Set<StepNumber> {
  const done = new Set<StepNumber>()
  for (const s of INPUT_STEPS) if (isStepComplete(s, draft)) done.add(s)
  return done
}

// 진행 가능 최대 단계 — 앞에서부터 연속으로 완료된 단계의 다음까지 열린다.
// 예) 1 완료, 2 미완 → 2까지 진입 가능(3 잠금). 1~2 전부 완료 → 3(확인)까지.
export function furthestStep(draft: BuyerProfileDraft): StepNumber {
  let reached: StepNumber = 1
  for (const s of INPUT_STEPS) {
    if (isStepComplete(s, draft)) {
      reached = Math.min(s + 1, LAST_STEP) as StepNumber
    } else {
      break
    }
  }
  return reached
}

// 진입 가능 여부 — 진행 가능 최대 단계(앞 단계 연속 완료의 다음)까지 열린다. 이미 완료한
// 프로필(전부 충족)은 모든 단계가 furthestStep=3 안에 들어와 BM-004 항목별 수정도 자유롭다(D3).
export function canEnterStep(step: StepNumber, draft: BuyerProfileDraft): boolean {
  return step <= furthestStep(draft)
}

// /apply?step=N 직접 진입 보정 — 범위 밖/잠긴 단계로 들어오면 진행 가능한 곳으로 클램프.
// BM-004 "특정 단계만 수정"(D3): 완료된 단계면 그대로 그 단계를 연다.
export function resolveEntryStep(
  requested: number | undefined | null,
  draft: BuyerProfileDraft,
): StepNumber {
  if (requested == null || Number.isNaN(requested)) return furthestStep(draft)
  const clamped = Math.max(1, Math.min(Math.trunc(requested), LAST_STEP)) as StepNumber
  // 완료한 단계(또는 그보다 앞)거나 진행 가능 범위 안이면 요청 단계를 연다.
  if (clamped <= furthestStep(draft)) return clamped
  return furthestStep(draft)
}

// 1~2단계 전부 충족 → 제출 가능(원자적 submit 진입 조건; backend가 최종 검증).
export function isSubmittable(draft: BuyerProfileDraft): boolean {
  return INPUT_STEPS.every((s) => isStepComplete(s, draft))
}

// 진행률(0~1) — 완료된 입력 단계 수 / 전체 입력 단계 수. 스텝퍼·진행바 표시용.
export function completionRatio(draft: BuyerProfileDraft): number {
  return completedSteps(draft).size / INPUT_STEPS.length
}

export function nextStep(step: StepNumber): StepNumber {
  return Math.min(step + 1, LAST_STEP) as StepNumber
}

export function prevStep(step: StepNumber): StepNumber {
  return Math.max(step - 1, 1) as StepNumber
}
