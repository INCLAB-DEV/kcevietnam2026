// 비즈매칭 승인 게이트 상태머신 — 단일 정본 (bm-profile-fields §6, ADR-0009).
// 전이: registered → submitted → {approved | changes_requested | rejected},
//       changes_requested → submitted(재제출). approved/rejected 종단.
// ⚠ 매칭/배정 노출·"비즈매칭 참가자"는 approved 부터다. submitted 는 검토 대기(아직 참가자 아님).
// 모든 컨텍스트(auth/bm/apply/organizer)는 이 모듈을 단일 출처로 import 한다 — 값 분기는
// 직접 문자열 비교(=== "submitted") 대신 아래 술어를 쓴다(코드 분산 방지, codex P1).

export type ApplicationStatus =
  | "registered" // 명단만 적재됨(아직 비즈매칭 신청서 미작성)
  | "submitted" // 신청서 제출 완료, 운영 승인 대기(검토 대기)
  | "changes_requested" // 운영이 보완 요청(사용자 재작성·재제출 필요)
  | "approved" // 운영 승인 완료 → 매칭 노출(= 비즈매칭 참가자)
  | "rejected" // 운영 반려(종단)

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "registered",
  "submitted",
  "changes_requested",
  "approved",
  "rejected",
]

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  registered: "등록자",
  submitted: "검토 대기",
  changes_requested: "보완 요청",
  approved: "비즈매칭 참가자",
  rejected: "반려",
}

// 매칭/배정 노출 + "비즈매칭 참가자" 판정의 단일 기준 — approved 만(ADR-0009, bm-profile-fields §6).
// route-guard·OP-002 리스트·매칭 쿼리는 전부 이 술어로 판정한다("submitted 이상" 같은 문자열 비교 금지).
export function isMatchingExposed(s: ApplicationStatus): boolean {
  return s === "approved"
}

// 활성(미반려) 신청서가 있는지 — 요약 화면 노출 기준. registered=미제출, rejected=반려(종단·별도 안내)라
// 둘 다 제외하고, 제출 이력 중 "진행 중/승인"만 true. 매칭 노출(isMatchingExposed)과는 별개 — submitted 도
// "내 신청 요약"은 보되 매칭엔 안 뜬다(codex P2: rejected 제외 의도를 주석으로 명시).
export function hasApplication(s: ApplicationStatus): boolean {
  return s === "submitted" || s === "changes_requested" || s === "approved"
}

// 운영 검토 대기(승인/반려/보완요청 액션 대상) — submitted 만.
export function canReview(s: ApplicationStatus): boolean {
  return s === "submitted"
}

// 사용자가 (재)작성할 수 있는 상태 — 미작성이거나 보완요청 받은 경우.
export function canEdit(s: ApplicationStatus): boolean {
  return s === "registered" || s === "changes_requested"
}
