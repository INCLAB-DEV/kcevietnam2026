import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider, useLocale, useTranslations } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/messages/en.json"

// 관리자 콘솔(/admin/*)의 한국어 고정. 본문은 한국어 하드코딩이지만 도움말 패널·명단 업로드 다이얼로그·
// 다이얼로그 닫기 라벨·테마 토글 같은 공용 조각은 next-intl을 쓴다 — 쿠키가 en이면 그 조각들만 영어가
// 돼 섞였다. 레이아웃이 크롬과 본문 전체를 ko 고정 provider로 감싸는지 본다(app/organizer/layout.test.tsx와
// 같은 방식 — 크롬은 얇게 목업하고, "쿠키가 en인 요청"은 바깥 provider로 재현한다).

vi.mock("@/components/admin/admin-shell", () => ({
  // 실제 크롬(사이드바·헤더·도움말)은 서버 조회가 붙어 있다 — 여기서는 children이 어디에 놓이는지만 본다.
  AdminConsoleLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="admin-chrome">
      <ChromeProbe />
      {children}
    </div>
  ),
}))

// 크롬 자리에서 읽은 문구 — 사이드바·도움말처럼 레이아웃이 그리는 조각도 고정 범위 안에 있어야 한다.
function ChromeProbe() {
  const t = useTranslations("help")
  return <p data-testid="chrome-probe">{t("buttonLabel")}</p>
}

function PageProbe() {
  const locale = useLocale()
  const t = useTranslations("rosterUpload")
  const tCommon = useTranslations("common")
  return <p data-testid="page-probe">{`${locale}|${t("trigger")}|${tCommon("close")}`}</p>
}

import AdminLayout from "./layout"

describe("AdminLayout — 한국어 고정", () => {
  it("쿠키가 en이어도 본문(페이지)은 ko 카탈로그를 본다", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AdminLayout>
          <PageProbe />
        </AdminLayout>
      </NextIntlClientProvider>,
    )

    // 명단 업로드 버튼 라벨·다이얼로그 닫기 라벨 — 예전엔 이 둘이 영어로 바뀌었다.
    expect(screen.getByTestId("page-probe")).toHaveTextContent("ko|명단 업로드|닫기")
  })

  it("레이아웃이 그리는 크롬(사이드바·도움말 자리)도 같은 고정 범위 안이다", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AdminLayout>
          <PageProbe />
        </AdminLayout>
      </NextIntlClientProvider>,
    )

    expect(screen.getByTestId("chrome-probe")).toHaveTextContent("도움말")
    expect(screen.getByTestId("admin-chrome")).toContainElement(screen.getByTestId("page-probe"))
  })

  it("대조군: 레이아웃 밖에서는 쿠키(en)를 따라 영어다", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PageProbe />
      </NextIntlClientProvider>,
    )

    expect(screen.getByTestId("page-probe")).toHaveTextContent(/^en\|/)
    expect(screen.getByTestId("page-probe")).not.toHaveTextContent("명단 업로드")
  })
})
