// acceptance-rule (F-OP-005 / F-OP-003 / ADR-0005) — 받는 쪽 유형 → 진입 상태 결정 규칙.
//
// 운영자는 수락 상태(accepted/proposed)를 손으로 고르지 않는다. 매칭은 항상 바이어↔참가사 쌍이며,
// 미팅의 진입 상태는 "받는 쪽(바이어) 유형"이 자동 결정한다:
//   초청(hosted) 바이어  → immediate(accepted) 즉시 확정 — 의무 미팅, 거부 단계 없음(전 채널 동일)
//   그 외(사전등록·현장) → pending(proposed) 수락대기 — 받는 쪽이 수락/거절
//
// provenance(누가 만들었나: Forced / AI / Open)와 수락 규칙(받는 쪽이 누구냐)은 독립 축이다(ADR-0005 D6).
// Forced·전체 포화배정·단일 재트리거가 이 규칙을 공유한다. 실연동 시 진입 상태 판정은 백엔드
// (acceptance_rule.py)가 단일 소유하고(ADR-0008), 이 모듈은 그 규칙의 FE 미러(미리보기·목업)다.
// 기존 MT-001의 mock-availability.ts(acceptanceModeFor)와 같은 해석 — 초청 바이어만 즉시 확정.
//
// 채널 세부(전체 포화배정의 참가사 자동확정 vs Forced의 참가사도 수락 측)는 "누가 수락하느냐"의
// 백엔드 내부 사정이며, 미팅의 진입 상태는 두 채널 모두 위 바이어 유형 규칙으로 동일하게 갈린다.

import type { AcceptanceMode } from "@/lib/meeting/types"
import type { BuyerType } from "@/lib/types"

type BuyerLike = { buyerType?: BuyerType }

// 받는 쪽(바이어) 유형 → 진입 상태. 초청 바이어만 즉시 확정, 나머지는 수락대기.
export function resolveAcceptance(buyer: BuyerLike): AcceptanceMode {
  return buyer.buyerType === "hosted" ? "immediate" : "pending"
}

// 즉시 확정이 되는가 — 초청 바이어일 때만 true. 일반(사전등록·현장) 바이어를 운영자가 강제로
// immediate로 만드는 경로는 의도적으로 존재하지 않는다(일반 바이어 강제 확정 불가, ADR-0005).
export function canForceImmediate(buyer: BuyerLike): boolean {
  return buyer.buyerType === "hosted"
}

// 미리보기 카피 — 운영자가 배정 버튼을 누르기 전에 보는 예상 결과(F-OP-005 D4).
export interface AcceptancePreview {
  mode: AcceptanceMode
  label: string // 결과 상태 라벨
  detail: string // 한 줄 설명
}

export function acceptancePreview(buyer: BuyerLike): AcceptancePreview {
  if (resolveAcceptance(buyer) === "immediate") {
    return {
      mode: "immediate",
      label: "즉시 확정",
      detail: "초청 바이어 의무 미팅 — 양측 일정에 바로 추가되며 거부 단계가 없습니다.",
    }
  }
  return {
    mode: "pending",
    label: "수락대기",
    detail: "받는 쪽이 수락하면 확정됩니다 — 동의 없이 일정이 잡히지 않습니다.",
  }
}
