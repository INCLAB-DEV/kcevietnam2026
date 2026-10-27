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

// en 카탈로그 값에 한글이 남아 있으면 그대로 en 화면에 나간다 — 키 집합이 맞아도 값이 번역되지 않은 채로
// 통과하는 걸 막는다. 예외는 "한글 표기 자체가 내용인" 자리뿐이고 사유와 함께 여기 적는다. 늘릴 때는 그 값이
// 왜 한글이어야 하는지부터 답할 것(답이 "번역을 못 정해서"라면 예외가 아니라 미완성이다).
const HANGUL = /[ㄱ-ㆎ가-힣]/
const HANGUL_IN_EN_ALLOWED: Record<string, string> = {
  "signup.orgNameKoPlaceholder":
    "가입 화면 '기업명(국문)' 입력란의 예시 — 한글 표기 기업명을 받는 칸이라 예시도 한글이어야 한다.",
  "rosterUpload.columns.role":
    "운영자 명단 업로드 안내 — 엑셀 칸에 실제로 적어 넣는 값(참가기업/바이어)을 글자 그대로 보여준다.",
}

function valueAt(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (typeof acc !== "object" || acc === null) return undefined
    return (acc as Record<string, unknown>)[key]
  }, messages)
}

describe("en 카탈로그의 한글", () => {
  it("en.json 값에는 한글이 없다(사유가 적힌 예외만 허용)", () => {
    const offenders = collectKeyPaths(en).filter(
      (path) => HANGUL.test(String(valueAt(en, path))) && !(path in HANGUL_IN_EN_ALLOWED)
    )
    expect(offenders).toEqual([])
  })

  it("예외 목록에 죽은 항목이 없다 — 한글이 사라졌으면 예외도 지운다", () => {
    for (const path of Object.keys(HANGUL_IN_EN_ALLOWED)) {
      expect(HANGUL.test(String(valueAt(en, path))), path).toBe(true)
    }
  })
})
