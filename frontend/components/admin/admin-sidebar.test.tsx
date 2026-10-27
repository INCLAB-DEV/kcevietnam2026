import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AdminSidebar, type AdminSidebarUser } from "./admin-sidebar"
import { sessionApiClient } from "@/lib/api-client/session"
import type { AdminEvent } from "@/lib/admin/types"

// GOH's latest admin shell owns meeting assignment. Keep its navigation and
// add the missing logout and cross-console route without duplicating event menus.

let mockPathname = "/admin"
const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
}))

const MOCK_EVENT: AdminEvent = {
  id: "evt-1",
  name: "2026 KADEX",
  venue_name: "KINTEX",
  exhibition_start: "2026-09-01",
  exhibition_end: "2026-09-05",
  application_start: "2026-08-01",
  application_end: "2026-08-20",
  timezone: "Asia/Seoul",
}

const MOCK_USER: AdminSidebarUser = {
  name: "정세훈",
  affiliation: "사무국",
  email: "op@example.com",
}

function renderSidebar(readOnly = false) {
  return render(
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <AdminSidebar
          user={MOCK_USER}
          events={[MOCK_EVENT]}
          selectedEvent={MOCK_EVENT}
          readOnly={readOnly}
        />
      </SidebarProvider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  mockPathname = "/admin"
  mockPush.mockClear()
})

describe("AdminSidebar", () => {
  it("GOH의 관리자 배정 메뉴를 유지한다", () => {
    renderSidebar()
    expect(screen.getByRole("link", { name: "미팅 배정" })).toHaveAttribute(
      "href",
      "/admin/forced-matching"
    )
  })

  it("/organizer(행사 운영)로 건너가는 링크가 있다", () => {
    renderSidebar()
    expect(screen.getByRole("link", { name: "행사 운영" })).toHaveAttribute(
      "href",
      "/organizer"
    )
  })

  it("슈퍼어드민(master)은 거버넌스 메뉴 전체를 본다", () => {
    renderSidebar(false)
    expect(screen.getByRole("link", { name: "운영자 관리" })).toHaveAttribute("href", "/admin/organizers")
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/admin"))).toHaveLength(10)
  })

  // 2026-09-17: 서브어드민이 사이드바의 master 전용 메뉴를 눌러 403 오류 화면에 갇히던 결함.
  it("서브어드민(readOnly)에겐 미팅 배정·운영자 관리·행사 운영 교차 링크를 숨기고 로그아웃은 남긴다", () => {
    renderSidebar(true)
    expect(screen.queryByRole("link", { name: "미팅 배정" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "운영자 관리" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "행사 운영" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "기업 관리" })).toHaveAttribute("href", "/admin/organizations")
    expect(screen.getByRole("link", { name: "대시보드" })).toHaveAttribute("href", "/admin")
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument()
  })

  it("로그아웃 버튼이 있고, 누르면 세션을 종료하고 /login으로 이동한다", async () => {
    const logoutSpy = vi.spyOn(sessionApiClient, "logout")
    renderSidebar()

    const logoutButton = screen.getByRole("button", { name: "로그아웃" })
    expect(logoutButton).toBeInTheDocument()

    await userEvent.click(logoutButton)

    expect(logoutSpy).toHaveBeenCalledOnce()
    expect(mockPush).toHaveBeenCalledWith("/login")
    logoutSpy.mockRestore()
  })
})
