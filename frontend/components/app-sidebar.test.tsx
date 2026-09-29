import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar, isActiveNav, type SidebarUser } from "./app-sidebar"
import { SECRETARIAT_CONTACT } from "@/components/layout/nav"
import { sessionApiClient } from "@/lib/api-client/session"

let mockPathname = "/"
const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}))

// 알림 벨 배지(NT-001) 검증을 위해 안읽음 개수를 시나리오별로 갈아끼운다.
let mockUnread = 0
vi.mock("@/lib/notifications/use-notifications", () => ({
  useUnreadCount: () => mockUnread,
}))

const MOCK_USER: SidebarUser = {
  name: "김바이어",
  affiliation: "한화에어로스페이스",
  email: "buyer01@hanwha.com",
  phone: "010-1234-5678",
}

// 앱 루트(app/layout.tsx)와 동일하게 TooltipProvider 로 감싼다 — SidebarMenuButton 의 tooltip 이
// Radix Tooltip 을 사용하므로 provider 가 필요하다.
function renderSidebar(
  role: Parameters<typeof AppSidebar>[0]["role"],
  opts?: {
    defaultOpen?: boolean
    orgId?: string
    permissionLevel?: Parameters<typeof AppSidebar>[0]["permissionLevel"]
  },
) {
  return render(
    <TooltipProvider>
      <SidebarProvider defaultOpen={opts?.defaultOpen ?? true}>
        <AppSidebar
          role={role}
          user={MOCK_USER}
          orgId={opts?.orgId}
          permissionLevel={opts?.permissionLevel}
        />
      </SidebarProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  mockPathname = "/"
  mockUnread = 0
})

