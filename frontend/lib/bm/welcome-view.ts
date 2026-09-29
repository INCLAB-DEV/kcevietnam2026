// 입장 전 랜딩(/welcome, HM-002)의 상태 매핑 — 순수 함수(FE ADR-0002 매트릭스).
// 입력 (application_status, 신청기간 개폐) → 화면 enum 하나로 떨어진다. 페이지는 결과만 렌더.
// 데이터층 진실원천은 organization_event_roles.application_status(ADR-0009). nav 진입은 approved
// AND 신청기간 종료 — 그 판정은 route-guard 소관이고, 여기선 "입장 전 화면에 뭘 보여줄지"만 고른다.

import type { ApplicationStatus } from "./types"

export type WelcomeView =
  | "write-form" // registered · 신청기간 중 → 신청서 작성하기
  | "changes-requested" // changes_requested · 신청기간 중 → 보완 후 재제출(+사유)
  | "under-review" // submitted → 주최국 확인 중(제출 후 잠금, 읽기전용)
  | "meeting-waiting" // approved · 신청기간 중 → 미팅 신청 대기중(입장 전)
  | "enter-service" // approved · 신청기간 종료 → 본 서비스 입장
  | "rejected" // rejected → 반려 안내 + 주최측 문의(종단)
  | "closed" // registered/changes_requested · 신청기간 종료 → 신청 마감

// 신청기간은 3국면이다: 시작 전(before) · 중(open) · 종료(closed). open 불리언 하나로는 before와
// closed를 구분 못 해, approved+시작전이 enter-service로 본 서비스 입장 동선을 타 리다이렉트 루프가 났다
// (route-guard는 closed일 때만 nav 허용). 그래서 open·closed를 둘 다 받아 enter-service는 'closed'에만
// 매핑하고, 시작 전(approved·before)은 안전하게 meeting-waiting(대기)으로 둔다.
export function resolveWelcomeView(
  status: ApplicationStatus,
  period: { open: boolean; closed: boolean },
): WelcomeView {
  switch (status) {
    case "approved":
      // 승인=즉시 입장(2026-09-09 정책 변경). 기간과 무관하게 본 서비스 입장 동선으로.
      return "enter-service"
    case "submitted":
      // 제출 후 잠금(읽기전용) — 기간과 무관하게 검토 대기. 수정은 운영이 changes_requested로 돌려보낼 때만.
      return "under-review"
    case "rejected":
      return "rejected"
    case "registered":
      return period.open ? "write-form" : "closed"
    case "changes_requested":
      return period.open ? "changes-requested" : "closed"
  }
}
