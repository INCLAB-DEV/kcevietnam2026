import { render, screen, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OrgDetailProvider, useOrgDetail } from "./org-detail-modal"
import { MeetingRequestProvider } from "@/components/meeting/meeting-request-provider"
import { __resetBookmarksForTest } from "@/lib/discover/bookmark-store"
import { MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { withParticipantMenu } from "@/lib/test/with-participant-menu"

// 기업 상세 모달(DV-002) — 미팅 화면의 "기업 상세 보기"와 기업 탐색의 카드가 같은 모달을 연다.
// 참가자 메뉴(F-NV-001 D15)에 따라 하단 액션(관심기업 토글·미팅 신청)이 갈린다: 전체 메뉴에서는 예전
// 그대로 있고, "미팅만"(기본)에서는 본문만 보여준다.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))

const exhibitor = MOCK_EXHIBITORS[0]

// 셸(AppShell)과 같은 중첩: 미팅 신청 호스트 > 상세 모달 호스트 > 화면.
function Screen() {
  const { open } = useOrgDetail()
  return (
    <button type="button" onClick={() => open(exhibitor, { viewerRole: "buyer" })}>
      상세 열기
    </button>
  )
}

function shell() {
  return (
    <MeetingRequestProvider>
      <OrgDetailProvider>
        <Screen />
      </OrgDetailProvider>
    </MeetingRequestProvider>
  )
}

async function openModal() {
  await userEvent.click(screen.getByRole("button", { name: "상세 열기" }))
  return screen.findByRole("dialog")
}

beforeEach(() => {
  __resetBookmarksForTest()
})

describe("OrgDetailProvider — 기업 상세 모달", () => {
  it("전체 메뉴: 본문 아래에 관심기업 토글과 미팅 신청이 있다(예전 그대로)", async () => {
    render(withParticipantMenu("full", shell()))

    const dialog = await openModal()

    expect(within(dialog).getByRole("heading", { name: exhibitor.name })).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "관심기업" })).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "미팅 신청" })).toBeInTheDocument()
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull()
  })

  it.each([
    ["기본값(provider 없음)", (ui: React.ReactElement) => ui],
    ["meetings_only 명시", (ui: React.ReactElement) => withParticipantMenu("meetings_only", ui)],
  ])("미팅만 — %s: 본문은 그대로 열리고 미팅 신청·관심기업은 없다", async (_label, wrap) => {
    render(wrap(shell()))

    const dialog = await openModal()

    // "기업 상세 보기"는 유지된다 — 기업명과 본문 필드가 보인다.
    expect(within(dialog).getByRole("heading", { name: exhibitor.name })).toBeInTheDocument()
    expect(within(dialog).getByText("오리지널 애니메이션 시리즈 '스타빔레인저'")).toBeInTheDocument()
    // 두 액션이 없고, 액션을 담던 푸터도 통째로 없다(빈 구분선이 남지 않는다).
    expect(within(dialog).queryByRole("button", { name: "미팅 신청" })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: /관심기업/ })).not.toBeInTheDocument()
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toBeNull()
    // 닫기는 남는다.
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeInTheDocument()
  })
})
