import { describe, it, expect } from "vitest"
import { computeRecommendations, type Translator } from "./recommendations"
import type { Organization } from "@/lib/types"
import enMessages from "@/messages/en.json"

const viewer: Organization = {
  id: "buyer-1",
  name: "방위사업청",
  role: "buyer",
  keywords: ["레이더", "전자전", "감시정찰"],
  budgetRange: "50억~100억",
  adoptionTimeline: "1년 내",
}

const highMatch: Organization = {
  id: "org-a",
  name: "한화시스템",
  role: "exhibitor",
  keywords: ["레이더", "전자전", "C4I"],
  booth: { hallNo: "1", hallName: "제1전시관", code: "A-12" },
  strength: "방산 전자전 솔루션 1위",
}

const lowMatch: Organization = {
  id: "org-b",
  name: "LIG넥스원",
  role: "exhibitor",
  keywords: ["유도무기", "수중음향"],
  booth: { hallNo: "2", hallName: "제2전시관", code: "B-03" },
  strength: "정밀 유도무기 전문",
}

const noMatch: Organization = {
  id: "org-c",
  name: "현대로템",
  role: "exhibitor",
  keywords: ["전차", "장갑차", "군수지원"],
  booth: { hallNo: "3", hallName: "제3전시관", code: "C-07" },
  strength: "지상 기동 장비 전문",
}

describe("computeRecommendations", () => {
  it("키워드 겹침이 많은 기업이 높은 점수를 받는다", () => {
    const results = computeRecommendations(viewer, [highMatch, lowMatch])
    expect(results[0].org.id).toBe("org-a")
    expect(results[0].aiScore).toBeGreaterThan(results[1].aiScore)
  })

  it("점수 높은 순으로 정렬된다", () => {
    const results = computeRecommendations(viewer, [lowMatch, highMatch, noMatch])
    const scores = results.map((r) => r.aiScore)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("aiScore는 0~100 범위다", () => {
    const results = computeRecommendations(viewer, [highMatch, lowMatch, noMatch])
    for (const r of results) {
      expect(r.aiScore).toBeGreaterThanOrEqual(0)
      expect(r.aiScore).toBeLessThanOrEqual(100)
    }
  })

  it("겹친 키워드를 언급한 추천 이유를 생성한다", () => {
    const results = computeRecommendations(viewer, [highMatch])
    const reasons = results[0].aiReasons.join(" ")
    expect(reasons).toMatch(/레이더|전자전/)
  })

  it("키워드가 전혀 겹치지 않아도 결과 목록에 포함된다", () => {
    const results = computeRecommendations(viewer, [noMatch])
    expect(results).toHaveLength(1)
    expect(results[0].aiScore).toBeGreaterThanOrEqual(0)
  })

  // 2026-09-13 EN 전환 시 한국어 잔존 정리(M-04/L-01) — t 미주입이면 한국어 폴백이지만,
  // messages/en.json의 discover.reasons를 그대로 주입하면 문장 템플릿(조사 "와(과)" 포함)이
  // 한국어로 새지 않는다. 키워드 자체(레이더 등)는 데이터라 번역 대상이 아니므로 그대로 둔다
  // (docs/backlog/i18n-full-bilingual.md 별도 범위).
  it("discover.reasons(en) t를 주입하면 문장 템플릿에 한국어 조사가 남지 않는다", () => {
    const enReasons = enMessages.discover.reasons
    const enT: Translator = (key, values) => {
      const template = (enReasons as Record<string, string>)[key.replace(/^reasons\./, "")]
      if (!template) return key
      return template.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ""))
    }
    const results = computeRecommendations(viewer, [highMatch], enT)
    const reasons = results[0].aiReasons.join(" ")
    expect(reasons).not.toContain("와(과)")
    expect(reasons).not.toContain("귀사의 관심 분야")
    expect(reasons).toMatch(/레이더|전자전/) // 키워드 자체는 데이터라 그대로 노출(번역 대상 아님)
  })
})
