import { describe, it, expect } from "vitest"
import { resolveLocale, isSupportedLocale, DEFAULT_LOCALE } from "./config"

describe("resolveLocale", () => {
  it("쿠키 값이 없으면(undefined/null) 기본 locale(ko)로 폴백한다", () => {
    expect(resolveLocale(undefined)).toBe("ko")
    expect(resolveLocale(null)).toBe("ko")
    expect(DEFAULT_LOCALE).toBe("ko")
  })

  it("지원하지 않는 값이면 ko로 폴백한다", () => {
    expect(resolveLocale("fr")).toBe("ko")
    expect(resolveLocale("")).toBe("ko")
    expect(resolveLocale("KO")).toBe("ko") // 대소문자까지 지원값으로 보지 않는다
  })

  it("지원하는 locale(ko/en)은 그대로 반환한다", () => {
    expect(resolveLocale("ko")).toBe("ko")
    expect(resolveLocale("en")).toBe("en")
  })
})

describe("isSupportedLocale", () => {
  it("ko/en만 참으로 판정한다", () => {
    expect(isSupportedLocale("ko")).toBe(true)
    expect(isSupportedLocale("en")).toBe(true)
  })

  it("그 외 값·빈 값은 거짓", () => {
    expect(isSupportedLocale("fr")).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
    expect(isSupportedLocale(null)).toBe(false)
    expect(isSupportedLocale("")).toBe(false)
  })
})
