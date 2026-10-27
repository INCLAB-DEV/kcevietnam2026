import { render, screen, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationInbox } from "./notification-inbox"
import { resetNotificationStore, seedNotificationStore } from "@/lib/notifications/store"
import { cloneNotification } from "@/lib/notifications/inbox"
import type { NotificationItem } from "@/lib/notifications/types"

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

const ITEMS: NotificationItem[] = [
  {
    id: "n-reminder",
    recipientOrgId: "buyer-1",
    type: "meeting_reminder",
    meetingId: "mtg-001",
    createdAt: "2026-09-03T09:50:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: { counterpartOrgName: "한화시스템", scheduledStart: "2026-09-03T10:00:00+09:00", venueLabel: "A-1" },
  },
  {
    id: "n-review",
    recipientOrgId: "buyer-1",
    type: "review_prompt",
    meetingId: "mtg-004",
    createdAt: "2026-08-30T17:40:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: { counterpartOrgName: "현대로템" },
  },
  {
    id: "n-cancelled",
    recipientOrgId: "buyer-1",
    type: "meeting_cancelled",
    meetingId: "mtg-003",
    createdAt: "2026-08-31T11:05:00+09:00",
    readAt: "2026-08-31T11:30:00+09:00",
    readByMemberName: "김바이어",
    payload: { counterpartOrgName: "LIG넥스원", scheduledStart: "2026-09-04T13:00:00+09:00", cancelledByRole: "exhibitor" },
  },
]

function renderInbox() {
  return render(<NotificationInbox orgId="buyer-1" memberName="박멤버" />)
}

beforeEach(() => {
  // 반응형 스토어를 테스트 데이터로 시드(모듈 전역 상태 격리).
  seedNotificationStore("buyer-1", ITEMS.map(cloneNotification))
})

afterEach(() => {
  resetNotificationStore()
  mockPush.mockClear()
})

describe("NotificationInbox", () => {
  it("안읽음 개수를 표시하고 5종 행을 최신순으로 렌더한다", () => {
    renderInbox()
    expect(screen.getByText(/안읽음 2건/)).toBeInTheDocument()
    const list = screen.getByRole("list")
    const rows = within(list).getAllByRole("listitem")
    // 최신순: reminder(9/3) → cancelled(8/31) → review(8/30)
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText(/곧 시작/)).toBeInTheDocument()
  })

  it("이미 읽힌 행은 읽은 멤버·시각을 보여준다", () => {
    renderInbox()
    expect(screen.getByText(/읽음 김바이어/)).toBeInTheDocument()
  })

  it("type 필터로 해당 종류만 보여준다", async () => {
    renderInbox()
    await userEvent.click(screen.getByRole("tab", { name: "회의록 작성" }))
    const rows = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText(/회의록을 입력/)).toBeInTheDocument()
  })

  it("행 클릭 시 읽음 처리(안읽음 감소)하고 from=notifications 딥링크로 이동한다", async () => {
    renderInbox()
    expect(screen.getByText(/안읽음 2건/)).toBeInTheDocument()
    await userEvent.click(screen.getByText(/회의록을 입력/))
    // 스토어 갱신이 인박스에 실시간 반영 — 안읽음 2→1.
    expect(screen.getByText(/안읽음 1건/)).toBeInTheDocument()
    expect(mockPush).toHaveBeenCalledWith("/meetings/mtg-004?from=notifications")
  })

  // 회귀: /meetings/:id 는 MY-002 리뷰(회의록) 화면이라, 미팅 라이프사이클 알림을 거기로 보내면
  // "미팅 신청받음"을 눌렀는데 회의록 작성 화면이 뜬다(실 배포 버그). 타임라인 딥링크로 보내야 한다.
  it("리마인더 등 미팅 라이프사이클 알림은 타임라인(/meetings?meeting=)으로 이동한다", async () => {
    renderInbox()
    const list = screen.getByRole("list")
    await userEvent.click(within(list).getByText(/곧 시작/))
    expect(mockPush).toHaveBeenCalledWith("/meetings?meeting=mtg-001&from=notifications")
  })

  it("모두 읽음 클릭 시 전체 읽음 처리되고 버튼이 비활성된다", async () => {
    renderInbox()
    const btn = screen.getByRole("button", { name: /모두 읽음/ })
    expect(btn).toBeEnabled()
    await userEvent.click(btn)
    expect(screen.getByText(/안읽음 0건/)).toBeInTheDocument()
    expect(btn).toBeDisabled()
  })
})
