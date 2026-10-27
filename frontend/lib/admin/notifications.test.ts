import { describe, expect, it } from "vitest"
import { buildAdminDashboard } from "./admin-mock"
import {
  applyResend,
  applyResendFailure,
  countNotificationLogs,
  EMPTY_NOTIFICATION_FILTERS,
  filterNotifications,
  isSkippedByEmailSwitch,
  isUndelivered,
  notificationLogSummary,
} from "./notifications"
import type { AdminNotificationLog } from "./types"

// 참가자 알림 메일(nt004mail0001)이 꺼져 일부러 보내지 않은 이메일 행(skip_reason=event_email_disabled)은
// 실패가 아니다 — "미전달(재발송 대상)"과 따로 읽혀야 진짜 실패가 묻히지 않는다.

function log(overrides: Partial<AdminNotificationLog>): AdminNotificationLog {
  return {
    id: "d-1",
    event_id: "evt-1",
    type: "meeting_accepted",
    channel: "email",
    recipient_org_id: "org-1",
    recipient_org_name: "픽셀아츠 스튜디오",
    meeting_id: "m-1",
    sent_at: "2026-10-20T10:00:00+07:00",
    delivered: false,
    resend_count: 0,
    ...overrides,
  }
}

const delivered = log({ id: "sent", delivered: true })
const failed = log({ id: "failed" })
const muted = log({ id: "muted", skip_reason: "event_email_disabled" })
const legacy = log({ id: "legacy", skip_reason: undefined }) // 이 필드가 생기기 전의 백엔드 응답

describe("참가자 알림 메일로 보내지 않은 행", () => {
  it("skip_reason=event_email_disabled이고 전달되지 않은 행만 '보내지 않음'이다", () => {
    expect(isSkippedByEmailSwitch(muted)).toBe(true)
    expect(isSkippedByEmailSwitch(failed)).toBe(false)
    expect(isSkippedByEmailSwitch(legacy)).toBe(false)
    expect(isSkippedByEmailSwitch(delivered)).toBe(false)
    // 다시 켜고 재발송해 전달됐다면 더는 '보내지 않음'이 아니다.
    expect(isSkippedByEmailSwitch({ ...muted, delivered: true })).toBe(false)
  })

  it("미전달(재발송 대상)에서 빠진다 — 실패·구 응답은 그대로 미전달", () => {
    expect([delivered, failed, muted, legacy].filter(isUndelivered).map((r) => r.id)).toEqual([
      "failed",
      "legacy",
    ])
  })

  it("'미전달만' 필터에 섞이지 않는다", () => {
    const rows = filterNotifications([delivered, failed, muted], {
      ...EMPTY_NOTIFICATION_FILTERS,
      failedOnly: true,
    })
    expect(rows.map((r) => r.id)).toEqual(["failed"])
  })

  it("재발송 반영은 보내지 않은 사유를 지운다", () => {
    const next = applyResend(muted, "2026-10-21T09:00:00+07:00")
    expect(next.delivered).toBe(true)
    expect(next.skip_reason).toBeNull()
    expect(isSkippedByEmailSwitch(next)).toBe(false)
    expect(muted.skip_reason).toBe("event_email_disabled") // 원본 불변
  })
})

describe("발송 수 — 보내지 않은 행은 발송으로 세지 않는다", () => {
  const rows = [delivered, failed, muted, legacy]

  it("발송·미전달·보내지 않음을 따로 센다", () => {
    expect(countNotificationLogs(rows)).toEqual({ sent: 3, undelivered: 2, muted: 1 })
    expect(notificationLogSummary(rows)).toBe(
      "발송 3건 · 미전달 2건(재발송 대상) · 보내지 않음 1건(참가사·바이어 알림 메일 꺼짐)",
    )
    expect(notificationLogSummary([delivered])).toBe("발송 1건")
  })

  it("대시보드 '알림 발송 수'도 보내지 않은 행을 빼고 센다(실연동도 같은 집계)", () => {
    expect(buildAdminDashboard("evt-1", [], [], rows, []).notification_sent).toBe(3)
  })
})

describe("재발송했지만 전달되지 않음", () => {
  it("전달됨으로 바꾸지 않고, 시도 횟수만 올리고, 보내지 않은 사유는 지운다", () => {
    const next = applyResendFailure(muted)
    expect(next.delivered).toBe(false)
    expect(next.resend_count).toBe(1)
    expect(next.skip_reason).toBeNull()
    expect(isUndelivered(next)).toBe(true) // 이제 재발송 대상(미전달)이다
  })
})
