import { render, screen } from "@/lib/test/render-with-intl"
import { describe, expect, it } from "vitest"

import { MeetingEmptyStateView } from "./meeting-empty-state"
import { resolveMeetingEmptyState } from "@/lib/meeting/empty-state"
import { koTranslator } from "@/lib/i18n/ko-translator"

// MY-001 미팅 0건 빈 상태 — 다음 행동(기업 탐색으로 가는 버튼)이 있을 때만 버튼 영역을 그린다.
// 어떤 상태를 낼지는 empty-state 모듈이 정하고(참가자 메뉴에 따라 갈린다, F-NV-001 D15), 이 컴포넌트는
// 받은 상태를 그대로 그린다.
const koT = koTranslator("meeting.emptyState")

describe("MeetingEmptyStateView", () => {
  it("전체 메뉴: 안내와 함께 기업 탐색으로 가는 버튼을 그린다", () => {
    render(<MeetingEmptyStateView state={resolveMeetingEmptyState("buyer", koT, "full")} />)

    expect(screen.getByText("아직 잡힌 미팅이 없어요")).toBeInTheDocument()
    expect(screen.getByText("관심 있는 참가 기업을 탐색하고 미팅을 신청해보세요.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "관심 기업 탐색" })).toHaveAttribute("href", "/discover")
  })

  it.each(["buyer", "exhibitor"] as const)("미팅만(%s): 안내만 그리고 링크·버튼이 하나도 없다", (role) => {
    const { container } = render(
      <MeetingEmptyStateView state={resolveMeetingEmptyState(role, koT, "meetings_only")} />,
    )

    expect(screen.getByText("아직 잡힌 미팅이 없어요")).toBeInTheDocument()
    expect(screen.getByText("미팅이 잡히면 여기에 표시돼요.")).toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    // 버튼이 없을 때 빈 버튼 영역(EmptyContent)이 여백만 남기지 않는다.
    expect(container.querySelector('[data-slot="empty-content"]')).toBeNull()
  })

  it("보조 행동만 있는 상태도 그린다(버튼 영역은 행동이 하나라도 있으면 나온다)", () => {
    render(
      <MeetingEmptyStateView
        state={{ title: "제목", description: "설명", secondary: { label: "보조", href: "/somewhere" } }}
      />,
    )

    expect(screen.getByRole("link", { name: "보조" })).toHaveAttribute("href", "/somewhere")
  })
})
