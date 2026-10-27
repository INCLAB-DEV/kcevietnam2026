import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import en from "@/messages/en.json"
import ko from "@/messages/ko.json"
import { MEETING_ERROR_CODES, meetingActionErrorMessage } from "./action-error"
import type { Translator } from "./meeting-projection"

// 카탈로그를 실제로 읽는 번역기 — 키가 없으면 next-intl처럼 경로를 그대로 돌려줘, 누락이 눈에 띄게 한다.
function translatorFor(messages: { meeting: { errors: Record<string, string> } }): Translator {
  return (key) => messages.meeting.errors[key] ?? `meeting.errors.${key}`
}
const tKo = translatorFor(ko)
const tEn = translatorFor(en)
const FALLBACK = "FALLBACK"

describe("meetingActionErrorMessage", () => {
  it("ko는 백엔드 문구를 그대로 쓴다 — 날짜 같은 구체 정보가 들어 있고, 보던 문구가 바뀌지 않는다", () => {
    const result = { success: false, errorCode: "APPLICATION_WINDOW_CLOSED", message: "미팅 신청은 2026-10-02부터 가능합니다." }
    expect(meetingActionErrorMessage(result, "ko", tKo, FALLBACK)).toBe("미팅 신청은 2026-10-02부터 가능합니다.")
  })

  it("en은 백엔드의 한국어 문구를 버리고 코드로 카탈로그 문구를 고른다", () => {
    const result = { success: false, errorCode: "SLOT_TAKEN", message: "해당 시간에 이미 확정된 미팅이 있습니다." }
    const message = meetingActionErrorMessage(result, "en", tEn, FALLBACK)
    expect(message).toBe(en.meeting.errors.SLOT_TAKEN)
    expect(message).not.toMatch(/[가-힣]/)
  })

  it("en에서 모르는 코드·코드 없는 실패는 호출부의 일반 문구로 떨어진다(한국어 문구를 그대로 띄우지 않는다)", () => {
    expect(meetingActionErrorMessage({ success: false, errorCode: "BRAND_NEW_CODE", message: "새 한국어 문구" }, "en", tEn, FALLBACK)).toBe(FALLBACK)
    expect(meetingActionErrorMessage({ success: false, errorCode: "http_502" }, "en", tEn, FALLBACK)).toBe(FALLBACK)
    expect(meetingActionErrorMessage({ success: false }, "en", tEn, FALLBACK)).toBe(FALLBACK)
  })

  it("ko에서 백엔드가 문구를 싣지 않았으면 코드의 카탈로그 문구로, 그것도 없으면 일반 문구로 간다", () => {
    expect(meetingActionErrorMessage({ success: false, errorCode: "VENUE_TAKEN" }, "ko", tKo, FALLBACK)).toBe(ko.meeting.errors.VENUE_TAKEN)
    expect(meetingActionErrorMessage({ success: false, errorCode: "http_500" }, "ko", tKo, FALLBACK)).toBe(FALLBACK)
  })

  it("BFF가 낸 NO_SESSION은 ko에서도 카탈로그 문구다 — 그 message는 로그용 영문 설명이다", () => {
    const result = { success: false, errorCode: "NO_SESSION", message: "No session — sign-in required" }
    expect(meetingActionErrorMessage(result, "ko", tKo, FALLBACK)).toBe(ko.meeting.errors.NO_SESSION)
    expect(meetingActionErrorMessage(result, "en", tEn, FALLBACK)).toBe(en.meeting.errors.NO_SESSION)
  })
})

describe("미팅 에러 코드 ↔ 카탈로그", () => {
  it("아는 코드는 전부 ko/en 문구가 있다(없으면 en 화면이 일반 실패 문구로만 뜬다)", () => {
    for (const code of MEETING_ERROR_CODES) {
      expect(ko.meeting.errors, code).toHaveProperty(code)
      expect(en.meeting.errors, code).toHaveProperty(code)
    }
  })

  it("카탈로그에 코드 목록 밖의 키가 없다 — 지워진 코드의 문구가 남지 않게", () => {
    expect(Object.keys(en.meeting.errors).sort()).toEqual([...MEETING_ERROR_CODES].sort())
  })

  // 백엔드 라우터 docstring의 "코드 목록"이 정본이다. 백엔드에 코드가 늘었는데 여기 목록이 그대로면, 그 실패는
  // en 화면에서 사유 없이 일반 문구로만 뜬다 — 모노레포에서만 확인할 수 있어 파일이 없으면 건너뛴다.
  const routerPath = join(process.cwd(), "..", "backend", "app", "meetings", "router.py")
  it.skipIf(!existsSync(routerPath))("백엔드 미팅 라우터가 문서화한 코드를 전부 알고 있다", () => {
    const source = readFileSync(routerPath, "utf8")
    const docstring = source.slice(0, source.indexOf("from __future__"))
    const documented = [...docstring.matchAll(/\b([A-Z][A-Z_]{2,})\(\d{3}\)/g)].map((match) => match[1])
    expect(documented.length).toBeGreaterThan(10) // 파싱이 조용히 빈 목록을 내면 이 테스트가 무의미해진다
    for (const code of documented) expect(MEETING_ERROR_CODES as readonly string[], code).toContain(code)
  })
})
