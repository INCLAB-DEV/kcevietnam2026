// NT-001 알림 인박스 도메인 타입 (F-NT-001 / ADR-0010).
// notifications 행은 Organization 공유 인박스 — org당 1행, 읽음(read_at)도 org 공유.
// payload 는 통지 당시 표시 데이터 "스냅샷"(불변 기록) — 미팅이 사후 변경돼도 보존.

import type { NotificationType } from "@/lib/home/notification"

export type { NotificationType }

// 신청/취소 주체 역할 (대칭 신청 주체 — meetings.requested_by 와 동일 축).
export type CounterpartRole = "exhibitor" | "buyer" | "organizer"

// 타입별 payload 스냅샷 스키마 (F-NT-001 "타입별 payload 스냅샷 스키마").
export interface MeetingRequestedPayload {
  counterpartOrgName: string
  requestedByRole: CounterpartRole
}
export interface MeetingAcceptedPayload {
  counterpartOrgName: string
  scheduledStart: string // ISO8601 (KST offset 포함)
  venueLabel: string | null
}
export interface MeetingCancelledPayload {
  counterpartOrgName: string
  scheduledStart: string | null
  cancelledByRole: CounterpartRole
}
// 미팅 거절 통지(GitHub #4) — 거절 사유는 1차에서 미노출(상대 기업명·제안했던 시간만).
export interface MeetingRejectedPayload {
  counterpartOrgName: string
  scheduledStart: string | null
}
export interface MeetingReminderPayload {
  counterpartOrgName: string
  scheduledStart: string
  venueLabel: string | null
}
export interface ReviewPromptPayload {
  counterpartOrgName: string
}
// 비동기 전사·구조화가 끝나 회의록 초안이 준비됐다는 통지. 딥링크로 회의록 화면 복귀.
export interface ReviewReadyPayload {
  counterpartOrgName: string
}
// 신청 승인 완료 통지 — 상대 기업이 아니라 **내 기업**의 표시 정보(다른 5종과 다름, meeting_id 없음).
export interface ApplicationApprovedPayload {
  orgName: string
  role: CounterpartRole
}

// 공통 알림 행 메타 (recipient_org_id, read_at, read_by_member 등).
interface NotificationBase {
  id: string
  recipientOrgId: string
  // 딥링크·조인용 (ADR-0010 meetings FK). null=미팅 비연계 통지(운영자 직접 발송 등, 실 백엔드 계약) —
  // notificationHref가 /notifications로 폴백한다(lib/home/notification.ts와 동일 규칙).
  meetingId: string | null
  createdAt: string // ISO8601 (KST offset 포함) — 인박스 시간순 정렬 기준
  // org 공유 읽음: 한 멤버가 읽으면 행이 읽음 처리되고 org 전체가 같은 상태를 본다.
  readAt: string | null
  readByMemberName: string | null // 읽은 주체 표시("읽음: 시각, 멤버")
}

// type 으로 판별되는 합집합 — type 과 payload 스키마가 항상 일치하도록 강제.
export type NotificationItem =
  | (NotificationBase & { type: "meeting_requested"; payload: MeetingRequestedPayload })
  | (NotificationBase & { type: "meeting_accepted"; payload: MeetingAcceptedPayload })
  | (NotificationBase & { type: "meeting_cancelled"; payload: MeetingCancelledPayload })
  | (NotificationBase & { type: "meeting_reminder"; payload: MeetingReminderPayload })
  | (NotificationBase & { type: "review_prompt"; payload: ReviewPromptPayload })
  | (NotificationBase & { type: "review_ready"; payload: ReviewReadyPayload })
  | (NotificationBase & { type: "application_approved"; payload: ApplicationApprovedPayload })
  | (NotificationBase & { type: "meeting_rejected"; payload: MeetingRejectedPayload })

// 필터 선택값: 8종 + 전체.
export type NotificationFilter = NotificationType | "all"

// 인박스 한 페이지(커서 페이지네이션) — 실 세션의 서버 초기 fetch(http-inbox-client)와 클라
// "더보기" fetch(inbox-actions)가 공유하는 응답 형태. unreadCount는 페이지 크기와 무관하게
// org 전체 기준(백엔드 계약)이라 최신 페이지 응답값이 항상 이전 값을 덮어써도 안전하다.
export interface NotificationInboxPage {
  items: NotificationItem[]
  unreadCount: number
  nextCursor: string | null
}
