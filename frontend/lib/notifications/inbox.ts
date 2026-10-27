// NT-001 알림 인박스 순수 로직 (F-NT-001 / #45).
// 외부 동작만 다룬다: 시간순 정렬·type 필터·안읽음 카운트·org 공유 읽음·모바일 리마인더 상단.
// now / readAt 등 시각은 주입받는다(Date.now 하드코딩 금지 — route-guard 와 동일 규칙).
//
// 문구·라벨은 messages/{ko,en}.json의 notifications 네임스페이스(키 무결성 테스트:
// lib/i18n/messages.test.ts)에서 조립한다 — 이 모듈은 next-intl 런타임 없이 테스트할 수 있도록
// 최소 Translator 형태를 호출부(NotificationInbox)에서 주입받는다(home/notification-composer.ts와
// 동일 패턴).

import { notificationHref } from "@/lib/home/notification"
import type {
  NotificationFilter,
  NotificationItem,
  NotificationType,
} from "./types"

export { notificationHref }

export type Translator = (key: string, values?: Record<string, string | number>) => string

// 필터 탭 값 (전체 + 8종). 표시 순서 고정 — 라벨은 t("notifications.filters.*")로 조립.
const FILTER_VALUES: NotificationFilter[] = [
  "all",
  "meeting_requested",
  "meeting_accepted",
  "meeting_cancelled",
  "meeting_rejected",
  "meeting_reminder",
  "review_prompt",
  "review_ready",
  "application_approved",
]

const FILTER_KEY: Record<NotificationFilter, string> = {
  all: "all",
  meeting_requested: "meetingRequested",
  meeting_accepted: "meetingAccepted",
  meeting_cancelled: "meetingCancelled",
  meeting_rejected: "meetingRejected",
  meeting_reminder: "meetingReminder",
  review_prompt: "reviewPrompt",
  review_ready: "reviewReady",
  application_approved: "applicationApproved",
}

export function notificationFilters(t: Translator): { value: NotificationFilter; label: string }[] {
  return FILTER_VALUES.map((value) => ({ value, label: t(`filters.${FILTER_KEY[value]}`) }))
}

const TYPE_KEY: Record<NotificationType, string> = {
  meeting_requested: "meetingRequested",
  meeting_accepted: "meetingAccepted",
  meeting_cancelled: "meetingCancelled",
  meeting_rejected: "meetingRejected",
  meeting_reminder: "meetingReminder",
  review_prompt: "reviewPrompt",
  review_ready: "reviewReady",
  application_approved: "applicationApproved",
}

export function notificationTypeLabel(type: NotificationType, t: Translator): string {
  return t(`typeLabels.${TYPE_KEY[type]}`)
}

// payload 스냅샷으로 인박스 행 문구를 만든다. 통지 당시 데이터만 쓴다(미팅 사후조회 금지).
// application_approved는 counterpartOrgName이 아니라 orgName(내 기업)을 쓴다 — case별로 분기.
export function notificationMessage(item: NotificationItem, t: Translator): string {
  switch (item.type) {
    case "meeting_requested":
      return t("messages.meetingRequested", { org: item.payload.counterpartOrgName })
    case "meeting_accepted":
      return t("messages.meetingAccepted", { org: item.payload.counterpartOrgName })
    case "meeting_cancelled":
      return t("messages.meetingCancelled", { org: item.payload.counterpartOrgName })
    case "meeting_reminder":
      return t("messages.meetingReminder", { org: item.payload.counterpartOrgName })
    case "review_prompt":
      return t("messages.reviewPrompt", { org: item.payload.counterpartOrgName })
    case "review_ready":
      return t("messages.reviewReady", { org: item.payload.counterpartOrgName })
    case "application_approved":
      return t("messages.applicationApproved", { org: item.payload.orgName })
    case "meeting_rejected":
      return t("messages.meetingRejected", { org: item.payload.counterpartOrgName })
  }
}

// 최신순(createdAt 내림차순). 원본 불변.
export function sortByNewest(items: NotificationItem[]): NotificationItem[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// type 필터 ("all"=전체). 정렬은 하지 않는다(호출부가 sortByNewest 와 조합).
export function filterByType(
  items: NotificationItem[],
  filter: NotificationFilter,
): NotificationItem[] {
  if (filter === "all") return items
  return items.filter((n) => n.type === filter)
}

// org 안읽음 개수 (nav 벨 배지). readAt === null 인 행 수.
export function unreadCount(items: NotificationItem[]): number {
  return items.reduce((n, item) => (item.readAt === null ? n + 1 : n), 0)
}

// org 공유 읽음: 한 멤버가 읽으면 그 행이 읽음 처리되고 org 전체가 같은 상태를 본다.
// 이미 읽힌 행은 read_by/read_at 을 덮어쓰지 않는다(최초 읽은 주체·시각 보존).
export function markAsRead(
  items: NotificationItem[],
  notificationId: string,
  memberName: string,
  readAt: string,
): NotificationItem[] {
  return items.map((item) => {
    if (item.id !== notificationId || item.readAt !== null) return item
    return { ...item, readAt, readByMemberName: memberName }
  })
}

// 모두 읽음: 안읽음 행만 같은 readAt/멤버로 읽음 처리. 이미 읽힌 행은 보존.
export function markAllAsRead(
  items: NotificationItem[],
  memberName: string,
  readAt: string,
): NotificationItem[] {
  return items.map((item) =>
    item.readAt === null ? { ...item, readAt, readByMemberName: memberName } : item,
  )
}

// 인박스 행 깊은 복사 — 스토어 변형이 픽스처 시드를 오염시키지 않도록.
// payload 재spread 시 판별 합집합(type↔payload)이 넓어져 단언으로 상관관계를 유지한다.
export function cloneNotification(item: NotificationItem): NotificationItem {
  return { ...item, payload: { ...item.payload } } as NotificationItem
}

// 모바일 상단 버블업: 안읽은 10분 리마인더만, 최신순. 현장 시급 신호.
export function pinnedReminders(items: NotificationItem[]): NotificationItem[] {
  return sortByNewest(items.filter((n) => n.type === "meeting_reminder" && n.readAt === null))
}
