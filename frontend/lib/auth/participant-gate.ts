// application_status + 프로필 존재로 "작성 유도 / 참가자 요약" 중 무엇을 보여줄지 판정.
// ADR-0009 게이트의 읽기 측. 요약 노출 = 프로필 존재 AND 신청서 제출 이력(hasApplication).
// ⚠ 매칭 노출(isMatchingExposed=approved)과는 별개 — submitted 도 요약은 보되 매칭엔 안 뜬다(#82, codex P1).
// 상태 타입·술어는 단일 정본 lib/application-status 에서 가져온다(분산 정의 제거).

import { type ApplicationStatus, hasApplication } from "@/lib/application-status"

export type { ApplicationStatus }

export interface ParticipantGateInput {
  applicationStatus: ApplicationStatus
  hasProfile: boolean
}

export type ParticipantGateView = "write-prompt" | "participant-summary"

export function resolveParticipantGate(input: ParticipantGateInput): ParticipantGateView {
  const showSummary = input.hasProfile && hasApplication(input.applicationStatus)
  return showSummary ? "participant-summary" : "write-prompt"
}
