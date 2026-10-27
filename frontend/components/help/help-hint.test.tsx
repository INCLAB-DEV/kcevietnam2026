import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect } from "vitest"

import { HelpHint } from "./help-hint"

describe("HelpHint — 호버 툴팁", () => {
  it("자식(트리거)을 그대로 렌더하고, 기본적으로 힌트는 숨어 있다", () => {
    render(
      <HelpHint hint="여기에 힌트">
        <button>대상 버튼</button>
      </HelpHint>
    )
    // asChild — 트리거는 감싼 버튼 그 자체다(추가 래퍼 없음).
    expect(
      screen.getByRole("button", { name: "대상 버튼" })
    ).toBeInTheDocument()
    // 열기 전에는 툴팁 텍스트가 보이지 않는다.
    expect(screen.queryByText("여기에 힌트")).not.toBeInTheDocument()
  })

  it("트리거에 호버하면 힌트가 뜬다", async () => {
    const user = userEvent.setup()
    render(
      <HelpHint hint="여기에 힌트" delayMs={0}>
        <button>대상 버튼</button>
      </HelpHint>
    )

    await user.hover(screen.getByRole("button", { name: "대상 버튼" }))

    // Radix Tooltip 은 접근성용 사본을 함께 렌더하므로 하나 이상 나타나면 성공.
    const shown = await screen.findAllByText("여기에 힌트")
    expect(shown.length).toBeGreaterThan(0)
  })

  it("트리거 포커스로도 힌트가 뜬다(키보드 접근성)", async () => {
    const user = userEvent.setup()
    render(
      <HelpHint hint="포커스 힌트" delayMs={0}>
        <button>포커스 대상</button>
      </HelpHint>
    )

    await user.tab()
    expect(screen.getByRole("button", { name: "포커스 대상" })).toHaveFocus()
    const shown = await screen.findAllByText("포커스 힌트")
    expect(shown.length).toBeGreaterThan(0)
  })
})
