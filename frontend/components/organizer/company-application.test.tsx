import { render as rtlRender, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"
import { CompanyApplication } from "./company-application"
import enMessages from "@/messages/en.json"
import type { Organization } from "@/lib/types"

const buyerOrg: Organization = { id: "org-buyer-1", name: "테스트바이어", role: "buyer", keywords: [] }
const exhibitorOrg: Organization = {
  id: "org-ex-1",
  name: "테스트참가사",
  role: "exhibitor",
  keywords: [],
}

// 이슈 #7 — ProfileView·StepReview는 참가자 화면과 공유하는 컴포넌트라 useTranslations/useLocale로
// 전역 locale(사이드바 토글, 모든 역할에 노출)을 따른다. 운영자 콘솔(CompanyApplication)은 언제나
// 한국어여야 하므로(CLAUDE.md), 전역 locale이 en이어도 이 서브트리는 ko로 고정돼야 한다.
describe("CompanyApplication — 운영자 콘솔은 전역 locale 토글의 영향을 받지 않는다", () => {
  it("전역 locale=en이어도 바이어 StepReview는 한국어 라벨을 그대로 보여준다", () => {
    rtlRender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompanyApplication org={buyerOrg} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("소속")).toBeInTheDocument()
    expect(screen.queryByText("Organization")).not.toBeInTheDocument()
  })

  it("전역 locale=en이어도 참가사 ProfileView는 한국어 라벨을 그대로 보여준다", () => {
    rtlRender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompanyApplication org={exhibitorOrg} />
      </NextIntlClientProvider>
    )
    expect(screen.getAllByText("기본정보").length).toBeGreaterThan(0)
    // en 라벨은 카탈로그에서 직접 읽는다 — 문구(대소문자 포함)가 바뀌어도 이 회귀 가드가 헛돌지 않게.
    expect(screen.queryByText(enMessages.applyExhibitor.profileView.tabBasic)).not.toBeInTheDocument()
  })
})
