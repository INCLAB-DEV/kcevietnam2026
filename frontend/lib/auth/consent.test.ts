import { describe, it, expect } from "vitest"
import { requiredDocIds, canSubmitConsent } from "./consent"
import type { ConsentDocument } from "./auth-types"

const DOCS: ConsentDocument[] = [
  { id: "tos", title: "이용약관", summary: "", version: "v1", required: true, content: "" },
  { id: "privacy", title: "개인정보", summary: "", version: "v1", required: true, content: "" },
  { id: "marketing", title: "마케팅", summary: "", version: "v1", required: false, content: "" },
]

describe("requiredDocIds", () => {
  it("필수 약관 ID만 추린다", () => {
    expect(requiredDocIds(DOCS)).toEqual(["tos", "privacy"])
  })
})

describe("canSubmitConsent", () => {
  it("필수 약관에 모두 동의하면 진행 가능 (선택 미동의 무관)", () => {
    expect(canSubmitConsent(DOCS, ["tos", "privacy"])).toBe(true)
  })

  it("필수 약관이 하나라도 빠지면 진행 불가", () => {
    expect(canSubmitConsent(DOCS, ["tos"])).toBe(false)
    expect(canSubmitConsent(DOCS, [])).toBe(false)
  })

  it("선택만 동의하고 필수가 비면 진행 불가", () => {
    expect(canSubmitConsent(DOCS, ["marketing"])).toBe(false)
  })

  it("필수 충족 시 선택까지 동의해도 진행 가능", () => {
    expect(canSubmitConsent(DOCS, ["tos", "privacy", "marketing"])).toBe(true)
  })
})
