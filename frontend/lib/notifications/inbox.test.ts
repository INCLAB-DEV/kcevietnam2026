import { describe, expect, it } from "vitest"
import {
  filterByType,
  markAllAsRead,
  markAsRead,
  notificationHref,
  notificationMessage,
  pinnedReminders,
  sortByNewest,
  unreadCount,
} from "./inbox"
import type { NotificationItem } from "./types"

// notification-composer.test.ts와 동일한 최소 스텁 — next-intl 런타임 없이 순수하게 문구를 검증한다.
// 실제 문구는 messages/{ko,en}.json의 notifications.messages에서 확인.
const stubT = (key: string, values?: Record<string, unknown>) =>
  `${key}${values ? `:${JSON.stringify(values)}` : ""}`

function item(over: Partial<NotificationItem> & Pick<NotificationItem, "id" | "type">): NotificationItem {
  const base = {
    recipientOrgId: "buyer-1",
    meetingId: "mtg-001",
    createdAt: "2026-09-01T10:00:00+09:00",
    readAt: null,
    readByMemberName: null,
  }
  // 타입별 기본 payload (테스트에서 over.payload 로 덮어씀).
  const payloadByType: Record<NotificationItem["type"], unknown> = {
    meeting_requested: { counterpartOrgName: "한화", requestedByRole: "buyer" },
    meeting_accepted: { counterpartOrgName: "한화", scheduledStart: "2026-09-03T10:00:00+09:00", venueLabel: "A-1" },
    meeting_cancelled: { counterpartOrgName: "한화", scheduledStart: "2026-09-03T10:00:00+09:00", cancelledByRole: "exhibitor" },
    meeting_rejected: { counterpartOrgName: "한화", scheduledStart: "2026-09-03T10:00:00+09:00" },
    meeting_reminder: { counterpartOrgName: "한화", scheduledStart: "2026-09-03T10:00:00+09:00", venueLabel: "A-1" },
    review_prompt: { counterpartOrgName: "한화" },
    review_ready: { counterpartOrgName: "한화" },
    application_approved: { orgName: "한화", role: "exhibitor" },
  }
  return { ...base, payload: payloadByType[over.type], ...over } as NotificationItem
}

describe("sortByNewest", () => {
  it("createdAt 내림차순으로 정렬하고 원본을 변형하지 않는다", () => {
    const input = [
      item({ id: "a", type: "review_prompt", createdAt: "2026-09-01T10:00:00+09:00" }),
      item({ id: "b", type: "review_prompt", createdAt: "2026-09-03T10:00:00+09:00" }),
      item({ id: "c", type: "review_prompt", createdAt: "2026-09-02T10:00:00+09:00" }),
    ]
    expect(sortByNewest(input).map((n) => n.id)).toEqual(["b", "c", "a"])
    expect(input.map((n) => n.id)).toEqual(["a", "b", "c"]) // 원본 보존
  })
})

describe("filterByType", () => {
  const items = [
    item({ id: "a", type: "meeting_requested" }),
    item({ id: "b", type: "meeting_reminder" }),
    item({ id: "c", type: "meeting_requested" }),
  ]
  it("all 은 전체를 반환한다", () => {
    expect(filterByType(items, "all")).toHaveLength(3)
  })
  it("선택 type 만 반환한다", () => {
    expect(filterByType(items, "meeting_requested").map((n) => n.id)).toEqual(["a", "c"])
  })
})

describe("unreadCount", () => {
  it("readAt === null 인 행만 센다", () => {
    const items = [
      item({ id: "a", type: "review_prompt" }),
      item({ id: "b", type: "review_prompt", readAt: "2026-09-01T11:00:00+09:00", readByMemberName: "김바이어" }),
      item({ id: "c", type: "review_prompt" }),
    ]
    expect(unreadCount(items)).toBe(2)
  })
})

