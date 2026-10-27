"use client"

// NT-001 알림 인박스의 React 구독 훅 — useSyncExternalStore로 store.ts(순수 데이터)를 구독한다.
// nav 벨 배지와 /notifications 인박스가 같은 스토어를 구독 → 한쪽에서 읽음 처리하면 즉시 양쪽 반영.
// 데이터 계층(store.ts)과 분리해, 서버 컴포넌트는 store만 import하고 이 훅은 클라에서만 쓴다.

import { useSyncExternalStore } from "react"
import { getNotifications, getUnreadCount, subscribe } from "./store"
import type { NotificationItem } from "./types"

// org 인박스 전체를 구독 — 변경 시 재렌더. 스냅샷은 store가 안정 참조를 보장한다.
export function useNotifications(orgId: string): NotificationItem[] {
  const snapshot = () => getNotifications(orgId)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

// org 안읽음 개수를 구독 — nav 벨 배지용. orgId 없으면 0.
export function useUnreadCount(orgId?: string): number {
  const snapshot = () => getUnreadCount(orgId)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
