import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, beforeEach, vi } from "vitest"

import { HelpButton } from "./help-button"
import { withParticipantMenu } from "@/lib/test/with-participant-menu"

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

    expect(screen.getByText("Sales AI 운영자 도움말")).toBeInTheDocument()
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

// 참가자 메뉴가 "미팅만"(기본)인 행사에서는 대시보드·기업 탐색·알림·프로필이 메뉴에 없다 — 도움말이 그
// 메뉴를 안내하지 않게 해당 항목만 대체 문구로 바뀐다(F-NV-001 D15). 값은 셸이 컨텍스트로 내려주고,
// 셸 밖 화면(/welcome)은 prop으로 직접 받는다.
describe("HelpButton — 참가자 메뉴에 따른 문구", () => {
  async function openHelp() {
    await userEvent.click(screen.getByRole("button", { name: HELP_LABEL }))
    return screen.findByRole("dialog")
  }

  it("미팅 화면(바이어) — 기본값이면 '빈 시간대 → 기업 탐색' 팁 대신 중립 팁이 나온다", async () => {
    mockPathname = "/meetings"
    render(<HelpButton role="buyer" />)

    const panel = await openHelp()

    expect(panel).toHaveTextContent("내 미팅")
    expect(panel).toHaveTextContent("빈 시간대는 아직 미팅이 잡히지 않은 시간입니다.")
    expect(panel).not.toHaveTextContent("기업 탐색")
    // 바뀌지 않는 부분(단계 안내)은 그대로다.
    expect(panel).toHaveTextContent("상세 패널에서 수락·거절·취소로 응답하세요.")
  })

  it("미팅 화면(바이어) — 전체 메뉴면 원래 팁 그대로다", async () => {
    mockPathname = "/meetings"
    render(withParticipantMenu("full", <HelpButton role="buyer" />))

    const panel = await openHelp()

    expect(panel).toHaveTextContent("빈 시간대를 누르면 그 시간을 채울 기업 탐색으로 바로 이동합니다.")
    expect(panel).not.toHaveTextContent("아직 미팅이 잡히지 않은 시간")
  })

  it("미팅 화면(참가사) — 숨긴 메뉴를 안내하는 항목이 없어 두 모드의 문구가 같다", async () => {
    mockPathname = "/meetings"
    const { unmount } = render(withParticipantMenu("full", <HelpButton role="exhibitor" />))
    const full = (await openHelp()).textContent
    unmount()

    render(withParticipantMenu("meetings_only", <HelpButton role="exhibitor" />))
    const meetingsOnly = (await openHelp()).textContent

    expect(meetingsOnly).toBe(full)
    expect(meetingsOnly).not.toMatch(/기업 탐색|대시보드|알림함|프로필/)
  })

  it.each(["buyer", "exhibitor"] as const)("일반 도움말(%s) — 기본값이면 메뉴 5개를 나열하지 않는다", async (role) => {
    mockPathname = "/some/unknown/route"
    render(<HelpButton role={role} />)

    const panel = await openHelp()

    expect(panel).toHaveTextContent("왼쪽 사이드바의 미팅에서 내 미팅 일정을 확인하세요.")
    expect(panel).not.toHaveTextContent("홈·기업 탐색·미팅·알림·프로필")
    expect(panel).not.toHaveTextContent("기업 탐색에서 원하는 기업에 미팅을 신청하세요.")
  })

  it("일반 도움말(바이어) — 전체 메뉴면 원래 안내 그대로다", async () => {
    mockPathname = "/some/unknown/route"
    render(withParticipantMenu("full", <HelpButton role="buyer" />))

    const panel = await openHelp()

    expect(panel).toHaveTextContent("왼쪽 사이드바에서 홈·기업 탐색·미팅·알림·프로필로 이동하세요.")
    expect(panel).toHaveTextContent("기업 탐색에서 원하는 기업에 미팅을 신청하세요.")
  })

  it("입장 전 화면(/welcome)은 셸 밖이라 prop으로 받는다 — 미팅만이면 '미팅 화면으로 입장'", async () => {
    mockPathname = "/welcome"
    render(<HelpButton role="buyer" participantMenu="meetings_only" />)

    const panel = await openHelp()

    expect(panel).toHaveTextContent("승인되면 자동으로 미팅 화면으로 입장합니다.")
    expect(panel).not.toHaveTextContent("홈 화면으로 입장")
  })

  it("prop이 컨텍스트보다 우선한다 — /welcome에 전체 메뉴를 넘기면 '홈 화면으로 입장'", async () => {
    mockPathname = "/welcome"
    render(withParticipantMenu("meetings_only", <HelpButton role="exhibitor" participantMenu="full" />))

    const panel = await openHelp()

    expect(panel).toHaveTextContent("승인되고 신청기간이 끝나면 자동으로 홈 화면으로 입장합니다.")
  })

  it("숨긴 화면에 주소로 들어갔을 때는 그 화면의 도움말이 그대로 나온다(대체 대상이 아니다)", async () => {
    mockPathname = "/discover"
    render(<HelpButton role="buyer" />)

    const panel = await openHelp()

    expect(panel).toHaveTextContent("참가 기업을 둘러보고 마음에 드는 곳에 미팅을 신청하는 화면입니다.")
  })

  it("운영자 도움말은 참가자 메뉴와 무관하다", async () => {
    mockPathname = "/organizer"
    const { unmount } = render(withParticipantMenu("full", <HelpButton role="organizer" />))
    const full = (await openHelp()).textContent
    unmount()

    render(withParticipantMenu("meetings_only", <HelpButton role="organizer" />))

    expect((await openHelp()).textContent).toBe(full)
  })
})