describe("markAsRead — org 공유 읽음", () => {
  it("한 멤버가 읽으면 그 행에 read_at·read_by 가 박힌다(org 전체 공유)", () => {
    const items = [item({ id: "a", type: "review_prompt" }), item({ id: "b", type: "review_prompt" })]
    const next = markAsRead(items, "a", "김바이어", "2026-09-02T09:00:00+09:00")
    const a = next.find((n) => n.id === "a")!
    expect(a.readAt).toBe("2026-09-02T09:00:00+09:00")
    expect(a.readByMemberName).toBe("김바이어")
    expect(next.find((n) => n.id === "b")!.readAt).toBeNull() // 다른 행은 그대로
    expect(items[0].readAt).toBeNull() // 원본 불변
  })

  it("이미 읽힌 행의 최초 읽은 주체·시각을 덮어쓰지 않는다", () => {
    const items = [item({ id: "a", type: "review_prompt", readAt: "2026-09-01T08:00:00+09:00", readByMemberName: "이전멤버" })]
    const next = markAsRead(items, "a", "다른멤버", "2026-09-02T09:00:00+09:00")
    expect(next[0].readByMemberName).toBe("이전멤버")
    expect(next[0].readAt).toBe("2026-09-01T08:00:00+09:00")
  })
})

describe("markAllAsRead", () => {
  it("안읽음 행만 읽음 처리하고 이미 읽힌 행은 보존한다", () => {
    const items = [
      item({ id: "a", type: "review_prompt" }),
      item({ id: "b", type: "review_prompt", readAt: "2026-09-01T08:00:00+09:00", readByMemberName: "이전멤버" }),
    ]
    const next = markAllAsRead(items, "김바이어", "2026-09-02T09:00:00+09:00")
    expect(unreadCount(next)).toBe(0)
    expect(next.find((n) => n.id === "a")!.readByMemberName).toBe("김바이어")
    expect(next.find((n) => n.id === "b")!.readByMemberName).toBe("이전멤버") // 보존
  })
})

describe("pinnedReminders — 모바일 상단", () => {
  it("안읽은 10분 리마인더만 최신순으로 추린다", () => {
    const items = [
      item({ id: "old", type: "meeting_reminder", createdAt: "2026-09-01T10:00:00+09:00" }),
      item({ id: "new", type: "meeting_reminder", createdAt: "2026-09-03T10:00:00+09:00" }),
      item({ id: "read", type: "meeting_reminder", createdAt: "2026-09-02T10:00:00+09:00", readAt: "x", readByMemberName: "m" }),
      item({ id: "other", type: "meeting_accepted" }),
    ]
    expect(pinnedReminders(items).map((n) => n.id)).toEqual(["new", "old"])
  })
})

describe("notificationMessage — payload 스냅샷 문구", () => {
  it("7종 모두 상대 기업명을 포함한 문구를 만든다", () => {
    const types = [
      "meeting_requested",
      "meeting_accepted",
      "meeting_cancelled",
      "meeting_rejected",
      "meeting_reminder",
      "review_prompt",
      "review_ready",
    ] as const
    for (const type of types) {
      expect(notificationMessage(item({ id: type, type }), stubT)).toContain("한화")
    }
  })

  it("review_ready 는 전용 메시지 키(reviewReady)로 조립한다", () => {
    expect(notificationMessage(item({ id: "r", type: "review_ready" }), stubT)).toContain("messages.reviewReady")
  })
})

describe("notificationHref — 딥링크", () => {
  // /meetings/:id 는 MY-002 리뷰(회의록) 화면이라 리뷰 계열만 그리로 간다. 미팅 라이프사이클
  // 알림은 MY-001 타임라인에서 해당 미팅이 선택된 상태로 열어야 수락/거절/취소가 가능하다.
  it("리마인더는 타임라인에서 그 미팅을 선택한 상태로 보낸다", () => {
    expect(notificationHref({ type: "meeting_reminder", meetingId: "mtg-009" })).toBe(
      "/meetings?meeting=mtg-009&from=notifications",
    )
  })

  it("회의록 입력 안내만 리뷰 화면(/meetings/:id)으로 보낸다", () => {
    expect(notificationHref({ type: "review_prompt", meetingId: "mtg-009" })).toBe(
      "/meetings/mtg-009?from=notifications",
    )
  })
})