describe("AppSidebar", () => {
  describe("buyer role", () => {
    it("shows dashboard, discover, meetings, notifications, profile", () => {
      renderSidebar("buyer")
      expect(screen.getByText("대시보드")).toBeInTheDocument()
      expect(screen.getByText("기업 탐색")).toBeInTheDocument()
      expect(screen.getByText("미팅")).toBeInTheDocument()
      expect(screen.getByText("알림")).toBeInTheDocument()
      expect(screen.getByText("프로필")).toBeInTheDocument()
    })

    it("does not show organizer-only items", () => {
      renderSidebar("buyer")
      expect(screen.queryByText("참가기업 관리")).not.toBeInTheDocument()
      expect(screen.queryByText("비즈매칭 배정")).not.toBeInTheDocument()
    })
  })

  describe("exhibitor role", () => {
    it("shows discover and profile", () => {
      renderSidebar("exhibitor")
      expect(screen.getByText("기업 탐색")).toBeInTheDocument()
      expect(screen.getByText("프로필")).toBeInTheDocument()
    })
  })

  describe("organizer role", () => {
    it("shows ops dashboard, member management, matching assignment", () => {
      renderSidebar("organizer", { permissionLevel: "master" })
      expect(screen.getByText("운영 대시보드")).toBeInTheDocument()
      expect(screen.getByText("참가기업 관리")).toBeInTheDocument()
      expect(screen.getByText("비즈매칭 배정")).toBeInTheDocument()
    })

    it("does not show participant-only items", () => {
      renderSidebar("organizer")
      expect(screen.queryByText("기업 탐색")).not.toBeInTheDocument()
      expect(screen.queryByText("프로필")).not.toBeInTheDocument()
    })

    it("운영자 알림은 미제공 — 알림 메뉴를 노출하지 않는다", () => {
      renderSidebar("organizer")
      expect(screen.queryByText("알림")).not.toBeInTheDocument()
    })

    // #14: /organizer에서 /admin으로 가는 링크가 없어 발주자가 슈퍼어드민 콘솔의 존재를 몰랐다.
    it("관리자 콘솔(/admin)로 건너가는 링크가 있다(master)", () => {
      renderSidebar("organizer", { permissionLevel: "master" })
      expect(screen.getByRole("link", { name: "관리자 콘솔" })).toHaveAttribute("href", "/admin")
    })

    // 2026-09-17: sub(무역관)가 배정·관리자 콘솔 링크를 눌러 master 전용 403 오류 화면에 갇히던 결함.
    it("sub에겐 master 전용 메뉴(비즈매칭 배정·관리자 콘솔)를 노출하지 않는다", () => {
      renderSidebar("organizer", { permissionLevel: "sub" })
      expect(screen.getByRole("link", { name: "운영 대시보드" })).toHaveAttribute("href", "/organizer")
      expect(screen.getByRole("link", { name: "참가기업 관리" })).toHaveAttribute("href", "/organizer/members")
      expect(screen.queryByText("비즈매칭 배정")).not.toBeInTheDocument()
      expect(screen.queryByText("관리자 콘솔")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument()
    })

    it("권한등급을 모르면(조회 실패) 최소 권한 — master 전용 메뉴를 숨긴다", () => {
      renderSidebar("organizer")
      expect(screen.getByText("참가기업 관리")).toBeInTheDocument()
      expect(screen.queryByText("비즈매칭 배정")).not.toBeInTheDocument()
      expect(screen.queryByRole("link", { name: "관리자 콘솔" })).not.toBeInTheDocument()
    })

    it("참가자(buyer/exhibitor)에겐 관리자 콘솔 링크를 노출하지 않는다", () => {
      renderSidebar("buyer")
      expect(screen.queryByText("관리자 콘솔")).not.toBeInTheDocument()
    })
  })

  describe("현재 메뉴 활성 표시", () => {
    it("현재 경로의 메뉴만 active(aria-current=page)로 표시한다", () => {
      mockPathname = "/discover"
      renderSidebar("buyer")

      const discover = screen.getByRole("link", { name: "기업 탐색" })
      expect(discover).toHaveAttribute("aria-current", "page")
      expect(discover).toHaveAttribute("data-active", "true")

      const dashboard = screen.getByRole("link", { name: "대시보드" })
      expect(dashboard).not.toHaveAttribute("aria-current")
      expect(dashboard).toHaveAttribute("data-active", "false")
    })

    it("하위 경로(/discover/123)에서도 상위 메뉴가 active로 유지된다", () => {
      mockPathname = "/discover/org-1"
      renderSidebar("buyer")
      expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("data-active", "true")
    })

    it("루트(/)에서는 대시보드만 active다", () => {
      mockPathname = "/"
      renderSidebar("buyer")
      expect(screen.getByRole("link", { name: "대시보드" })).toHaveAttribute("data-active", "true")
      expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("data-active", "false")
    })
  })

  describe("isActiveNav 경로 매칭", () => {
    it("대시보드(/)는 정확히 일치할 때만 active", () => {
      expect(isActiveNav("/", "/")).toBe(true)
      expect(isActiveNav("/discover", "/")).toBe(false)
    })

    it("일반 메뉴는 자기 자신과 하위 경로에서 active", () => {
      expect(isActiveNav("/discover", "/discover")).toBe(true)
      expect(isActiveNav("/discover/org-1", "/discover")).toBe(true)
      expect(isActiveNav("/meetings", "/discover")).toBe(false)
    })

    it("접두사만 같은 다른 경로는 active가 아니다", () => {
      expect(isActiveNav("/discovery", "/discover")).toBe(false)
    })
  })

  describe("알림 벨 배지 (NT-001)", () => {
    it("안읽음>0이면 알림 항목에 개수 배지를 노출한다", () => {
      mockUnread = 3
      renderSidebar("buyer")
      expect(screen.getByLabelText("안읽은 알림 3개")).toHaveTextContent("3개")
    })

    it("안읽음이 0이면 배지를 노출하지 않는다", () => {
      mockUnread = 0
      renderSidebar("buyer")
      expect(screen.queryByLabelText(/안읽은 알림/)).not.toBeInTheDocument()
    })

    it("운영자는 알림 항목 자체가 없어 배지도 없다", () => {
      mockUnread = 5
      renderSidebar("organizer")
      expect(screen.queryByText("알림")).not.toBeInTheDocument()
      expect(screen.queryByLabelText(/안읽은 알림/)).not.toBeInTheDocument()
    })
  })

  describe("접힘(아이콘 레일)에서도 아이콘으로 이동 가능", () => {
    it("collapsed 상태에서도 nav 링크가 올바른 href로 렌더돼 이동할 수 있다", () => {
      renderSidebar("buyer", { defaultOpen: false })
      expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("href", "/discover")
      expect(screen.getByRole("link", { name: "미팅" })).toHaveAttribute("href", "/meetings")
      expect(screen.getByRole("link", { name: "프로필" })).toHaveAttribute("href", "/profile")
    })
  })

  describe("user info footer", () => {
    it("shows user name, affiliation, email, phone", () => {
      renderSidebar("buyer")
      expect(screen.getByText("김바이어")).toBeInTheDocument()
      expect(screen.getByText("한화에어로스페이스")).toBeInTheDocument()
      expect(screen.getByText("buyer01@hanwha.com")).toBeInTheDocument()
      expect(screen.getByText("010-1234-5678")).toBeInTheDocument()
    })
  })

  describe("운영사무국 상시 문의 (F-NV-001)", () => {
    const triggerName = `${SECRETARIAT_CONTACT.org} 문의하기`

    it("참가사(exhibitor)는 '문의하기' 한 줄로 접혀 있고, 열면 tel:/mailto: 링크가 뜬다", async () => {
      renderSidebar("exhibitor")
      // 기본은 접힘(팝오버 닫힘) — 연락처 링크는 DOM에 없다(푸터가 내 정보와 안 겹치게 한 줄로 축소).
      expect(screen.queryByRole("link", { name: SECRETARIAT_CONTACT.phone })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole("button", { name: triggerName }))

      expect(screen.getByRole("link", { name: SECRETARIAT_CONTACT.phone })).toHaveAttribute(
        "href",
        `tel:${SECRETARIAT_CONTACT.phone}`,
      )
      expect(screen.getByRole("link", { name: SECRETARIAT_CONTACT.email })).toHaveAttribute(
        "href",
        `mailto:${SECRETARIAT_CONTACT.email}`,
      )
    })

    it("바이어(buyer)에게도 '문의하기' 트리거를 노출한다", () => {
      renderSidebar("buyer")
      expect(screen.getByRole("button", { name: triggerName })).toBeInTheDocument()
    })

    it("운영자(=사무국 본인)에겐 노출하지 않는다", () => {
      renderSidebar("organizer")
      expect(screen.queryByRole("button", { name: triggerName })).not.toBeInTheDocument()
    })
  })

  describe("로그아웃", () => {
    it("모든 역할의 footer에 로그아웃 버튼이 있다", () => {
      renderSidebar("organizer")
      expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument()
    })

    it("클릭하면 세션을 종료하고 /login으로 이동한다", async () => {
      mockPush.mockClear()
      const logoutSpy = vi.spyOn(sessionApiClient, "logout")
      renderSidebar("buyer")

      await userEvent.click(screen.getByRole("button", { name: "로그아웃" }))

      expect(logoutSpy).toHaveBeenCalledOnce()
      expect(mockPush).toHaveBeenCalledWith("/login")
      logoutSpy.mockRestore()
    })
  })
})

describe("AppSidebar — nav 링크는 bare href (세션은 쿠키)", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/")
  })

  it("URL에 ?as가 있어도 nav 링크에 ?as를 싣지 않는다(세션은 nabi_dev_as 쿠키)", () => {
    window.history.replaceState({}, "", "/organizer/members?as=organizer")
    renderSidebar("organizer")
    expect(screen.getByRole("link", { name: "참가기업 관리" })).toHaveAttribute(
      "href",
      "/organizer/members",
    )
  })

  it("일반 링크도 bare href다", () => {
    renderSidebar("buyer")
    expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("href", "/discover")
  })
})
