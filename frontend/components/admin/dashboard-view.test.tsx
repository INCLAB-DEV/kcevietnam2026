import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { AdminDashboardView } from "./dashboard-view"
import type { AdminDashboard, AdminEvent } from "@/lib/admin/types"

// 대시보드 본문 "관리 섹션" 카드는 사이드바(admin-sidebar.tsx)와 별개 코드경로로 ADMIN_NAV_ITEMS를
// 그렸다 — sub가 사이드바에선 감춰진 master 전용 화면(미팅 배정·운영자 관리)을 여기선 그대로 보고
// 눌러 403을 맞던 결함(2026-09-17 라이브 검증) 수정. adminNavItemsFor(canWrite)로 사이드바와 같은
// 판정을 쓴다.

const EVENT: AdminEvent = {
  id: "evt-1",
  name: "2026 K-콘텐츠 엑스포",
  venue_name: "",
  exhibition_start: "2026-10-20",
  exhibition_end: "2026-10-22",
  application_start: "",
  application_end: "",
  timezone: "Asia/Seoul",
}

const DATA: AdminDashboard = {
  event_id: "evt-1",
  org_total: 0,
  exhibitor_count: 0,
  buyer_count: 0,
  unsubmitted_count: 0,
  meeting_total: 0,
  meeting_scheduled: 0,
  notification_sent: 0,
  recent_activity: [],
}

describe("AdminDashboardView — 관리 섹션 바로가기", () => {
  it("master(canWrite)는 미팅 배정·운영자 관리 바로가기를 본다", () => {
    render(<AdminDashboardView data={DATA} event={EVENT} settings={null} canWrite />)
    expect(screen.getByRole("link", { name: /미팅 배정/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /운영자 관리/ })).toBeInTheDocument()
  })

  it("sub(!canWrite)는 미팅 배정·운영자 관리 바로가기를 보지 않는다(master 전용 API라 403)", () => {
    render(<AdminDashboardView data={DATA} event={EVENT} settings={null} canWrite={false} />)
    expect(screen.queryByRole("link", { name: /미팅 배정/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /운영자 관리/ })).not.toBeInTheDocument()
    // master+sub 공용 화면은 그대로 보인다.
    expect(screen.getByRole("link", { name: /기업 관리/ })).toBeInTheDocument()
  })
})
