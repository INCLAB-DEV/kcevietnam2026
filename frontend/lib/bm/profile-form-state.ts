// profile-form-state — 5단계 진행/단계별 부분저장/이어쓰기/단계 검증을 캡슐화하는 순수 모듈.
// PRD F-BM-002 의 deep module(F-BM-001 바이어 측과 골격 공유 가능). UI 컴포넌트는 이 함수들로
// 단계 이동·완료 표시·제출 가능 여부를 결정한다 — 검증은 "관찰 가능한 외부 동작"만(폼 내부 상태 X).
//
// 핵심 규칙:
//   • 단계는 1~5(5=요약·제출). 편집은 1~4, 자유 이동(부분저장 드래프트라 미완 단계도 통과).
//   • 이어쓰기 = 저장된 프로필을 그대로 드래프트로 본다(applyStepPatch 로 한 단계만 병합).
//   • 사업자등록번호(businessRegNo)는 어떤 단계 완료 조건에도 들어가지 않는다(D4: 없어도 안 막힘).
//   • 목록(products·attendees·recommendedBuyers)은 전체 교체 — add/remove/update 헬퍼 제공.

// 검증 규칙 정본 — schemas.ts는 이 모듈에서 type만 가져가므로(런타임 순환 없음) 안전.
import { EXHIBITOR_STEP_SCHEMAS } from "./schemas"
import type {
  EditableStep,
  ExhibitorProfileDraft,
  ExhibitorStepPatch,
  Product,
  Step,
} from "./types"

export const TOTAL_STEPS = 5 as const
export const EDITABLE_STEPS: readonly EditableStep[] = [1, 2, 3, 4]
export const REVIEW_STEP: Step = 5

export interface StepMeta {
  step: Step
  // 단계 제목의 **메시지 키**(messages의 applyExhibitor.{titleKey}) — 제목 문구는 화면 로케일(ko/en)에서
  // 뽑는다. 예전엔 여기 국문 제목을 두고 화면은 따로 키 표를 뒀는데, 그러면 "이 문자열이 화면에 나가는가"를
  // 매번 따져야 한다.
  titleKey: string
  // 이 단계가 책임지는 드래프트 키(부분저장 PATCH 에 담기는 필드). 5단계는 편집 없음(요약).
  fields: (keyof ExhibitorProfileDraft)[]
}

export const STEP_META: readonly StepMeta[] = [
  {
    // 1 기본정보 = 행사 등록 시 입력한 정보(로스터 컬럼) 확인·수정 + 담당자(기본정보로 통합).
    step: 1,
    titleKey: "step1.title",
    fields: [
      "businessRegNo",
      "organizationNameKo",
      "organizationNameEn",
      "hall",
      "pavilion",
      "boothLocation",
      "boothType",
      "boothCount",
      "representativeNameKo",
      "representativeNameEn",
      "companyEmail",
      "mainTel",
      "fax",
      "zipCode",
      "addressKo",
      "addressDetail",
      "addressEn",
      "businessType",
      "businessItem",
      "attendees",
    ],
  },
  {
    // 2 회사소개 = 소개(국/영) + 보강정보(홈페이지·연매출·직원수·언어, 타겟→이관).
    step: 2,
    titleKey: "step2.title",
    fields: [
      "introKo",
      "introEn",
      "website",
      "annualSalesRange",
      "employeeRange",
      "availableLanguages",
    ],
  },
  {
    // 3 전시품목 (회사소개와 순서 교체). exhibitionCategories=사업분야(8, 멀티), contentCategory=
    // 카테고리(3, 단일선택) — 둘 다 이 단계 소관(ExhibitorStep3와 1:1).
    step: 3,
    titleKey: "step3.title",
    fields: ["products", "exhibitionCategories", "contentCategory"],
  },
  {
    // 4 타겟 (선호 바이어 국가/구분 + 미팅 가능 시간 — 모두 선택)
    step: 4,
    titleKey: "step4.title",
    fields: ["preferredBuyerCountries", "preferredBuyerTypes", "unavailableMeetingSlots"],
  },
  { step: 5, titleKey: "stepDone", fields: [] },
]

