import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BrandMark } from "./brand-mark"

describe("BrandMark", () => {
  it("기본은 로고 + 'Sales AI' 워드마크 — 로고는 장식(접근성 이름은 워드마크)", () => {
    const { container } = render(<BrandMark />)
    expect(screen.getByText("Sales AI")).toBeInTheDocument()
    const img = container.querySelector("img")
    expect(img).toHaveAttribute("alt", "")
    expect(img).toHaveAttribute("aria-hidden", "true")
  })

  it("showWordmark=false면 글자 없이 로고만 — 로고가 접근성 이름을 맡는다(로그인 후 사이드바, 2026-10-01 요청)", () => {
    const { container } = render(<BrandMark showWordmark={false} />)
    expect(screen.queryByText("Sales AI")).not.toBeInTheDocument()
    const img = container.querySelector("img")
    expect(img).toHaveAttribute("alt", "Sales AI")
    expect(img).not.toHaveAttribute("aria-hidden")
  })
})
