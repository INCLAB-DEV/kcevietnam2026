import { describe, expect, it, vi } from "vitest"
import { render as renderWithoutIntl } from "@testing-library/react"
import { NextIntlClientProvider, useLocale, useTranslations } from "next-intl"
import { render, screen } from "@/lib/test/render-with-intl"
import enMessages from "@/messages/en.json"

// /organizer 콘솔의 "권한 조회 실패" 배너(2026-09-21, lib/organizer/console-access 참고). 크롬
// (AppShellForRequest)은 무겁게 mock — 여기선 레이아웃 자신의 배너 배선만 검증한다
// (app/admin/sub-operator-admin.test.tsx와 같은 방식으로 셸을 얇게 목업).

const access = vi.hoisted(() => ({
  value: {
    realSession: true,
    permissionLevel: "sub" as const,
    permissionUnknown: false,
    session: { role: "organizer", permissionLevel: "sub", user: { name: "", affiliation: "", email: "", phone: "" }, tradeOffice: "" },
  },
}))

vi.mock("@/lib/organizer/console-access", () => ({
  resolveOrganizerConsoleAccess: async () => access.value,
}))
vi.mock("@/components/layout/app-shell", () => ({
  AppShellForRequest: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe("OrganizerLayout — 권한 조회 실패 배너", () => {
  it("permissionUnknown이면 배너를 보여준다(최소 권한은 유지)", async () => {
    access.value = { ...access.value, permissionUnknown: true }
    const { default: OrganizerLayout } = await import("./layout")

    render(await OrganizerLayout({ children: <div data-testid="body" /> }))

    expect(screen.getByText("권한 정보를 확인하지 못했습니다")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("확인된 등급(sub)이면 배너가 없다", async () => {
    access.value = { ...access.value, permissionUnknown: false }
    const { default: OrganizerLayout } = await import("./layout")

    render(await OrganizerLayout({ children: <div data-testid="body" /> }))

    expect(screen.queryByText("권한 정보를 확인하지 못했습니다")).not.toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })
})

// 콘솔은 한국어 전용이다. 사이드바 라벨·도움말·명단 업로드 다이얼로그처럼 next-intl을 쓰는 공용 조각이
// NEXT_LOCALE 쿠키(en)를 따라 영어로 바뀌어 한국어 본문과 섞이던 것을, 레이아웃이 ko 고정 provider로 감싸
// 막는다. "쿠키가 en인 요청"은 바깥 provider(locale="en")로 재현한다 — 루트 레이아웃이 하는 일이다.
describe("OrganizerLayout — 한국어 고정", () => {
  function LocaleProbe() {
    const locale = useLocale()
    const t = useTranslations("nav")
    return <p data-testid="probe">{`${locale}|${t("opsDashboard")}|${t("members")}`}</p>
  }

  it("쿠키가 en이어도 레이아웃 안쪽은 ko 카탈로그를 본다", async () => {
    access.value = { ...access.value, permissionUnknown: false }
    const { default: OrganizerLayout } = await import("./layout")

    renderWithoutIntl(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {await OrganizerLayout({ children: <LocaleProbe /> })}
      </NextIntlClientProvider>,
    )

    expect(screen.getByTestId("probe")).toHaveTextContent("ko|운영 대시보드|참가기업 관리")
  })

  it("권한 조회 실패 배너도 그 안에서 그려진다(크롬·본문 전체를 감싼다)", async () => {
    access.value = { ...access.value, permissionUnknown: true }
    const { default: OrganizerLayout } = await import("./layout")

    renderWithoutIntl(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {await OrganizerLayout({ children: <LocaleProbe /> })}
      </NextIntlClientProvider>,
    )

    expect(screen.getByText("권한 정보를 확인하지 못했습니다")).toBeInTheDocument()
    expect(screen.getByTestId("probe")).toHaveTextContent("ko|")
  })
})
