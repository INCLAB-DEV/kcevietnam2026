import { describe, it, expect } from "vitest"
import {
  latestNotifications,
  notificationHref,
  type Notification,
  type NotificationType,
} from "./notification"

function n(id: string, createdAt: string): Notification {
  return { id, type: "meeting_requested", meetingId: `mtg-${id}`, message: `알림 ${id}`, createdAt }
}

describe("latestNotifications", () => {
  it("createdAt 최신순으로 정렬한다", () => {
    const result = latestNotifications([
      n("a", "2026-09-12T09:00:00+09:00"),
      n("c", "2026-09-12T17:00:00+09:00"),
      n("b", "2026-09-12T13:00:00+09:00"),
    ])
    expect(result.map((x) => x.id)).toEqual(["c", "b", "a"])
  })

  it("기본 5개까지만 노출한다", () => {
    const all = Array.from({ length: 8 }, (_, i) =>
      n(String(i), `2026-09-12T0${i}:00:00+09:00`)
    )
    expect(latestNotifications(all)).toHaveLength(5)
  })

  it("5개 미만이면 있는 만큼만 반환한다", () => {
    expect(latestNotifications([n("a", "2026-09-12T09:00:00+09:00")])).toHaveLength(1)
  })

  it("원본 배열을 변형하지 않는다", () => {
    const all = [n("a", "2026-09-12T09:00:00+09:00"), n("b", "2026-09-12T13:00:00+09:00")]
    const snapshot = all.map((x) => x.id)
    latestNotifications(all)
    expect(all.map((x) => x.id)).toEqual(snapshot)
  })
})

// 타입 → 목적지 계약표(회귀 방지). /meetings/:id 는 MY-002 "미팅 리뷰(회의록)" 화면이고
// /meetings 가 MY-001 타임라인(수락/거절/취소)이다 — 라이프사이클 알림이 리뷰 화면으로 새던
// 버그(알림 "미팅 신청받음" 클릭 → 회의록 작성 화면)를 이 표가 막는다.
describe("notificationHref (F-NT-001 딥링크)", () => {
  const CASES: [NotificationType, string][] = [
    ["meeting_requested", "/meetings?meeting=mtg-1&from=notifications"],
    ["meeting_accepted", "/meetings?meeting=mtg-1&from=notifications"],
    ["meeting_cancelled", "/meetings?meeting=mtg-1&from=notifications"],
    ["meeting_rejected", "/meetings?meeting=mtg-1&from=notifications"],
    ["meeting_reminder", "/meetings?meeting=mtg-1&from=notifications"],
    ["review_prompt", "/meetings/mtg-1?from=notifications"],
    ["review_ready", "/meetings/mtg-1?from=notifications"],
  ]

  it.each(CASES)("%s → %s", (type, href) => {
    expect(notificationHref({ type, meetingId: "mtg-1" })).toBe(href)
  })

  it("미팅 라이프사이클 알림은 리뷰 화면(/meetings/:id)으로 가지 않는다", () => {
    for (const type of ["meeting_requested", "meeting_accepted", "meeting_cancelled", "meeting_rejected", "meeting_reminder"] as const) {
      expect(notificationHref({ type, meetingId: "mtg-1" })).not.toMatch(/^\/meetings\/mtg-1/)
    }
  })

  // 계약이 늘어 FE가 모르는 type이 내려와도 리뷰 화면으로 새면 안 된다(화이트리스트 폴백).
  it("알 수 없는 타입은 리뷰가 아니라 타임라인으로 떨어진다", () => {
    const unknown = "meeting_rescheduled" as NotificationType
    expect(notificationHref({ type: unknown, meetingId: "mtg-1" })).toBe(
      "/meetings?meeting=mtg-1&from=notifications"
    )
  })

  it("meetingId가 없으면(미팅 비연계 통지) /notifications로 폴백한다", () => {
    expect(notificationHref({ type: "meeting_requested", meetingId: null })).toBe("/notifications")
    expect(notificationHref({ type: "review_prompt", meetingId: null })).toBe("/notifications")
  })
})
