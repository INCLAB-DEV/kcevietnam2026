// NT-001 알림 인박스 스토어 (org 공유). 순수 데이터 계층 — React 훅은 use-notifications.ts(클라)로 분리해
// 이 모듈을 서버 컴포넌트(api-client seam 경유)에서도 import 할 수 있게 한다.
// nav 벨 배지와 /notifications 인박스가 같은 스토어를 구독 → 한쪽에서 읽음 처리하면 즉시 양쪽 반영.
// 스냅샷은 변경 전까지 같은 배열 참조를 돌려줘(ensure) 구독자 무한 렌더를 막는다.
// TODO(#44/#45): 실연동 시 이 스토어를 FastAPI 응답 캐시(SWR/React Query 등)로 교체.

import { markAllAsRead, markAsRead, unreadCount } from "./inbox"
import { seedNotifications } from "./mock"
import type { NotificationItem } from "./types"

const byOrg = new Map<string, NotificationItem[]>()
const listeners = new Set<() => void>()

// org 인박스를 처음 요청하면 픽스처로 시드. 이후엔 같은 배열 참조를 유지(스냅샷 안정성).
function ensure(orgId: string): NotificationItem[] {
  let items = byOrg.get(orgId)
  if (!items) {
    items = seedNotifications(orgId)
    byOrg.set(orgId, items)
  }
  return items
}

function emit() {
  for (const listener of listeners) listener()
}

// 구독/스냅샷 — use-notifications.ts(클라)의 useSyncExternalStore가 쓴다.
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getNotifications(orgId: string): NotificationItem[] {
  return ensure(orgId)
}

// org 안읽음 개수 스냅샷 — nav 벨 배지용. orgId 없으면 0. (같은 입력 → 같은 수, 스냅샷 안정.)
export function getUnreadCount(orgId?: string): number {
  return orgId ? unreadCount(ensure(orgId)) : 0
}

// org 공유 읽음 — 새 배열로 교체하고 구독자에게 알림(배지·인박스 동시 갱신).
// readAt 기본값은 런타임 시각(I/O 경계). 테스트는 결정값을 주입한다.
export function markNotificationRead(
  orgId: string,
  notificationId: string,
  memberName: string,
  readAt: string = new Date().toISOString(),
): void {
  byOrg.set(orgId, markAsRead(ensure(orgId), notificationId, memberName, readAt))
  emit()
}

export function markAllNotificationsRead(
  orgId: string,
  memberName: string,
  readAt: string = new Date().toISOString(),
): void {
  byOrg.set(orgId, markAllAsRead(ensure(orgId), memberName, readAt))
  emit()
}

// 새 알림을 org 인박스 맨 앞에 추가하고 구독자에게 알림(배지·인박스 즉시 갱신).
// 데모 한정: 실연동에선 백엔드(#44/#45)가 알림 행을 생성한다 — 여기선 FE 가 완료 통지를 직접 띄운다
// (예: 비동기 전사 완료 시 "회의록 정리 완료"). 같은 id 가 이미 있으면 중복 추가하지 않는다.
export function pushNotification(orgId: string, item: NotificationItem): void {
  const items = ensure(orgId)
  if (items.some((n) => n.id === item.id)) return
  byOrg.set(orgId, [item, ...items])
  emit()
}

// 테스트 유틸 — 스토어 시드/초기화(모듈 전역 상태 격리).
export function seedNotificationStore(orgId: string, items: NotificationItem[]): void {
  byOrg.set(orgId, items)
  emit()
}
export function resetNotificationStore(): void {
  byOrg.clear()
  emit()
}
