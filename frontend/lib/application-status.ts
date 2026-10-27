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

// 상태 라벨은 이 모듈에 두지 않는다(상태머신·술어만 소유) — 참가자 화면은 messages의 welcome.*,
// 운영자 콘솔(한국어 고정)은 lib/organizer/participant-labels.ts·members.ts의 라벨 표를 쓴다.

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

// 내 프로필(마이페이지) 탭에서 참가자가 **자기 신청서를 직접 고칠 수 있는** 상태 — 작성 폼 진입
// 게이트(canEdit)와 일부러 다르다. 승인 후 정정(approved, F-BM-004 D5 / F-BM-005: 승인된 프로필이
// 조회·항목별 수정의 대상)과 보완요청(changes_requested, 고쳐서 재제출)을 열고,
//   • submitted  → 잠금: 검토 중 내용이 바뀌면 검토 대상이 표류한다(FE ADR-0002 §3 제출 후 잠금)
//   • rejected   → 잠금: 종단 상태라 재제출 경로가 없다(ADR-0009, backend _guard_submittable_status)
// registered는 아직 작성 중이라 열어 둔다(주 동선은 작성 폼이지만 프로필 탭이 더 적을 이유가 없다).
// ⚠ 수정은 application_status를 건드리지 않는다 — 승인된 기업은 고쳐도 매칭 대상으로 남는다
// (F-BM-004 D5 비강등, 백엔드 PATCH가 상태를 전이시키지 않음: app/bm/service.py patch_*_step).
export function canSelfEditProfile(s: ApplicationStatus): boolean {
  return s === "registered" || s === "changes_requested" || s === "approved"
}
