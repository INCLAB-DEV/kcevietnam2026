import { describe, expect, it } from "vitest"
import { composeNotificationMessage, toNotification, type NotificationOutSnake } from "./notification-composer"

// 실 백엔드(FastAPI GET /api/notifications)의 NotificationOut 계약 그대로 문구를 조립하는지 고정하는
// 계약 테스트. Translator는 실제 next-intl t와 구조적으로 호환되는 최소 스텁으로 대체한다(테스트는
// next-intl 런타임 없이 순수하게 돈다) — 실제 문구는 messages/{ko,en}.json에서 확인.
const stubT = (key: string, values?: Record<string, unknown>) =>
  `${key}${values ? `:${JSON.stringify(values)}` : ""}`

function item(overrides: Partial<NotificationOutSnake>): NotificationOutSnake {
  return {
    id: "ntf-1",
    type: "meeting_requested",
    meeting_id: "mtg-1",
    due_at: null,
    payload: { counterpart_org_name: "한빛디펜스" },
    created_at: "2026-09-16T10:00:00+09:00",
    read_at: null,
    read_by_member_id: null,
    ...overrides,
  }
}

describe("composeNotificationMessage", () => {
  it("meeting_requested", () => {
    expect(composeNotificationMessage(item({ type: "meeting_requested" }), stubT)).toBe(
      'meetingRequested:{"org":"한빛디펜스"}'
    )
  })

  it("meeting_accepted", () => {
    expect(composeNotificationMessage(item({ type: "meeting_accepted" }), stubT)).toBe(
      'meetingAccepted:{"org":"한빛디펜스"}'
    )
  })

  it("meeting_cancelled — 당사자(exhibitor/buyer)가 취소하면 일반 문구", () => {
    expect(
      composeNotificationMessage(
        item({ type: "meeting_cancelled", payload: { counterpart_org_name: "한빛디펜스", cancelled_by_role: "buyer" } }),
        stubT
      )
    ).toBe('meetingCancelled:{"org":"한빛디펜스"}')
  })

  it("meeting_cancelled — 운영자가 취소하면 전용 문구", () => {
    expect(
      composeNotificationMessage(
        item({
          type: "meeting_cancelled",
          payload: { counterpart_org_name: "한빛디펜스", cancelled_by_role: "organizer" },
        }),
        stubT
      )
    ).toBe('meetingCancelledByOrganizer:{"org":"한빛디펜스"}')
  })

  it("meeting_rejected", () => {
    expect(composeNotificationMessage(item({ type: "meeting_rejected" }), stubT)).toBe(
      'meetingRejected:{"org":"한빛디펜스"}'
    )
  })

  it("meeting_reminder", () => {
    expect(composeNotificationMessage(item({ type: "meeting_reminder" }), stubT)).toBe(
      'meetingReminder:{"org":"한빛디펜스"}'
    )
  })

  it("review_prompt", () => {
    expect(composeNotificationMessage(item({ type: "review_prompt" }), stubT)).toBe(
      'reviewPrompt:{"org":"한빛디펜스"}'
    )
  })

  it("review_ready", () => {
    expect(composeNotificationMessage(item({ type: "review_ready" }), stubT)).toBe(
      'reviewReady:{"org":"한빛디펜스"}'
    )
  })

  it("payload가 없으면(계약 밖) 빈 기업명으로 조용히 렌더한다", () => {
    expect(composeNotificationMessage(item({ type: "meeting_requested", payload: null }), stubT)).toBe(
      'meetingRequested:{"org":""}'
    )
  })
})

describe("toNotification — NotificationOut(snake) → Notification(camel)", () => {
  it("meeting_id가 있으면 그대로 옮긴다", () => {
    const n = toNotification(item({ meeting_id: "mtg-9" }), stubT)
    expect(n).toMatchObject({ id: "ntf-1", meetingId: "mtg-9", createdAt: "2026-09-16T10:00:00+09:00" })
  })

  it("meeting_id가 null이면 null을 유지한다(호출부 notificationHref가 /notifications로 폴백)", () => {
    const n = toNotification(item({ meeting_id: null }), stubT)
    expect(n.meetingId).toBeNull()
  })
})
