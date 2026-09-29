// forced-assignment (F-OP-005 D5/D6 / ADR-0005) — 운영자가 바이어+참가사+슬롯을 지정해 미팅 1건을 만든다.
//
// 출처(provenance)는 항상 'forced'로 박히며, 수락 규칙과 독립이다(ADR-0005 D6).
//
// **진입 상태: FORCED 채널은 바이어 유형과 무관하게 항상 accepted다**(2026-09-15 정정 — 발주자 QA
// 지적 B3 "관리자가 직접 배정하면 바로 확정이어야 한다"). 백엔드가 진실원천이고, 거기서도
// app/matching/acceptance_rule.resolve_entry_state가 FORCED를 최우선으로 분기해 EntryState.ACCEPTED를
// 준다 — 이 모듈은 그 결과를 낙관적 UI에 미리 반영하는 미러다(어긋나면 배정 직후 서버 진실로 덮인다).
//
// 바이어 유형 규칙(초청만 즉시 확정, 그 외 수락대기)은 폐기된 게 아니라 **다른 채널에 그대로 남는다**
// — AI 포화배정(saturation.ts)이 statusFromAcceptance를 계속 쓴다. 그래서 규칙 함수는 그대로 두고
// createForcedMeeting만 채널 규칙으로 고정한다.

import type { BuyerType, OrgRole } from "@/lib/types"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import { resolveAcceptance } from "./acceptance-rule"

// provenance(출처) — 누가 만든 매칭인가. 수락 규칙(받는 쪽 유형)과 독립 축(ADR-0005 D6).
//   forced=운영자 직접 지정 · ai=AI 배정(전체 포화/단일 재트리거) · open=쌍방 자유신청 · onsite=현장
export type MatchingType = "forced" | "ai" | "open" | "onsite"

// 운영자가 새로 만드는 미팅의 "진입 상태" — 받는 쪽 유형이 결정한다(ADR-0005). 전체 상태 흐름의 부분집합.
export type MeetingEntryStatus = "proposed" | "accepted"

// 배정된 미팅 1건(그리드 셀의 원천). 항상 바이어↔참가사 쌍 + 슬롯 + 상태 + 출처.
// 상태는 MY-001 내 미팅과 동일한 전체 팔레트(ScheduleStatus)를 쓴다 — 셀 색·라벨을 내 미팅과 정합시키려고.
// 운영자 생성분은 진입 상태(proposed/accepted)지만, 행사 진행에 따라 completed/cancelled/rejected도 들어온다.
// 노쇼는 별도 상태가 아니라 completed의 attended=false 결과 속성(ADR-0010).
export interface AssignmentMeeting {
  id: string
  exhibitorId: string
  buyerId: string
  slotId: string
  status: ScheduleStatus
  matchingType: MatchingType
  durationMinutes?: number // 소요시간(분, 30/60/90). 미지정=한 슬롯(span 1). 연속 슬롯 표현(F-MY-001 D4).
  attended?: boolean // completed의 결과 속성(false=노쇼). 그 외 상태에선 무의미.
  hasReview?: boolean // completed의 회의록 작성 여부(true=보관). 색 파생(orange↔blue).
  phantom?: boolean // 멀티슬롯 점유를 펼친 합성 레코드(빈슬롯 판정 전용 — 카운트·렌더에서 제외).
  venue?: string // 미팅 장소(부스/테이블/룸). 상세 슬라이드 표시용(내 미팅과 동일). 미지정 시 기본값.
  requestedByOrgId?: string // 신청 주체 org id — 상세 슬라이드의 방향(내가/상대가 신청)·액션 산출용(내 미팅 정합).
}

type OrgLike = { id: string; role: OrgRole; buyerType?: BuyerType }

// 수락 모드(immediate/pending) → 미팅 진입 상태(accepted/proposed). 받는 쪽 바이어 유형이 결정.
// FORCED가 아닌 채널(AI 포화배정 등)의 진입 상태 규칙 — createForcedMeeting은 이걸 쓰지 않는다.
export function statusFromAcceptance(buyer: Pick<OrgLike, "buyerType">): MeetingEntryStatus {
  return resolveAcceptance(buyer) === "immediate" ? "accepted" : "proposed"
}

// 운영자 강제 배정의 진입 상태 — 채널이 FORCED면 받는 쪽이 누구든 즉시 확정(위 모듈 주석).
export const FORCED_ENTRY_STATUS: MeetingEntryStatus = "accepted"

// 바이어+참가사+슬롯 → Forced 미팅 1건. 출처는 'forced' 고정, 진입 상태는 채널 규칙으로 즉시 확정.
// durationMinutes를 주면 그 길이(30/60/90 = 1/2/3칸)로 잡고, 안 주면 슬롯 한 칸이다.
// 역할이 어긋나면(바이어 자리에 참가사 등) 막는다 — 매칭은 바이어↔참가사 쌍만 유효(buyer↔seller).
export function createForcedMeeting(
  buyer: OrgLike,
  exhibitor: OrgLike,
  slot: string,
  id: string,
  durationMinutes?: number,
): AssignmentMeeting {
  if (buyer.role !== "buyer") throw new Error(`바이어 자리에는 바이어만 올 수 있습니다: ${buyer.id}`)
  if (exhibitor.role !== "exhibitor") {
    throw new Error(`참가사 자리에는 참가사만 올 수 있습니다: ${exhibitor.id}`)
  }
  return {
    id,
    exhibitorId: exhibitor.id,
    buyerId: buyer.id,
    slotId: slot,
    status: FORCED_ENTRY_STATUS,
    matchingType: "forced",
    ...(durationMinutes ? { durationMinutes } : {}),
  }
}
