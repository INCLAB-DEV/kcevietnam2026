// /notifications 인박스의 실 세션 뮤테이션·페이지네이션 — lib/meeting/meeting-actions.ts와 같은
// 패턴: 같은 출처 BFF(app/api/notifications/[[...path]]) 경유로 FastAPI에 보낸다. 인증 헤더는
// 여기가 아니라 BFF가 붙인다(경계 B, ADR-0001). 클라 안전(정적 import에 서버 전용 모듈 없음) —
// notification-composer.ts는 순수 함수라 클라 번들에 들어가도 안전하다(mock 픽스처를 끌고 오지 않음).

import { toInboxItem, type NotificationOutSnake } from "@/lib/home/notification-composer"
import type { NotificationInboxPage } from "./types"

interface InboxResponseSnake {
  items: NotificationOutSnake[]
  unread_count: number
  next_cursor: string | null
}

// 단건 읽음. 백엔드가 갱신된 NotificationOut을 돌려주지만(읽은 시각·member id), 표시용 이름은
// 아직 계약 밖이라(read_by_member_name 롤아웃 중) 호출부가 이미 아는 "지금 읽은 사람"(현재 세션
// 멤버명)으로 낙관적 갱신한다 — 실패 시 호출부가 되돌린다.
export async function markNotificationReadHttp(notificationId: string): Promise<boolean> {
  const res = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" })
  return res.ok
}

// 전체 읽음. 응답은 { updated_count }뿐이라(갱신된 행 목록 없음) 호출부가 낙관적으로 로컬 상태를
// 반영한다(mock 모드의 markAllNotificationsRead와 동일 사용자 경험).
export async function markAllNotificationsReadHttp(): Promise<boolean> {
  const res = await fetch("/api/notifications/read-all", { method: "POST" })
  return res.ok
}

// 더보기 — next_cursor로 다음 페이지 조회. recipientOrgId는 렌더 로직이 읽지 않는 메타값이라
// 호출부의 현재 세션 org를 그대로 채운다(http-inbox-client.ts의 서버 초기 fetch와 동일 규칙).
export async function fetchNotificationPageHttp(
  recipientOrgId: string,
  cursor: string,
  limit = 30,
): Promise<NotificationInboxPage | null> {
  const qs = new URLSearchParams({ limit: String(limit), cursor })
  const res = await fetch(`/api/notifications?${qs.toString()}`)
  if (!res.ok) return null
  const data = (await res.json()) as InboxResponseSnake
  return {
    items: data.items.map((item) => toInboxItem(item, recipientOrgId)),
    unreadCount: data.unread_count,
    nextCursor: data.next_cursor,
  }
}
