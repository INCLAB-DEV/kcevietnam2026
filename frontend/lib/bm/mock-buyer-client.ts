// 바이어 프로필 mock 클라이언트 — lib/bm/mock-exhibitor-client.ts와 대칭(인터페이스 일치, ADR-0008
// seam 패턴). getBuyerClient(isReal)의 실=false 분기가 쓴다. 인메모리라 새로고침하면 초기화된다.
//
// ⚠ apply-form.tsx의 기존 mock 동작(비실세션)은 이 클라이언트가 아니라 여전히
// lib/apply/buyer-profile-store.ts(localStorage 기반, 이어쓰기 보존)를 그대로 쓴다 — "mock 모드는
// 기존 인메모리 동작 100% 보존" 원칙(BM-001 실배선 지시서). 이 파일은 getBuyerClient(isReal) 계약을
// exhibitor와 대칭으로 채우기 위한 구현으로, apply-form 외의 호출부가 realSession=false로 부를 때를
// 대비한 것이다.

import { emptyBuyerProfileDraft } from "@/lib/apply/types"
import type {
  BuyerEditableStep,
  BuyerProfileClient,
  BuyerProfileReadResult,
  BuyerStepPatch,
} from "@/lib/apply/types"

const STORE = new Map<string, BuyerProfileReadResult>()

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function blankProfile(): BuyerProfileReadResult {
  return { draft: emptyBuyerProfileDraft(), status: "registered" }
}

function load(orgEventRoleId: string): BuyerProfileReadResult {
  return STORE.get(orgEventRoleId) ?? blankProfile()
}

function merge(base: BuyerProfileReadResult, patch: BuyerStepPatch): BuyerProfileReadResult {
  return { status: base.status, draft: { ...base.draft, ...patch } }
}

export const mockBuyerClient: BuyerProfileClient = {
  async getProfile(orgEventRoleId) {
    return delay(structuredClone(load(orgEventRoleId)), 200)
  },

  async saveStep(orgEventRoleId, _step: BuyerEditableStep, patch) {
    const updated = merge(load(orgEventRoleId), patch)
    STORE.set(orgEventRoleId, updated)
    return delay(structuredClone(updated), 350)
  },

  async submit(orgEventRoleId, patch) {
    let base = load(orgEventRoleId)
    if (patch) base = merge(base, patch)
    // 원자적 승격(ADR-0009 D6): 이미 submitted/approved면 유지(멱등), rejected는 mock 단순화상 그대로 둔다.
    const status: BuyerProfileReadResult["status"] =
      base.status === "registered" || base.status === "changes_requested" ? "submitted" : base.status
    const submitted: BuyerProfileReadResult = { draft: base.draft, status }
    STORE.set(orgEventRoleId, submitted)
    return delay(structuredClone(submitted), 500)
  },
}

// 테스트 격리용 — 인메모리 스토어 초기화.
export function __resetBuyerStore() {
  STORE.clear()
}
