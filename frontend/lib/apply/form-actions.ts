// BM-001 — draft 단계 저장의 서버 호출(클라 → POST /api/buyer-profile). ApplyForm이 단계 이동/
// 나가기 때 부른다. 계약·에러 코드는 app/api/buyer-profile/route.ts(및 docs/REFACTORING.md §4)와
// 짝을 이룬다. FastAPI 연동 시에도 이 시그니처는 유지되고 라우트 내부만 바뀐다.

import { stepPatch, type StepNumber } from "./form-state"
import type { BuyerProfileDraft } from "./types"

export interface SaveStepResult {
  success: boolean
  // 실패 시 서버 에러 코드(unauthenticated/forbidden/locked/invalid_*) 또는 "network".
  error?: string
}

// 현재 단계의 소유 필드만 골라 서버에 부분저장한다. 실패해도 던지지 않는다 —
// 저장은 로컬 store(복구 소스)에 이미 됐고, 호출측은 결과로 토스트만 띄운다(UX 비차단).
export const saveStepToServer = async (
  step: StepNumber,
  draft: BuyerProfileDraft,
): Promise<SaveStepResult> => {
  try {
    const res = await fetch("/api/buyer-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, draft: stepPatch(step, draft) }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true }
  } catch {
    return { success: false, error: "network" }
  }
}

export interface SubmitResult {
  success: boolean
  // 실패 시 서버 에러 코드: validation_failed(422)·submit_blocked(409)·unauthenticated 등, 또는 "network".
  error?: string
}

// 최종 제출(WL-001) — 클라 store의 최종 draft를 실어 보내고 서버가 검증·전이한다.
// 부분저장과 달리 제출 실패는 플로우를 막는다 — 호출측이 결과를 보고 진행/중단을 정한다.
export const submitProfileToServer = async (
  draft?: BuyerProfileDraft,
): Promise<SubmitResult> => {
  try {
    const res = await fetch("/api/buyer-apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft ? { draft } : {}),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true }
  } catch {
    return { success: false, error: "network" }
  }
}
