import { describe, it, expect } from "vitest"
import { resolveMeetingEmptyState } from "./empty-state"
import { koTranslator } from "@/lib/i18n/ko-translator"
import { DEFAULT_PARTICIPANT_MENU } from "@/lib/event/participant-menu"
import enMessages from "@/messages/en.json"

// 번역기는 필수 인자다 — 한국어 문구 단정은 messages/ko.json에 물린 번역기로 한다.
const koT = koTranslator("meeting.emptyState")

// 전체 메뉴("full")로 설정한 행사 — 기업 탐색이 메뉴에 있으므로 그리로 보낸다(이 설정이 생기기 전의 동작).
describe("resolveMeetingEmptyState (F-MY-001 D13) — 전체 메뉴", () => {
  it("참가사 → AI 추천 바이어 확인(DV-001)", () => {
    const s = resolveMeetingEmptyState("exhibitor", koT, "full")
    expect(s.primary?.href).toBe("/discover")
    expect(s.primary?.label).toContain("AI 추천")
    expect(s.secondary).toBeUndefined()
  })

  it("바이어 → 관심 기업 탐색(DV-001)", () => {
    const s = resolveMeetingEmptyState("buyer", koT, "full")
    expect(s.primary?.href).toBe("/discover")
    expect(s.secondary).toBeUndefined()
  })

  it("문구는 예전 그대로다", () => {
    expect(resolveMeetingEmptyState("exhibitor", koT, "full")).toEqual({
      title: "아직 잡힌 미팅이 없어요",
      description: "AI가 추천한 바이어를 확인하고 먼저 미팅을 제안해보세요.",
      primary: { label: "AI 추천 바이어 확인", href: "/discover" },
    })
    expect(resolveMeetingEmptyState("buyer", koT, "full")).toEqual({
      title: "아직 잡힌 미팅이 없어요",
      description: "관심 있는 참가 기업을 탐색하고 미팅을 신청해보세요.",
      primary: { label: "관심 기업 탐색", href: "/discover" },
    })
  })
})

// "미팅만"(기본, F-NV-001 D15) — 기업 탐색이 메뉴에 없다. 탐색으로 보내는 버튼을 내지 않고 중립 안내만 낸다.
describe("resolveMeetingEmptyState — 미팅만", () => {
  it.each(["exhibitor", "buyer"] as const)("%s: 버튼이 없고 탐색을 권하지 않는다", (role) => {
    const s = resolveMeetingEmptyState(role, koT, "meetings_only")

    expect(s).toEqual({
      title: "아직 잡힌 미팅이 없어요",
      description: "미팅이 잡히면 여기에 표시돼요.",
    })
    expect(s.primary).toBeUndefined()
    expect(s.secondary).toBeUndefined()
    expect(`${s.title} ${s.description}`).not.toMatch(/탐색|추천|신청/)
  })

  it("값을 생략하면 기본값(미팅만)이다", () => {
    expect(DEFAULT_PARTICIPANT_MENU).toBe("meetings_only")
    for (const role of ["exhibitor", "buyer"] as const) {
      expect(resolveMeetingEmptyState(role, koT)).toEqual(resolveMeetingEmptyState(role, koT, "meetings_only"))
    }
  })

  it("en 문구도 탐색을 권하지 않는다", () => {
    const en = enMessages.meeting.emptyState
    expect(en.meetingsOnlyDescription).toBe("Your meetings will appear here once they are scheduled.")
    expect(`${en.title} ${en.meetingsOnlyDescription}`).not.toMatch(/discover|browse|request|recommend/i)
  })
})
