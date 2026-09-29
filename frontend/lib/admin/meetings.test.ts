import { describe, expect, it } from "vitest"
import {
  applyCancel,
  canCancelMeeting,
  EMPTY_MEETING_FILTERS,
  filterMeetings,
  meetingDateOptions,
  sortMeetingsBySchedule,
} from "./meetings"
import { applyResend, filterNotifications, EMPTY_NOTIFICATION_FILTERS } from "./notifications"
import { buildAdminDashboard, KADEX_EVENT_ID, MOCK_MEETINGS, MOCK_NOTIFICATION_LOGS, VIETNAM_EVENT_ID } from "./admin-mock"
import { scopeToEvent } from "./organizations"
import type { AdminMeeting } from "./types"

const KADEX_MEETINGS = scopeToEvent(MOCK_MEETINGS, KADEX_EVENT_ID)

describe("미팅 필터", () => {
  it("양측 기업명으로 검색된다", () => {
    expect(
      filterMeetings(KADEX_MEETINGS, { ...EMPTY_MEETING_FILTERS, query: "한울" }).length,
    ).toBeGreaterThan(0)
    expect(
      filterMeetings(KADEX_MEETINGS, { ...EMPTY_MEETING_FILTERS, query: "가루다" }).length,
    ).toBeGreaterThan(0)
  })

  it("날짜·상태 필터가 걸린다", () => {
    const byDate = filterMeetings(KADEX_MEETINGS, {
      ...EMPTY_MEETING_FILTERS,
      dates: ["2026-09-16"],
    })
    expect(byDate.every((m) => m.date === "2026-09-16")).toBe(true)

    const cancelled = filterMeetings(KADEX_MEETINGS, {
      ...EMPTY_MEETING_FILTERS,
      statuses: ["cancelled"],
    })
    expect(cancelled.every((m) => m.status === "cancelled")).toBe(true)
  })

  it("날짜 옵션은 데이터에 있는 날짜만 오름차순으로", () => {
    const dates = meetingDateOptions(KADEX_MEETINGS)
    expect(dates).toEqual([...dates].sort())
    expect(new Set(dates).size).toBe(dates.length)
  })
})

describe("미팅 정렬", () => {
  it("날짜 → 시각 오름차순(당일 일정표 독법)", () => {
    const sorted = sortMeetingsBySchedule(KADEX_MEETINGS)
    const keys = sorted.map((m) => `${m.date} ${m.start_time}`)
    expect(keys).toEqual([...keys].sort())
  })
})

describe("운영자 취소", () => {
  const scheduled = KADEX_MEETINGS.find((m) => m.status === "scheduled") as AdminMeeting

  it("예정 건만 취소할 수 있다", () => {
    expect(canCancelMeeting(scheduled)).toBe(true)
    for (const status of ["completed", "cancelled", "noshow"] as const) {
      expect(canCancelMeeting({ ...scheduled, status })).toBe(false)
    }
  })

  it("취소하면 상태·사유·주체가 기록된다", () => {
    const next = applyCancel(scheduled, "전시장 사정으로 슬롯 회수", "정세훈")
    expect(next.status).toBe("cancelled")
    expect(next.cancelled_reason).toBe("전시장 사정으로 슬롯 회수")
    expect(next.cancelled_by).toBe("정세훈")
    // 원본 불변
    expect(scheduled.status).toBe("scheduled")
  })
})

describe("알림 이력", () => {
  const kadexLogs = scopeToEvent(MOCK_NOTIFICATION_LOGS, KADEX_EVENT_ID)

  it("타입·채널 필터가 걸린다", () => {
    const emails = filterNotifications(kadexLogs, {
      ...EMPTY_NOTIFICATION_FILTERS,
      channels: ["email"],
    })
    expect(emails.every((l) => l.channel === "email")).toBe(true)

    const cancels = filterNotifications(kadexLogs, {
      ...EMPTY_NOTIFICATION_FILTERS,
      types: ["meeting_cancelled"],
    })
    expect(cancels.every((l) => l.type === "meeting_cancelled")).toBe(true)
  })

  it("미전달만 보기로 재발송 대상을 추린다", () => {
    const failed = filterNotifications(kadexLogs, {
      ...EMPTY_NOTIFICATION_FILTERS,
      failedOnly: true,
    })
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every((l) => !l.delivered)).toBe(true)
  })

  it("재발송은 발송시각을 갱신하고 횟수를 올린다", () => {
    const failed = kadexLogs.find((l) => !l.delivered)!
    const next = applyResend(failed, "2026-08-28T10:00:00+09:00")
    expect(next.sent_at).toBe("2026-08-28T10:00:00+09:00")
    expect(next.delivered).toBe(true)
    expect(next.resend_count).toBe(failed.resend_count + 1)
    expect(failed.delivered).toBe(false) // 원본 불변
  })
})

describe("대시보드 집계", () => {
  it("선택된 행사 범위로만 센다", () => {
    const kadex = buildAdminDashboard(KADEX_EVENT_ID)
    const vietnam = buildAdminDashboard(VIETNAM_EVENT_ID)

    expect(kadex.event_id).toBe(KADEX_EVENT_ID)
    expect(kadex.org_total).toBe(kadex.exhibitor_count + kadex.buyer_count)
    expect(kadex.meeting_total).toBe(KADEX_MEETINGS.length)
    expect(kadex.org_total).not.toBe(vietnam.org_total)
  })

  it("미신청 수·예정 미팅 수가 원본과 일치한다", () => {
    const d = buildAdminDashboard(KADEX_EVENT_ID)
    expect(d.meeting_scheduled).toBe(KADEX_MEETINGS.filter((m) => m.status === "scheduled").length)
    expect(d.unsubmitted_count).toBeGreaterThan(0)
  })

  it("최근 활동은 최신순 최대 5건", () => {
    const d = buildAdminDashboard(KADEX_EVENT_ID)
    expect(d.recent_activity.length).toBeLessThanOrEqual(5)
    const times = d.recent_activity.map((a) => a.at)
    expect(times).toEqual([...times].sort((a, b) => b.localeCompare(a)))
  })
})
