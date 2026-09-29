import { afterEach, describe, expect, it } from "vitest"
import { getNotifications, pushNotification, resetNotificationStore } from "./store"
import type { NotificationItem } from "./types"

afterEach(() => {
  resetNotificationStore()
})

function reviewReady(id: string, orgId: string): NotificationItem {
  return {
    id,
    recipientOrgId: orgId,
    meetingId: "mtg-1",
    createdAt: "2026-09-04T10:00:00+09:00",
    readAt: null,
    readByMemberName: null,
    type: "review_ready",
    payload: { counterpartOrgName: "한화" },
  }
}

// 비동기 전사 완료 시 FE 가 "회의록 정리 완료" 알림을 직접 띄운다(데모; 실연동은 #44/#45).
describe("pushNotification — 완료 통지 발송", () => {
  it("새 알림을 인박스 맨 앞에 추가한다", () => {
    const orgId = "exh-1"
    const before = getNotifications(orgId).length
    pushNotification(orgId, reviewReady("rr-1", orgId))
    const after = getNotifications(orgId)
    expect(after.length).toBe(before + 1)
    expect(after[0].id).toBe("rr-1")
  })

  it("같은 id 는 중복 추가하지 않는다(재폴링·재진입 dedup)", () => {
    const orgId = "exh-1"
    pushNotification(orgId, reviewReady("rr-dup", orgId))
    const once = getNotifications(orgId).length
    pushNotification(orgId, reviewReady("rr-dup", orgId))
    expect(getNotifications(orgId).length).toBe(once)
  })
})
