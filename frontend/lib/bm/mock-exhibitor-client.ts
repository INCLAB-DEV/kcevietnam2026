// 참가사 프로필 mock 클라이언트 — 백엔드(#26 FastAPI) 계약을 그대로 흉내낸다.
// TODO(실연동): NEXT_PUBLIC_BM_API_BASE 설정 시 http-exhibitor-client 로 교체(엔드포인트 구현됨):
//   GET   /api/bm/exhibitor/{id}
//   PATCH /api/bm/exhibitor/{id}/steps/{step}   (부분 저장)
//   POST  /api/bm/exhibitor/{id}/submit         (원자적 제출 → submitted)
// 인메모리 스토어는 데모 세션 동안만 유지(새 새로고침=초기화). 실연동 시 RDS 가 단일 소스.

import type {
  EditableStep,
  ExhibitorProfile,
  ExhibitorProfileClient,
  ExhibitorStepPatch,
} from "./types"
import { applyStepPatch, cleanProducts, PRODUCTS_STEP } from "./profile-form-state"

const STORE = new Map<string, ExhibitorProfile>()

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

// 명단에만 있는 등록자의 초기 상태 — registered, 기업명만 명단에서 prefill 가능(데모는 비움).
function blankProfile(orgEventRoleId: string): ExhibitorProfile {
  return {
    orgEventRoleId,
    applicationStatus: "registered",
    availableLanguages: [],
    orgTypes: [],
    products: [],
    exhibitionCategories: [],
    attendees: [],
    recommendedBuyers: [],
  }
}

function load(orgEventRoleId: string): ExhibitorProfile {
  return STORE.get(orgEventRoleId) ?? blankProfile(orgEventRoleId)
}

// 단계 PATCH 적용 — applyStepPatch 로 그 단계 키만 병합(다른 단계 불변). 제품은 빈 줄 제거.
function merge(
  base: ExhibitorProfile,
  step: EditableStep,
  patch: ExhibitorStepPatch,
): ExhibitorProfile {
  const next = applyStepPatch(base, step, patch) as ExhibitorProfile
  if (step === PRODUCTS_STEP && patch.products !== undefined) {
    next.products = cleanProducts(patch.products)
  }
  return { ...base, ...next, orgEventRoleId: base.orgEventRoleId }
}

export const mockExhibitorClient: ExhibitorProfileClient = {
  async getProfile(orgEventRoleId) {
    return delay(structuredClone(load(orgEventRoleId)), 200)
  },

  async saveStep(orgEventRoleId, step, patch) {
    const updated = merge(load(orgEventRoleId), step, patch)
    STORE.set(orgEventRoleId, updated)
    return delay(structuredClone(updated), 350)
  },

  async submit(orgEventRoleId, patch) {
    let base = load(orgEventRoleId)
    // 제출 시 최종 편집(선택)은 전 단계 합집합 — 각 단계에 흩어 적용(부분 저장과 동일 의미).
    if (patch) {
      for (const step of [1, 2, 3, 4] as EditableStep[]) {
        base = merge(base, step, patch)
      }
    }
    // 원자적 승격(ADR-0009 D6): 저장 + 상태 전환을 한 번에. 이미 submitted/approved 면 유지(멱등).
    const status =
      base.applicationStatus === "registered" || base.applicationStatus === "changes_requested"
        ? "submitted"
        : base.applicationStatus
    const submitted: ExhibitorProfile = { ...base, applicationStatus: status }
    STORE.set(orgEventRoleId, submitted)
    return delay(structuredClone(submitted), 500)
  },
}

// 테스트 격리용 — 인메모리 스토어 초기화.
export function __resetExhibitorStore() {
  STORE.clear()
}
