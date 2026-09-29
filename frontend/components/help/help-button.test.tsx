import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, beforeEach, vi } from "vitest"

import { HelpButton } from "./help-button"

// usePathname 을 시나리오별로 갈아끼운다(app-sidebar.test.tsx 와 동일 패턴).
let mockPathname = "/"
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}))

const HELP_LABEL = "도움말"
const STEPS_HEADING = "이렇게 하세요"

beforeEach(() => {
  mockPathname = "/"
})

describe("HelpButton", () => {
  it("도움말 버튼을 렌더하고, 열기 전에는 패널 내용이 없다", () => {
    render(<HelpButton role="buyer" />)

    expect(screen.getByRole("button", { name: HELP_LABEL })).toBeInTheDocument()
    // Sheet(Radix Dialog)는 닫힘 상태에서 콘텐츠를 마운트하지 않는다.
    expect(screen.queryByText(STEPS_HEADING)).not.toBeInTheDocument()
  })

  it("클릭하면 현재 화면(홈·바이어)에 맞는 가이드 패널이 열린다", async () => {
    mockPathname = "/"
    render(<HelpButton role="buyer" />)

    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))

    // 다이얼로그(패널)가 뜨고 제목·단계 헤딩·단계 항목이 보인다.
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("홈 대시보드")).toBeInTheDocument()
    expect(screen.getByText(STEPS_HEADING)).toBeInTheDocument()
    expect(
      screen.getByText(/미팅 현황에서 예정·보낸 요청·받은 요청·완료 건수를 확인/),
    ).toBeInTheDocument()
  })

  it("같은 라우트라도 역할에 따라 다른 콘텐츠를 보여준다(discover buyer↔exhibitor)", async () => {
    mockPathname = "/discover"

    const { unmount } = render(<HelpButton role="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))
    expect(screen.getByText(/참가 기업을 둘러보고/)).toBeInTheDocument()
    unmount()

    render(<HelpButton role="exhibitor" />)
    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))
    expect(screen.getByText(/참관 바이어를 둘러보고/)).toBeInTheDocument()
  })

  it("운영자 화면 콘텐츠를 라우트로 판정한다(/organizer/forced-matching)", async () => {
    mockPathname = "/organizer/forced-matching"
    render(<HelpButton role="organizer" />)

    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))

    expect(screen.getByText("비즈매칭 배정")).toBeInTheDocument()
  })

  it("매칭되는 화면이 없으면 역할별 일반 도움말로 폴백한다", async () => {
    mockPathname = "/some/unknown/route"
    render(<HelpButton role="organizer" />)

    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))

    expect(screen.getByText("NABI 운영자 도움말")).toBeInTheDocument()
  })

  it("ESC 로 패널을 닫을 수 있다(접근성)", async () => {
    mockPathname = "/"
    render(<HelpButton role="buyer" />)

    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    await userEvent.keyboard("{Escape}")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByText(STEPS_HEADING)).not.toBeInTheDocument()
  })

  it("닫기 버튼으로도 패널을 닫는다", async () => {
    mockPathname = "/"
    render(<HelpButton role="buyer" />)

    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))
    await screen.findByRole("dialog")

    await userEvent.click(screen.getByRole("button", { name: "닫기" }))

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it.each(["/login", "/signup", "/login/callback"])(
    "비인증 화면(%s)에서는 버튼을 렌더하지 않는다",
    (path) => {
      mockPathname = path
      render(<HelpButton role="buyer" />)
      expect(screen.queryByRole("button", { name: HELP_LABEL })).not.toBeInTheDocument()
    },
  )
})
