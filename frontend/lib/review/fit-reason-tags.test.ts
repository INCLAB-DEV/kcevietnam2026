import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import en from "@/messages/en.json"
import ko from "@/messages/ko.json"
import { FIT_REASON_TAG_KEYS, fitReasonTagKey } from "./fit-reason-tags"

describe("fitReasonTagKey", () => {
  it("시드 태그(백엔드가 내려주는 한국어 값)를 메시지 키로 옮긴다", () => {
    expect(fitReasonTagKey("예산")).toBe("budget")
    expect(fitReasonTagKey("제품 적합성")).toBe("productFit")
    expect(fitReasonTagKey("인증·규격")).toBe("certification")
  })

  it("시드 밖의 태그는 null — 화면이 원문을 그대로 그린다(번역을 지어내지 않는다)", () => {
    expect(fitReasonTagKey("AI가 새로 지은 태그")).toBeNull()
    expect(fitReasonTagKey("")).toBeNull()
    // 공백 하나 차이도 다른 값이다 — 느슨하게 맞추면 엉뚱한 라벨이 붙는다.
    expect(fitReasonTagKey("제품적합성")).toBeNull()
  })
})

describe("Fit 사유 태그 ↔ 카탈로그", () => {
  it("표가 가리키는 키는 전부 ko/en 문구가 있다", () => {
    for (const key of FIT_REASON_TAG_KEYS) {
      expect(ko.review.fitTags, key).toHaveProperty(key)
      expect(en.review.fitTags, key).toHaveProperty(key)
    }
  })

  it("ko 문구는 저장된 태그 원문과 같다 — 한국어 화면의 배지가 번역 도입 전과 달라지지 않는다", () => {
    const fitTags: Record<string, string> = ko.review.fitTags
    for (const tag of Object.values(fitTags)) expect(fitReasonTagKey(tag), tag).not.toBeNull()
    for (const [key, label] of Object.entries(fitTags)) expect(fitReasonTagKey(label)).toBe(key)
  })

  it("en 문구에는 한글이 없다", () => {
    for (const label of Object.values(en.review.fitTags)) expect(label).not.toMatch(/[가-힣]/)
  })

  // 정본은 백엔드 시드 목록이다. 거기 태그가 늘었는데 이 표가 그대로면, 새 태그는 en 화면에 한국어 배지로 남는다.
  // 모노레포에서만 확인할 수 있어 파일이 없으면 건너뛴다.
  const structuringPath = join(process.cwd(), "..", "backend", "app", "services", "structuring.py")
  it.skipIf(!existsSync(structuringPath))("백엔드 시드 태그를 전부 다룬다", () => {
    const source = readFileSync(structuringPath, "utf8")
    const block = source.match(/FIT_REASON_SEED_CATEGORIES\s*=\s*\[([\s\S]*?)\]/)
    expect(block, "FIT_REASON_SEED_CATEGORIES 선언을 찾지 못했다").not.toBeNull()
    const seeds = [...block![1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(seeds.length).toBeGreaterThan(0)
    for (const seed of seeds) expect(fitReasonTagKey(seed), seed).not.toBeNull()
  })
})
