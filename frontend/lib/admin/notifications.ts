// 알림 발송 이력의 순수 로직(필터·재발송 반영).

import {
  SKIP_REASON_EVENT_EMAIL_DISABLED,
  type AdminNotificationChannel,
  type AdminNotificationLog,
  type AdminNotificationType,
} from "./types"

export interface AdminNotificationFilters {
  query: string // 수신 조직명 검색
  types: AdminNotificationType[] // 빈 배열 = 전체(ADMIN_NOTIFICATION_TYPES 전체)
  channels: AdminNotificationChannel[] // 빈 배열 = 전체(인앱/이메일)
  failedOnly: boolean // 미전달만 — 재발송 대상 추리기(참가자 알림 메일이 꺼져 보내지 않은 행은 빼고)
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
    const matchesFailed = !filters.failedOnly || isUndelivered(r)
    return matchesQuery && matchesType && matchesChannel && matchesFailed
  })
}

// 행사 설정 "참가자 알림 메일"이 꺼져 있어 일부러 보내지 않은 행 — 실패가 아니다(재발송하려면 먼저 켠다).
export function isSkippedByEmailSwitch(log: AdminNotificationLog): boolean {
  return !log.delivered && log.skip_reason === SKIP_REASON_EVENT_EMAIL_DISABLED
}

// "미전달" — 전달되지 않았고, 스위치로 일부러 안 보낸 행도 아니다(재발송 대상 추리기·개수 배지가 쓴다).
// 스위치를 꺼 둔 행사에서는 메일 행이 전부 보내지 않음이 되므로, 이것까지 미전달로 세면 진짜 실패가 묻힌다.
export function isUndelivered(log: AdminNotificationLog): boolean {
  return !log.delivered && !isSkippedByEmailSwitch(log)
}

// 최신 발송이 위(발송 이력은 시간 역순이 기본 독법).
export function sortNotificationsByRecent(rows: AdminNotificationLog[]): AdminNotificationLog[] {
  return [...rows].sort((a, b) => b.sent_at.localeCompare(a.sent_at))
}

// 발송 이력 머리말의 숫자 — "발송"은 실제로 보냈거나 보내려 한 행만 센다. 참가자 알림 메일이 꺼져 일부러 보내지
// 않은 행은 발송에 넣지 않고 "보내지 않음"으로 따로 센다(꺼진 기간에 발송 수가 부풀지 않게).
export interface NotificationLogCounts {
  sent: number // 발송(전달됨 + 미전달)
  undelivered: number // 미전달(재발송 대상)
  muted: number // 보내지 않음(참가자 알림 메일 꺼짐)
}

export function countNotificationLogs(rows: AdminNotificationLog[]): NotificationLogCounts {
  const muted = rows.filter(isSkippedByEmailSwitch).length
  return { sent: rows.length - muted, undelivered: rows.filter(isUndelivered).length, muted }
}

export function notificationLogSummary(rows: AdminNotificationLog[]): string {
  const { sent, undelivered, muted } = countNotificationLogs(rows)
  return (
    `발송 ${sent}건` +
    (undelivered > 0 ? ` · 미전달 ${undelivered}건(재발송 대상)` : "") +
    (muted > 0 ? ` · 보내지 않음 ${muted}건(참가사·바이어 알림 메일 꺼짐)` : "")
  )
}

// 수동 재발송 반영 — 서버가 전달했다고 답한 뒤에만 부른다. 발송 시각을 갱신하고 재발송 횟수를 올린다.
// 보낸 행이 되므로 "보내지 않은 사유"는 지운다.
export function applyResend(log: AdminNotificationLog, at: string): AdminNotificationLog {
  return {
    ...log,
    sent_at: at,
    delivered: true,
    skip_reason: null,
    resend_count: log.resend_count + 1,
  }
}

// 재발송을 시도했지만 서버가 전달하지 못했다고 답했다(200 + delivered=false — 메일 서버 실패·주소 없음).
// 전달됨으로 바꾸지 않는다. 시도는 했으므로 재발송 횟수는 올리고, 이제 스위치 때문에 안 보낸 행이 아니므로
// 보내지 않은 사유는 지운다(서버도 그 행을 실패/건너뜀으로 고쳐 썼다).
export function applyResendFailure(log: AdminNotificationLog): AdminNotificationLog {
  return { ...log, delivered: false, skip_reason: null, resend_count: log.resend_count + 1 }
}
