import { afterEach, describe, expect, it, vi } from "vitest"
import { applySmartFill, hasRealSmartFillClient, mockSmartFillClient } from "./smartfill-client"
import type { ExhibitorProfileDraft } from "./types"

// 2026-09-10 — prod는 NEXT_PUBLIC_BM_API_BASE를 build-arg로 안 받고(Dockerfile·
// standalone-deploy.yml) 백엔드 /extract도 미구현이라 mock 데모값이 실사용자 신청서에 저장되던
// 사고. apply-form은 이 플래그로 SmartFillBanner 렌더 자체를 막는다.
describe("hasRealSmartFillClient — 실 추출 백엔드 연결 여부", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("NEXT_PUBLIC_BM_API_BASE가 없으면(prod 기본·테스트 기본) false", () => {
    expect(hasRealSmartFillClient()).toBe(false)
  })

  it("NEXT_PUBLIC_BM_API_BASE가 있으면(로컬 dev) true", () => {
    vi.stubEnv("NEXT_PUBLIC_BM_API_BASE", "http://localhost:8000")
    expect(hasRealSmartFillClient()).toBe(true)
  })
})

describe("mockSmartFillClient.extract", () => {
  it("문서를 받아 전시품목·분야·소개 초안을 돌려준다", async () => {
    const file = new File(["dummy"], "회사소개서.pdf", { type: "application/pdf" })
    const draft = await mockSmartFillClient.extract(file)
    expect((draft.products ?? []).length).toBeGreaterThan(0)
    expect(draft.products?.[0].nameKo).toBeTruthy()
    expect(draft.exhibitionCategories).toContain("content_production")
    expect(draft.introKo).toBeTruthy()
  })
})

describe("applySmartFill — 빈 칸만 채우고 출처를 표시한다", () => {
  const extracted = {
    products: [{ nameKo: "추출제품" }],
    exhibitionCategories: ["content_production" as const],
    introKo: "추출 소개",
    introEn: "extracted intro",
  }

  it("빈 드래프트는 추출값으로 채우고 sources 를 돌려준다", () => {
    const { patch, sources } = applySmartFill({}, extracted)
    expect(patch.products).toEqual([{ nameKo: "추출제품" }])
    expect(patch.introKo).toBe("추출 소개")
    expect(sources).toEqual(
      expect.arrayContaining(["products", "exhibitionCategories", "introKo", "introEn"]),
    )
  })

  it("사용자가 이미 입력한 제품/소개는 덮어쓰지 않는다", () => {
    const draft: ExhibitorProfileDraft = {
      products: [{ nameKo: "내가 쓴 제품" }],
      introKo: "내가 쓴 소개",
    }
    const { patch, sources } = applySmartFill(draft, extracted)
    expect(patch.products).toBeUndefined()
    expect(patch.introKo).toBeUndefined()
    expect(sources).not.toContain("products")
    expect(sources).not.toContain("introKo")
    // 비어 있던 영문 소개는 채워진다.
    expect(patch.introEn).toBe("extracted intro")
    expect(sources).toContain("introEn")
  })
})
