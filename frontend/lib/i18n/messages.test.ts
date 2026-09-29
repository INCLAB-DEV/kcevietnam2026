// 메시지 키 무결성 — ko/en 카탈로그가 같은 키 집합을 가지는지 검증한다. 키가 어긋나면 next-intl이
// 특정 locale에서 조용히 원본 키를 그대로 렌더하거나(MISSING_MESSAGE) 런타임 경고를 낸다.
import { describe, it, expect } from "vitest"
import ko from "@/messages/ko.json"
import en from "@/messages/en.json"

function collectKeyPaths(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix]
  return Object.entries(obj).flatMap(([key, value]) =>
    collectKeyPaths(value, prefix ? `${prefix}.${key}` : key)
  )
}

describe("메시지 카탈로그 키 무결성", () => {
  it("ko.json과 en.json의 키 집합이 동일하다", () => {
    const koKeys = collectKeyPaths(ko).sort()
    const enKeys = collectKeyPaths(en).sort()
    expect(enKeys).toEqual(koKeys)
  })

  it("모든 leaf 값은 빈 문자열이 아닌 문자열이다", () => {
    for (const [locale, messages] of [
      ["ko", ko],
      ["en", en],
    ] as const) {
      for (const path of collectKeyPaths(messages)) {
        const value = path.split(".").reduce<unknown>((acc, key) => {
          if (typeof acc !== "object" || acc === null) return undefined
          return (acc as Record<string, unknown>)[key]
        }, messages)
        expect(typeof value, `${locale}.${path}`).toBe("string")
        expect((value as string).length, `${locale}.${path}`).toBeGreaterThan(0)
      }
    }
  })
})
