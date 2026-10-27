import { render, screen } from "@/lib/test/render-with-intl"
import { describe, it, expect } from "vitest"
import { NotificationCard } from "./notification-card"
import type { Notification } from "@/lib/home/notification"

const notifications: Notification[] = [
  {
    id: "n1",
    type: "meeting_requested",
    meetingId: "mtg-1",
    message: "방위사업청이 미팅을 요청했습니다",
    createdAt: "2026-09-12T16:00:00+09:00",
  },
  {
    id: "n2",
    type: "review_prompt",
    meetingId: "mtg-2",
    message: "한화시스템과의 미팅 회의록을 작성해주세요",
    createdAt: "2026-09-11T18:00:00+09:00",
  },
]

describe("NotificationCard", () => {
  it("알림을 리스트로 노출하고 타입별 딥링크(신청=타임라인 / 회의록=리뷰)로 연결한다", () => {
    render(<NotificationCard notifications={notifications} />)
    // 미팅 신청받음 → MY-001 타임라인에서 그 미팅 선택(수락/거절이 있는 화면).
    expect(screen.getByText("방위사업청이 미팅을 요청했습니다").closest("a")).toHaveAttribute(
      "href",
      "/meetings?meeting=mtg-1&from=notifications"
    )
    // 회의록 입력 안내 → MY-002 리뷰 화면.
    expect(screen.getByText("한화시스템과의 미팅 회의록을 작성해주세요").closest("a")).toHaveAttribute(
      "href",
      "/meetings/mtg-2?from=notifications"
    )
  })

  it("알림이 없으면 빈 안내를 보여준다", () => {
    render(<NotificationCard notifications={[]} />)
    expect(screen.getByText("새 알림이 없습니다")).toBeInTheDocument()
  })

  it("헤더 '전체 알림' CTA로 /notifications로 이동한다", () => {
    render(<NotificationCard notifications={[]} />)
    expect(screen.getByRole("link", { name: /전체 알림/ })).toHaveAttribute("href", "/notifications")
  })
})
