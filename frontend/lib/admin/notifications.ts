// 알림 발송 이력의 순수 로직(필터·재발송 반영).

import type {
  AdminNotificationChannel,
  AdminNotificationLog,
  AdminNotificationType,
} from "./types"

export interface AdminNotificationFilters {
  query: string // 수신 조직명 검색
  types: AdminNotificationType[] // 빈 배열 = 전체(ADMIN_NOTIFICATION_TYPES 전체)
  channels: AdminNotificationChannel[] // 빈 배열 = 전체(인앱/이메일)
  failedOnly: boolean // 미전달만 — 재발송 대상 추리기
}

export const EMPTY_NOTIFICATION_FILTERS: AdminNotificationFilters = {
  query: "",
  types: [],
  channels: [],
  failedOnly: false,
}

export function filterNotifications(
  rows: AdminNotificationLog[],
  filters: AdminNotificationFilters,
): AdminNotificationLog[] {
  const q = filters.query.trim().toLowerCase()
  const types = new Set(filters.types)
  const channels = new Set(filters.channels)
  return rows.filter((r) => {
    const matchesQuery = !q || r.recipient_org_name.toLowerCase().includes(q)
    const matchesType = types.size === 0 || types.has(r.type)
    const matchesChannel = channels.size === 0 || channels.has(r.channel)
    const matchesFailed = !filters.failedOnly || !r.delivered
    return matchesQuery && matchesType && matchesChannel && matchesFailed
  })
}

// 최신 발송이 위(발송 이력은 시간 역순이 기본 독법).
export function sortNotificationsByRecent(rows: AdminNotificationLog[]): AdminNotificationLog[] {
  return [...rows].sort((a, b) => b.sent_at.localeCompare(a.sent_at))
}

// 수동 재발송 반영(낙관적) — 발송 시각을 갱신하고 재발송 횟수를 올린다.
// 재발송은 성공을 가정하지 않는다: delivered는 서버 응답이 정하며, 목업은 전달 성공으로 둔다.
export function applyResend(log: AdminNotificationLog, at: string): AdminNotificationLog {
  return { ...log, sent_at: at, delivered: true, resend_count: log.resend_count + 1 }
}
