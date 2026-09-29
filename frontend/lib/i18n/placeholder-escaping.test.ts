// GH #5 회귀 방지 — ICU MessageFormat에서 `'{fields}'`처럼 작은따옴표로 자리표시자를 감싸면
// "그대로 두라(리터럴)"는 뜻이 되어 실제 값으로 치환되지 않는다(2026-09-15 실측:
// discover.reasons.sharedInterest, discover.feedback.appropriate/excluded).
// 같은 실수가 재발하면 화면에 `{fields}`/`{org}` 문자 그대로가 노출되므로 두 겹으로 잠근다:
//   1) 정적 검사 — 모든 leaf 문자열에서 자리표시자를 홑따옴표로 감싼 패턴(`'{...}'`)을 금지한다.
//   2) 동적 검사 — intl-messageformat으로 실제 포맷해, 값 치환 후 문자열에 `{`가 남지 않는지 본다.
import { describe, it, expect } from "vitest"
import { IntlMessageFormat } from "intl-messageformat"
import ko from "@/messages/ko.json"
import en from "@/messages/en.json"

function collectLeaves(obj: unknown, prefix = ""): Array<[string, string]> {
  if (typeof obj === "string") return [[prefix, obj]]
  if (typeof obj !== "object" || obj === null) return []
  return Object.entries(obj).flatMap(([key, value]) => collectLeaves(value, prefix ? `${prefix}.${key}` : key))
}

// 메시지 안의 {name}류 자리표시자 이름을 뽑아, 포맷 시 더미 값을 채워 넣기 위한 인자 맵을 만든다.
function dummyArgsFor(message: string): Record<string, string> {
  const args: Record<string, string> = {}
  for (const match of message.matchAll(/\{(\w+)\}/g)) {
    args[match[1]] = "더미값"
  }
  return args
}

describe("메시지 카탈로그 — 자리표시자가 작은따옴표에 갇혀 리터럴로 새지 않는다", () => {
  for (const [locale, messages] of [
    ["ko", ko],
    ["en", en],
  ] as const) {
    const leaves = collectLeaves(messages)

    it(`${locale}: 홑따옴표로 감싼 자리표시자 패턴('{...}')이 없다`, () => {
      const offenders = leaves
        // 홑따옴표 1개로 감싼 경우만 잡는다 — `''{fields}''`(리터럴 작은따옴표 이스케이프 + 정상
        // 치환)는 의도된 패턴이라 제외해야 한다(음의 전후방 탐색으로 짝 따옴표를 걸러낸다).
        .filter(([, value]) => /(?<!')'\{[^}]+\}'(?!')/.test(value))
        .map(([path]) => path)
      expect(offenders, `홑따옴표로 자리표시자를 감싼 키: ${offenders.join(", ")}`).toEqual([])
    })

    it(`${locale}: 자리표시자가 있는 메시지는 값 치환 후 리터럴 {…}가 남지 않는다`, () => {
      const offenders: string[] = []
      for (const [path, value] of leaves) {
        if (!/\{\w+\}/.test(value)) continue
        // ICU 리터럴 이스케이프('...' 로 감싼 구간)는 대상에서 걷어내고 자리표시자만 남긴 문자열로
        // 판정한다 — 순수 리터럴 텍스트에 우연히 중괄호가 없다는 전제(현재 카탈로그에 해당 없음).
        const formatted = new IntlMessageFormat(value, locale).format(dummyArgsFor(value))
        if (typeof formatted === "string" && /\{\w+\}/.test(formatted)) {
          offenders.push(`${path} → "${formatted}"`)
        }
      }
      expect(offenders, `치환 후에도 {placeholder}가 남은 키: ${offenders.join(", ")}`).toEqual([])
    })
  }
})
