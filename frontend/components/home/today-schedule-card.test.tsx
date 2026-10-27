import { render, screen } from "@/lib/test/render-with-intl"
import { describe, it, expect } from "vitest"
import { TodayScheduleCard } from "./today-schedule-card"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"

function meeting(partial: Partial<MeetingRecord> & { id: string }): MeetingRecord {
  return {
    status: "accepted",
    hasReview: false,
    scheduledAt: "2026-09-12T09:00:00+09:00",
    buyerOrgId: "buyer-1",
    exhibitorOrgId: "exh-1",
    requestedByOrgId: "exh-1",
    counterpartName: "한화시스템",
    venue: "비즈니스룸 1",
    ...partial,
  }
}

describe("TodayScheduleCard", () => {
  it("오늘 미팅의 시간(KST)·상대 기업·장소를 표시하고 /meetings로 이동한다", () => {
    render(<TodayScheduleCard meetings={[meeting({ id: "a" })]} />)
    expect(screen.getByText("한화시스템")).toBeInTheDocument()
    expect(screen.getByText(/비즈니스룸 1/)).toBeInTheDocument()
    expect(screen.getByText("09:00")).toBeInTheDocument()
    expect(screen.getByText("한화시스템").closest("a")).toHaveAttribute("href", "/meetings")
  })

  it("오늘 일정이 없으면 빈 안내를 보여준다", () => {
    render(<TodayScheduleCard meetings={[]} />)
    expect(screen.getByText("오늘 예정된 미팅이 없습니다")).toBeInTheDocument()
  })

  it("헤더 '전체 일정' CTA로 /meetings로 이동한다", () => {
    render(<TodayScheduleCard meetings={[]} />)
    expect(screen.getByRole("link", { name: /전체 일정/ })).toHaveAttribute("href", "/meetings")
  })
})
