import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider, useLocale, useTranslations } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { ConsoleIntlProvider } from "./console-intl-provider"
import { AppSidebar } from "@/components/app-sidebar"
import { HelpButton } from "@/components/help/help-button"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/messages/en.json"
import koMessages from "@/messages/ko.json"

// 운영자·관리자 콘솔의 한국어 고정(ConsoleIntlProvider). 콘솔 본문은 한국어 하드코딩인데, 참가자 화면과
// 함께 쓰는 조각(사이드바 라벨·도움말·다이얼로그 닫기 라벨 등)은 next-intl로 문구를 뽑는다. 쿠키가 en이면
// 그 조각들만 영어가 돼 화면이 반쪽씩 섞였다 — 콘솔 레이아웃이 이 provider로 감싸 쿠키와 무관하게 ko로 묶는다.
//
// 여기서는 "쿠키가 en인 요청"을 바깥 provider(locale="en", en 카탈로그)로 재현한다 — 루트 레이아웃의
// NextIntlClientProvider가 하는 일이다.

vi.mock("next/navigation", () => ({
  usePathname: () => "/organizer",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/lib/notifications/use-notifications", () => ({ useUnreadCount: () => 0 }))

function underEnglishCookie(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  )
}

function Probe() {
  const locale = useLocale()
  const tNav = useTranslations("nav")
  const tCommon = useTranslations("common")
  return (
    <p data-testid="probe">
      {locale}|{tNav("members")}|{tCommon("logout")}|{tCommon("close")}
    </p>
  )
}

const OPERATOR = { name: "운영자", affiliation: "사무국", email: "op@example.com", phone: null }

function sidebar() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar role="organizer" user={OPERATOR} permissionLevel="master" />
      </SidebarProvider>
    </TooltipProvider>
  )
}

describe("ConsoleIntlProvider — 콘솔은 쿠키와 무관하게 한국어", () => {
  it("대조군: provider가 없으면 쿠키(en)를 따라 영어가 된다", () => {
    underEnglishCookie(<Probe />)

    expect(screen.getByTestId("probe")).toHaveTextContent("en|Exhibitor Management|Log out|Close")
  })

  it("provider 안에서는 locale이 ko이고 문구가 ko 카탈로그에서 나온다", () => {
    underEnglishCookie(
      <ConsoleIntlProvider>
        <Probe />
      </ConsoleIntlProvider>,
    )

    expect(screen.getByTestId("probe")).toHaveTextContent(
      `ko|${koMessages.nav.members}|${koMessages.common.logout}|${koMessages.common.close}`,
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("ko|참가기업 관리|로그아웃|닫기")
  })

  it("바깥(루트) provider가 없어도 스스로 선다 — locale과 카탈로그를 직접 준다", () => {
    render(
      <ConsoleIntlProvider>
        <Probe />
      </ConsoleIntlProvider>,
    )

    expect(screen.getByTestId("probe")).toHaveTextContent("ko|참가기업 관리|로그아웃|닫기")
  })

  it("운영자 사이드바 — 메뉴 라벨·로그아웃·화면 밝기 라벨이 한국어다", () => {
    underEnglishCookie(<ConsoleIntlProvider>{sidebar()}</ConsoleIntlProvider>)

    expect(screen.getByRole("link", { name: "운영 대시보드" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "참가기업 관리" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "비즈매칭 배정" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "관리자 콘솔" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "화면 밝기" })).toBeInTheDocument()
    // 영어 라벨이 하나도 남지 않는다.
    for (const english of ["Ops Dashboard", "Exhibitor Management", "Matching Assignment", "Admin Console", "Log out"]) {
      expect(screen.queryByText(english)).not.toBeInTheDocument()
    }
  })

  it("대조군: provider가 없으면 같은 사이드바의 라벨이 영어로 섞인다(고치기 전의 결함)", () => {
    underEnglishCookie(sidebar())

    expect(screen.getByRole("link", { name: "Ops Dashboard" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument()
  })

  it("도움말 패널 — 버튼·제목·단계·닫기 라벨이 한국어다", async () => {
    underEnglishCookie(
      <ConsoleIntlProvider>
        <HelpButton role="organizer" />
      </ConsoleIntlProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "도움말" }))

    const panel = await screen.findByRole("dialog")
    expect(panel).toHaveTextContent("운영 대시보드")
    expect(panel).toHaveTextContent("이렇게 하세요")
    expect(panel).not.toHaveTextContent("Ops dashboard")
    // 시트의 닫기 라벨(components/ui/sheet.tsx — common.close)도 같은 provider를 본다.
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
  })
})
