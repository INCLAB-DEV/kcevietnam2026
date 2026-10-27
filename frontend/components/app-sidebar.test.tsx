import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar, isActiveNav, type SidebarUser } from "./app-sidebar"
import { SECRETARIAT_CONTACT } from "@/components/layout/nav"
import { CURRENT_EVENT } from "@/lib/event/current-event"
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
    // 행사의 참가자 메뉴(F-NV-001 D15). 생략하면 컴포넌트 기본값(미팅만)이다 — 메뉴 5개를 전제하는
    // 테스트는 "full"을 명시한다(FULL_MENU).
    participantMenu?: Parameters<typeof AppSidebar>[0]["participantMenu"]
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
          participantMenu={opts?.participantMenu}
        />
      </SidebarProvider>
    </TooltipProvider>,
  )
}

// 전체 메뉴로 설정한 행사 — 참가사·바이어 nav 5개(이 설정이 생기기 전의 사이드바).
const FULL_MENU = { participantMenu: "full" } as const

beforeEach(() => {
  mockPathname = "/"
  mockUnread = 0
})

describe("AppSidebar", () => {
  describe("buyer role", () => {
    it("shows dashboard, discover, meetings, notifications, profile", () => {
      renderSidebar("buyer", FULL_MENU)
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
      renderSidebar("exhibitor", FULL_MENU)
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
      renderSidebar("buyer", FULL_MENU)

      const discover = screen.getByRole("link", { name: "기업 탐색" })
      expect(discover).toHaveAttribute("aria-current", "page")
      expect(discover).toHaveAttribute("data-active", "true")

      const dashboard = screen.getByRole("link", { name: "대시보드" })
      expect(dashboard).not.toHaveAttribute("aria-current")
      expect(dashboard).toHaveAttribute("data-active", "false")
    })

    it("하위 경로(/discover/123)에서도 상위 메뉴가 active로 유지된다", () => {
      mockPathname = "/discover/org-1"
      renderSidebar("buyer", FULL_MENU)
      expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("data-active", "true")
    })

    it("루트(/)에서는 대시보드만 active다", () => {
      mockPathname = "/"
      renderSidebar("buyer", FULL_MENU)
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
      renderSidebar("buyer", FULL_MENU)
      expect(screen.getByLabelText("안읽은 알림 3개")).toHaveTextContent("3개")
    })

    it("안읽음이 0이면 배지를 노출하지 않는다", () => {
      mockUnread = 0
      renderSidebar("buyer", FULL_MENU)
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
      renderSidebar("buyer", { defaultOpen: false, ...FULL_MENU })
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
    // 기관명은 행사명(로케일별)에 nav.secretariatOrg를 입혀 만든다 — ko는 "{행사명} 사무국".
    const triggerName = `${CURRENT_EVENT.ko.name} 사무국 문의하기`

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

// 참가자 메뉴(F-NV-001 D15) — 행사 설정이 "미팅만"(기본)이면 참가사·바이어 사이드바에 미팅 한 항목만 남는다.
// 사이드바 아래쪽(내 정보·사무국 문의·언어/테마 토글·로그아웃)은 그대로다.
describe("AppSidebar — 참가자 메뉴 '미팅만'", () => {
  const HIDDEN_LABELS = ["대시보드", "기업 탐색", "알림", "프로필"]

  function navLinks() {
    return screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])
  }

  it.each(["buyer", "exhibitor"] as const)("%s: 기본값(설정을 넘기지 않음)이면 메뉴는 '미팅' 하나다", (role) => {
    renderSidebar(role)

    expect(navLinks()).toEqual([["미팅", "/meetings"]])
    for (const label of HIDDEN_LABELS) expect(screen.queryByText(label)).not.toBeInTheDocument()
  })

  it.each(["buyer", "exhibitor"] as const)("%s: meetings_only를 명시해도 같다", (role) => {
    renderSidebar(role, { participantMenu: "meetings_only" })

    expect(navLinks()).toEqual([["미팅", "/meetings"]])
  })

  it("미팅 화면에서는 그 한 항목이 active다", () => {
    mockPathname = "/meetings"
    renderSidebar("buyer")

    expect(screen.getByRole("link", { name: "미팅" })).toHaveAttribute("aria-current", "page")
  })

  it("숨긴 화면에 주소로 들어와도 사이드바는 그대로다 — active 항목만 없다", () => {
    mockPathname = "/discover"
    renderSidebar("buyer")

    expect(navLinks()).toEqual([["미팅", "/meetings"]])
    expect(screen.getByRole("link", { name: "미팅" })).not.toHaveAttribute("aria-current")
  })

  it("알림 메뉴가 없으므로 안읽음이 있어도 배지를 그리지 않는다", () => {
    mockUnread = 4
    renderSidebar("buyer")

    expect(screen.queryByLabelText(/안읽은 알림/)).not.toBeInTheDocument()
  })

  it("사이드바 아래쪽은 그대로다 — 내 정보·사무국 문의·언어/테마 토글·로그아웃", () => {
    renderSidebar("exhibitor")

    expect(screen.getByText("김바이어")).toBeInTheDocument()
    expect(screen.getByText("한화에어로스페이스")).toBeInTheDocument()
    expect(screen.getByText("buyer01@hanwha.com")).toBeInTheDocument()
    expect(screen.getByText("010-1234-5678")).toBeInTheDocument()
    expect(screen.getByText("운영사무국 문의하기")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "언어 선택" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "화면 밝기" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument()
  })

  it("접힘(아이콘 레일)에서도 미팅으로 이동할 수 있다", () => {
    renderSidebar("buyer", { defaultOpen: false })

    expect(screen.getByRole("link", { name: "미팅" })).toHaveAttribute("href", "/meetings")
  })

  it("운영자 nav는 이 설정과 무관하다", () => {
    renderSidebar("organizer", { permissionLevel: "master", participantMenu: "meetings_only" })

    expect(screen.getByRole("link", { name: "운영 대시보드" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "참가기업 관리" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "비즈매칭 배정" })).toBeInTheDocument()
  })
})

// 프로필 메뉴가 없는 "미팅만" 행사에서는 비밀번호를 바꿀 길(프로필 화면의 버튼)이 사라진다 — 그때만
// 사이드바의 내 정보 블록에 같은 다이얼로그를 여는 작은 텍스트 버튼을 둔다.
describe("AppSidebar — 비밀번호 변경 진입점", () => {
  it.each(["buyer", "exhibitor"] as const)("%s: '미팅만'이면 내 정보 블록에 버튼이 있고, 누르면 다이얼로그가 열린다", async (role) => {
    renderSidebar(role)

    const trigger = screen.getByRole("button", { name: "비밀번호 변경" })
    // 내 정보(이름·소속·이메일·전화)와 같은 블록 안에 있다.
    expect(trigger.parentElement).toContainElement(screen.getByText("buyer01@hanwha.com"))

    await userEvent.click(trigger)

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("현재 비밀번호")
    expect(dialog).toHaveTextContent("새 비밀번호 확인")
  })

  it("전체 메뉴 행사에는 두지 않는다 — 프로필 화면에 이미 있다(사이드바는 예전 그대로)", () => {
    renderSidebar("buyer", FULL_MENU)

    expect(screen.queryByRole("button", { name: "비밀번호 변경" })).not.toBeInTheDocument()
  })

  it("운영자에게는 두지 않는다", () => {
    renderSidebar("organizer", { participantMenu: "meetings_only" })

    expect(screen.queryByRole("button", { name: "비밀번호 변경" })).not.toBeInTheDocument()
  })

  it("내 정보가 비어 있어도(실 세션에서 필드를 못 받음) 버튼은 남는다", () => {
    render(
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar role="buyer" user={{ name: null, affiliation: null, email: null, phone: null }} />
        </SidebarProvider>
      </TooltipProvider>,
    )

    expect(screen.getByRole("button", { name: "비밀번호 변경" })).toBeInTheDocument()
  })
})

// 운영자 콘솔은 한국어 고정이다(app/organizer/layout.tsx의 ConsoleIntlProvider) — 언어 토글을 눌러도 화면이
// 바뀌지 않으므로 운영자에게는 그리지 않는다. 참가사·바이어의 토글은 그대로다.
describe("AppSidebar — 언어 토글", () => {
  it("운영자에게는 언어 토글이 없다(master·sub·등급 미상 모두)", () => {
    for (const permissionLevel of ["master", "sub", undefined] as const) {
      const { unmount } = renderSidebar("organizer", { permissionLevel })
      expect(screen.queryByRole("group", { name: "언어 선택" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "KO" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "EN" })).not.toBeInTheDocument()
      unmount()
    }
  })

  it("운영자에게도 화면 밝기 토글은 그대로 있다", () => {
    renderSidebar("organizer", { permissionLevel: "master" })

    expect(screen.getByRole("group", { name: "화면 밝기" })).toBeInTheDocument()
  })

  it.each([
    ["buyer", "full"],
    ["buyer", "meetings_only"],
    ["exhibitor", "full"],
    ["exhibitor", "meetings_only"],
  ] as const)("참가자(%s, 메뉴 %s)의 언어 토글은 그대로다", (role, participantMenu) => {
    renderSidebar(role, { participantMenu })

    const toggle = screen.getByRole("group", { name: "언어 선택" })
    expect(toggle).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "KO" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "false")
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
    renderSidebar("buyer", FULL_MENU)
    expect(screen.getByRole("link", { name: "기업 탐색" })).toHaveAttribute("href", "/discover")
  })
})
