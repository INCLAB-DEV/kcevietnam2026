// HM-001 블록 ④ 알림. Notification은 내 기업에 도착한 도메인 통지(ADR-0010 / F-NT-001).
// 홈에서는 그룹핑 없이 최신 N개를 리스트로 노출한다.

// 알림 8종 (ADR-0010 type enum / F-NT-001 payload 스키마).
export type NotificationType =
  | "meeting_requested" // 미팅 신청받음
  | "meeting_accepted" // 내 신청 수락됨
  | "meeting_cancelled" // 미팅 취소됨
  | "meeting_reminder" // 10분 리마인더
  | "review_prompt" // 회의록 입력 안내
  | "review_ready" // 회의록 정리 완료(AI 전사·구조화 끝남) — 비동기 전사 완료 통지
  | "application_approved" // 신청 승인 완료 — 미팅 비연계(meetingId null), 홈으로 이동
  | "meeting_rejected" // 내 신청이 거절됨(GitHub #4) — 신청한 쪽(요청자 org)에게만 간다

export interface Notification {
  id: string
  type: NotificationType
  // 딥링크·조인용 (ADR-0010 meetings FK). null=미팅 비연계 통지(실 백엔드 계약, 운영자 직접 발송 등) —
  // notificationHref가 /notifications로 폴백한다.
  meetingId: string | null
  message: string
  createdAt: string // ISO8601 (KST offset 포함)
}

// 리뷰(회의록) 화면으로 보내야 하는 타입 — 화이트리스트. 여기 없는 타입(미래에 계약이 늘어난
// 경우 포함)은 전부 타임라인으로 떨어진다: 모르는 알림을 조용히 회의록 작성 화면으로 보내는 것보다
// 목록에서 해당 미팅을 보여주는 쪽이 안전한 기본값이다.
const REVIEW_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "review_prompt", // 회의록 입력 안내
  "review_ready", // AI 전사·구조화 완료 → 초안 확인·저장
])

// 딥링크 타깃 (F-NT-001 딥링크 절 정정).
//
// 라우트 실체(docs/page-list.csv):
//   /meetings      = MY-001 내 미팅 타임라인 — 수락/거절/취소 등 미팅 라이프사이클 액션이 여기 있다.
//   /meetings/:id  = MY-002 **미팅 리뷰(회의록)** 화면. "미팅 상세"가 아니다.
//
// 예전엔 6종 전부를 /meetings/:id 로 보냈다. 그 결과 "미팅 신청받음" 알림을 눌러도 수락 화면이
// 아니라 회의록 작성 화면(ReviewFlow)이 떴다 — 실 배포에서 확인된 오배송. 리뷰 계열만 리뷰
// 라우트로 보내고, 라이프사이클 계열은 타임라인에서 그 미팅이 선택된 상태(?meeting=:id)로 보낸다.
// 컨텍스트 복귀를 위해 from=notifications 부여. meetingId가 없으면(미팅 비연계) 인박스로 폴백.
export function notificationHref(n: Pick<Notification, "type" | "meetingId">): string {
  if (n.type === "application_approved") return "/" // 승인 완료 — 미팅 비연계, 홈에서 새로 들어온 접근을 안내
  if (!n.meetingId) return "/notifications"
  const id = encodeURIComponent(n.meetingId)
  if (REVIEW_TYPES.has(n.type)) return `/meetings/${id}?from=notifications`
  return `/meetings?meeting=${id}&from=notifications`
}

// 최신순(createdAt 내림차순)으로 정렬해 limit개까지 반환. 원본은 변형하지 않는다.
export function latestNotifications(all: Notification[], limit = 5): Notification[] {
  return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
}