// 전시품목(제품 복수)이 들어가는 편집 단계 — 빈 제품행 정리 등 단계별 분기에 쓴다.
export const PRODUCTS_STEP: EditableStep = 3

export function isStep(value: unknown): value is Step {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

// 1~5 범위로 강제(벗어나면 1). ?step=N 진입(D3 딥링크)의 입력 정규화.
export function clampStep(value: number): Step {
  if (!Number.isFinite(value)) return 1
  const n = Math.trunc(value)
  if (n < 1) return 1
  if (n > TOTAL_STEPS) return TOTAL_STEPS
  return n as Step
}

// ?step= 쿼리(문자열|null) → 유효 단계. 숫자 아님/범위밖은 1로 폴백.
export function stepFromQuery(raw: string | null | undefined): Step {
  if (raw == null || raw.trim() === "") return 1
  const n = Number(raw)
  if (Number.isNaN(n)) return 1
  return clampStep(n)
}

export function nextStep(step: Step): Step {
  return clampStep(step + 1)
}

export function prevStep(step: Step): Step {
  return clampStep(step - 1)
}

// 한 단계의 PATCH 를 드래프트에 병합 — 그 단계 키만 덮어쓴다(다른 단계 불변, 부분저장 의미).
// 목록 필드는 통째로 교체(전체 교체 단위). 미제공 키는 그대로 보존(이어쓰기).
export function applyStepPatch(
  draft: ExhibitorProfileDraft,
  step: EditableStep,
  patch: ExhibitorStepPatch,
): ExhibitorProfileDraft {
  const allowed = new Set(STEP_META[step - 1].fields as string[])
  const merged: ExhibitorProfileDraft = { ...draft }
  for (const [key, value] of Object.entries(patch)) {
    // 단계 밖 키는 무시 — UI 버그로 엉뚱한 단계 필드가 새지 않게 막는다(서버 단계 모델과 동형).
    if (allowed.has(key)) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

// 한 단계의 PATCH 페이로드 추출 — 드래프트에서 그 단계가 책임지는 키만 골라낸다(부분저장 바디).
export function stepPatch(draft: ExhibitorProfileDraft, step: EditableStep): ExhibitorStepPatch {
  const out: ExhibitorStepPatch = {}
  for (const key of STEP_META[step - 1].fields) {
    const value = draft[key]
    if (value !== undefined) {
      ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

// 1단계 저장 PATCH에서 뺄 키 — 부스(Hall>관>부스위치>타입>개수)는 주최측 배정 스냅샷이라 UI가
// 두 모드(작성 폼·프로필 섹션 편집) 모두 읽기 전용으로 그린다. 드래프트의 stale 값으로 서버 값을
// 덮어쓰지 않도록 페이로드에서 뺀다(STEP_META[0].fields엔 조회용으로 남아 있다).
// 담당자(attendees)는 2026-09-12부터 1단계에서 직접 추가/수정/삭제할 수 있어 제외하지 않는다.
export const STEP1_SAVE_EXCLUDE_KEYS: readonly (keyof ExhibitorProfileDraft)[] = [
  "hall",
  "pavilion",
  "boothLocation",
  "boothType",
  "boothCount",
]

function omitKeys<T extends object>(obj: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = { ...obj }
  for (const key of keys) delete out[key]
  return out
}

// 한 단계의 **저장용** PATCH 바디 — stepPatch에 저장 시점의 정리 규칙을 얹은 단일 정본.
// 작성 폼(components/exhibitor/apply-form.tsx saveCurrentStep)과 프로필 섹션 편집
// (components/exhibitor/profile-section-edit-dialog.tsx)이 같은 페이로드를 보내도록 여기 모았다 —
// 두 경로가 갈라지면 한쪽만 부스를 덮어쓰거나 빈 제품 줄을 저장하는 회귀가 난다.
//   • 3단계(전시품목): 빈 제품 줄 제거(cleanProducts)
//   • 1단계(기본정보): 부스 스냅샷 제외(STEP1_SAVE_EXCLUDE_KEYS)
export function stepSavePayload(
  draft: ExhibitorProfileDraft,
  step: EditableStep,
): ExhibitorStepPatch {
  const patch = stepPatch(draft, step)
  if (step === PRODUCTS_STEP) {
    return { ...patch, products: cleanProducts(draft.products) }
  }
  if (step === 1) {
    return omitKeys(patch, STEP1_SAVE_EXCLUDE_KEYS)
  }
  return patch
}

// 저장 전에 단계 스키마(필수 게이트)를 검사하는 단계 — 작성 폼의 [다음]과 같은 기준.
// 1단계는 필수 항목이 회사명(국/영)뿐인데 그 둘이 UI에서 읽기 전용(회원가입/로스터 스냅샷)이라,
// 명단이 비어 있으면 사용자가 고칠 수 없는 이유로 저장이 막힌다 — 그래서 게이트에서 뺀다.
// 4단계는 전부 선택 항목이라 스키마가 항상 통과한다(굳이 넣지 않는다).
export const SAVE_VALIDATED_STEPS: readonly EditableStep[] = [2, 3]

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

// 제품 한 줄이 유효한가 — 제품명(국문)만 필수(User Story 7). 빈 줄은 저장에서 떨어뜨린다.
export function isProductValid(product: Product): boolean {
  return nonEmpty(product.nameKo)
}

// 저장 가능한 제품만(빈 줄 제거) — 목록 전체 교체 전에 정리.
export function cleanProducts(products: Product[] | undefined): Product[] {
  return (products ?? []).filter(isProductValid)
}

// 단계 완료 여부 — 진행 표시(체크)와 제출 게이트의 근거. 자유 이동은 막지 않되 "완성"만 표시.
// 규칙의 정본은 Zod 스키마(schemas.ts) 하나다 — 2026-07-06 이중화 해소. 요약(스키마와 동일):
// 1 기본정보 = 기업명 국/영, 2 회사소개 = 소개 국/영, 3 전시품목 = 유효 제품 1개+(영문명·
// 사업분야·HS코드)+사업분야 1개, 4 타겟 = 게이트 없음.
// ⚠ businessRegNo 는 어떤 조건에도 포함하지 않는다(D4: 미입력이어도 작성·제출 가능).
// ⚠ 담당자(attendees)도 제출 게이트가 아니다(2026-09-09, ADR-0012 개정: 셀프가입 0명 제출 허용).
export function isStepComplete(draft: ExhibitorProfileDraft, step: EditableStep): boolean {
  return EXHIBITOR_STEP_SCHEMAS[step].safeParse(draft).success
}

// 완료된 편집 단계 목록(진행 인디케이터용).
export function completedSteps(draft: ExhibitorProfileDraft): EditableStep[] {
  return EDITABLE_STEPS.filter((s) => isStepComplete(draft, s))
}

// 제출 가능 여부 — 모든 편집 단계가 완료여야 한다. businessRegNo 는 게이트 아님(D4).
// (부분저장 자체는 어느 단계든 가능; 이건 마지막 '제출' 버튼 활성 조건.)
export function canSubmit(draft: ExhibitorProfileDraft): boolean {
  return EDITABLE_STEPS.every((s) => isStepComplete(draft, s))
}

// ── 목록 편집 헬퍼(불변 업데이트) ───────────────────────────────────────────────
export function addItem<T>(list: T[] | undefined, item: T): T[] {
  return [...(list ?? []), item]
}

export function removeItem<T>(list: T[] | undefined, index: number): T[] {
  return (list ?? []).filter((_, i) => i !== index)
}

export function updateItem<T>(list: T[] | undefined, index: number, patch: Partial<T>): T[] {
  return (list ?? []).map((item, i) => (i === index ? { ...item, ...patch } : item))
}

export const EMPTY_PRODUCT: Product = { nameKo: "" }
