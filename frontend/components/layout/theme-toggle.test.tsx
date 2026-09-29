import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { ThemeToggle } from "./theme-toggle"

// next-themes는 <html> 클래스·localStorage를 만지는 provider가 있어야 동작한다 — 테스트에선 훅만 모킹해
// "고른 값(theme)"과 setTheme 호출만 검증한다.
const setTheme = vi.fn()
let mockTheme = "system"
let mockResolvedTheme = "dark"
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mockTheme, resolvedTheme: mockResolvedTheme, setTheme }),
}))

beforeEach(() => {
  setTheme.mockClear()
  mockTheme = "system"
  mockResolvedTheme = "dark"
})

describe("ThemeToggle", () => {
  it("라이트/다크/시스템 세 버튼을 그룹으로 렌더한다", () => {
    render(<ThemeToggle />)

    expect(screen.getByRole("group", { name: "화면 밝기" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "라이트" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "다크" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "시스템" })).toBeInTheDocument()
  })

  it("버튼을 누르면 해당 테마로 setTheme을 호출한다", async () => {
    render(<ThemeToggle />)

    await userEvent.click(screen.getByRole("button", { name: "라이트" }))
    expect(setTheme).toHaveBeenCalledWith("light")

    await userEvent.click(screen.getByRole("button", { name: "다크" }))
    expect(setTheme).toHaveBeenCalledWith("dark")

    await userEvent.click(screen.getByRole("button", { name: "시스템" }))
    expect(setTheme).toHaveBeenCalledWith("system")
  })

  it("현재 선택된 테마만 aria-pressed=true다", () => {
    mockTheme = "light"
    mockResolvedTheme = "light"
    render(<ThemeToggle />)

    expect(screen.getByRole("button", { name: "라이트" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "시스템" })).toHaveAttribute("aria-pressed", "false")
  })

  it("시스템을 고르면 실제 적용색이 다크여도 '시스템'이 선택 표시된다(resolvedTheme 아님)", () => {
    mockTheme = "system"
    mockResolvedTheme = "dark"
    render(<ThemeToggle />)

    expect(screen.getByRole("button", { name: "시스템" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "false")
  })

  it("어두운 배경용 inverted 톤에서도 같은 세 버튼을 노출한다", () => {
    render(<ThemeToggle tone="inverted" />)

    expect(screen.getAllByRole("button")).toHaveLength(3)
    expect(screen.getByRole("group", { name: "화면 밝기" })).toBeInTheDocument()
  })
})
