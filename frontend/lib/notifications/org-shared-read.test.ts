import { afterEach, describe, expect, it } from "vitest"
import { sessionApiClient } from "@/lib/api-client/session"
import { unreadCount } from "./inbox"
import { resetNotificationStore } from "./store"

// sessionApiClient 는 반응형 스토어(store.ts)를 단일 소스로 위임 — 테스트 간 상태 격리.
afterEach(() => {
  resetNotificationStore()
})

// org 공유 인박스: 한 멤버가 읽으면 같은 org 의 다른 멤버 조회에도 읽음이 공유된다(ADR-0010).
// sessionApiClient 인메모리 스토어로 "조회 → 한 멤버 읽음 → 재조회" 흐름을 검증.
describe("org 공유 읽음 (api-client 계약)", () => {
  it("멤버 A 가 읽으면 멤버 B 의 재조회에도 read_at·read_by 가 반영된다", async () => {
    const orgId = "exh-1"
    const before = await sessionApiClient.listNotifications(orgId)
    const target = before.find((n) => n.readAt === null)!

    // 멤버 A 가 읽음 처리.
    await sessionApiClient.markNotificationRead(orgId, target.id, "이참가사A")

    // 멤버 B 가 같은 org 인박스를 다시 조회 — 공유 읽음 반영.
    const afterForB = await sessionApiClient.listNotifications(orgId)
    const seen = afterForB.find((n) => n.id === target.id)!
    expect(seen.readAt).not.toBeNull()
    expect(seen.readByMemberName).toBe("이참가사A")
    expect(unreadCount(afterForB)).toBe(unreadCount(before) - 1)
  })

  it("모두 읽음 후 재조회 시 안읽음이 0 이다", async () => {
    const orgId = "buyer-1"
    await sessionApiClient.markAllNotificationsRead(orgId, "김바이어")
    const after = await sessionApiClient.listNotifications(orgId)
    expect(unreadCount(after)).toBe(0)
  })
})
