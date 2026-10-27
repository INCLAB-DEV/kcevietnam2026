// 미팅 관리 테이블의 순수 로직(필터·정렬·취소 가능 판정).

import type { AdminMeeting, AdminMeetingStatus } from "./types"

export interface AdminMeetingFilters {
  query: string // 양측 기업명 검색
  dates: string[] // YYYY-MM-DD 다중 선택(빈 배열 = 전체)
  statuses: AdminMeetingStatus[] // 빈 배열 = 전체
}

export const EMPTY_MEETING_FILTERS: AdminMeetingFilters = {
  query: "",
  dates: [],
  statuses: [],
}

export function filterMeetings(
  rows: AdminMeeting[],
  filters: AdminMeetingFilters,
): AdminMeeting[] {
  const q = filters.query.trim().toLowerCase()
  const dates = new Set(filters.dates)
  const statuses = new Set(filters.statuses)
  return rows.filter((r) => {
    const matchesQuery =
      !q ||
      r.exhibitor_name.toLowerCase().includes(q) ||
      r.buyer_name.toLowerCase().includes(q)
    const matchesDate = dates.size === 0 || dates.has(r.date)
    const matchesStatus = statuses.size === 0 || statuses.has(r.status)
    return matchesQuery && matchesDate && matchesStatus
  })
}

// 일정순(날짜 → 시각 → 참가사명). 운영자가 당일 일정표처럼 훑을 수 있게 시간 오름차순 고정.
export function sortMeetingsBySchedule(rows: AdminMeeting[]): AdminMeeting[] {
  return [...rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start_time.localeCompare(b.start_time) ||
      a.exhibitor_name.localeCompare(b.exhibitor_name, "ko"),
  )
}

// 운영자 취소 가능 — 아직 열려 있는 예정 건만. 완료·노쇼는 지난 사실이고, 취소는 이미 취소됐다.
export function canCancelMeeting(meeting: AdminMeeting): boolean {
  return meeting.status === "scheduled"
}

// 취소 반영(낙관적) — 사유·주체를 남긴다. 실연동 시 POST /meetings/{id}/cancel 응답으로 대체된다.
export function applyCancel(
  meeting: AdminMeeting,
  reason: string,
  by: string,
): AdminMeeting {
  return { ...meeting, status: "cancelled", cancelled_reason: reason, cancelled_by: by }
}

// 필터 드롭다운에 띄울 날짜 옵션(데이터에 실제로 있는 날짜만, 오름차순).
export function meetingDateOptions(rows: AdminMeeting[]): string[] {
  return [...new Set(rows.map((r) => r.date))].sort()
}
