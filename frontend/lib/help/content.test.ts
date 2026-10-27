import { describe, it, expect } from "vitest"

import {
  applyHelpOverride,
  helpOverrideKey,
  MEETINGS_ONLY_HELP_NAMESPACE,
  MEETINGS_ONLY_HELP_TOPICS,
  resolveHelpTopicId,
  type HelpTopic,
  type HelpTopicId,
  type HelpTopicOverride,
} from "./content"
import type { UserRole } from "@/components/layout/nav"
import koMessages from "@/messages/ko.json"
import enMessages from "@/messages/en.json"

// resolver가 반환할 수 있는 모든 토픽 ID — 카탈로그 커버리지 검증의 기준 집합.
const ALL_TOPIC_IDS: HelpTopicId[] = [
  "homeBuyer",
  "homeExhibitor",
  "discoverBuyer",
  "discoverExhibitor",
  "meetingsBuyer",
  "meetingsExhibitor",
  "profileBuyer",
  "profileExhibitor",
  "applyBuyer",
  "applyExhibitor",
  "notifications",
  "welcome",
  "organizerDashboard",
  "organizerMembers",
  "organizerForcedMatching",
  "admin",
  "generalBuyer",
  "generalExhibitor",
  "generalOrganizer",
]

const koHelp = koMessages.help as Record<string, unknown>
const enHelp = enMessages.help as Record<string, unknown>

describe("resolveHelpTopicId — 라우트·역할 → 토픽 매핑", () => {
  it.each([
    ["/", "buyer", "homeBuyer"],
    ["/", "exhibitor", "homeExhibitor"],
    ["/discover", "buyer", "discoverBuyer"],
    ["/discover", "exhibitor", "discoverExhibitor"],
    ["/discover/org-1", "buyer", "discoverBuyer"],
    ["/meetings", "buyer", "meetingsBuyer"],
    ["/meetings/m-1", "exhibitor", "meetingsExhibitor"],
    ["/profile", "buyer", "profileBuyer"],
    ["/exhibitor/profile", "exhibitor", "profileExhibitor"],
    ["/apply", "buyer", "applyBuyer"],
    ["/exhibitor/apply", "exhibitor", "applyExhibitor"],
    ["/notifications", "buyer", "notifications"],
    ["/notifications", "exhibitor", "notifications"],
    ["/welcome", "buyer", "welcome"],
    ["/welcome", "exhibitor", "welcome"],
    ["/organizer", "organizer", "organizerDashboard"],
    ["/organizer/members", "organizer", "organizerMembers"],
    ["/organizer/members/org-1", "organizer", "organizerMembers"],
    ["/organizer/forced-matching", "organizer", "organizerForcedMatching"],
    ["/admin", "organizer", "admin"],
    ["/admin/events", "organizer", "admin"],
  ] as const)("(%s, %s) → %s", (pathname, role, expected) => {
    expect(resolveHelpTopicId(pathname, role as UserRole)).toBe(expected)
  })

  it("더 구체적인 운영자 경로가 넓은 /organizer보다 먼저 매칭된다", () => {
    // /organizer/members·/organizer/forced-matching 이 /organizer(대시보드)로 흡수되면 안 된다.
    expect(resolveHelpTopicId("/organizer/members", "organizer")).toBe("organizerMembers")
    expect(resolveHelpTopicId("/organizer/forced-matching", "organizer")).toBe(
      "organizerForcedMatching",
    )
    expect(resolveHelpTopicId("/organizer", "organizer")).toBe("organizerDashboard")
  })

  it("후행 슬래시는 무시한다", () => {
    expect(resolveHelpTopicId("/discover/", "buyer")).toBe("discoverBuyer")
    expect(resolveHelpTopicId("/organizer/", "organizer")).toBe("organizerDashboard")
  })

  it("매칭되는 화면이 없으면 역할별 일반 도움말로 폴백한다", () => {
    expect(resolveHelpTopicId("/some/unknown/route", "buyer")).toBe("generalBuyer")
    expect(resolveHelpTopicId("/xyz", "exhibitor")).toBe("generalExhibitor")
    expect(resolveHelpTopicId("/xyz", "organizer")).toBe("generalOrganizer")
  })

  it("항상 카탈로그에 존재하는 토픽 ID만 반환한다", () => {
    const roles: UserRole[] = ["buyer", "exhibitor", "organizer"]
    const routes = [
      "/",
      "/discover",
      "/discover/x",
      "/meetings",
      "/meetings/x",
      "/profile",
      "/exhibitor/profile",
      "/apply",
      "/exhibitor/apply",
      "/notifications",
      "/welcome",
      "/organizer",
      "/organizer/members",
      "/organizer/members/x",
      "/organizer/forced-matching",
      "/admin",
      "/admin/venues",
      "/random",
    ]
    for (const route of routes) {
      for (const role of roles) {
        const id = resolveHelpTopicId(route, role)
        expect(ALL_TOPIC_IDS).toContain(id)
        expect(koHelp[id], `ko.json help.${id} 누락`).toBeDefined()
        expect(enHelp[id], `en.json help.${id} 누락`).toBeDefined()
      }
    }
  })
})

describe("help 카탈로그 — 커버리지·형태·ko/en 패리티", () => {
  it("모든 토픽 ID가 ko/en 양쪽에 존재하고 올바른 형태다", () => {
    for (const id of ALL_TOPIC_IDS) {
      for (const [lang, catalog] of [
        ["ko", koHelp],
        ["en", enHelp],
      ] as const) {
        const topic = catalog[id] as HelpTopic | undefined
        expect(topic, `${lang}.json help.${id} 누락`).toBeDefined()
        expect(topic!.title, `${lang} ${id} title`).toBeTruthy()
        expect(topic!.intro, `${lang} ${id} intro`).toBeTruthy()
        expect(Array.isArray(topic!.steps) && topic!.steps.length > 0, `${lang} ${id} steps`).toBe(
          true,
        )
        expect(Array.isArray(topic!.tips), `${lang} ${id} tips`).toBe(true)
      }
    }
  })

  it("ko/en 의 help 키 집합이 동일하다(번역 누락 방지)", () => {
    expect(Object.keys(koHelp).sort()).toEqual(Object.keys(enHelp).sort())
  })

  it("패널 UI 라벨 키(버튼·헤딩)가 ko/en 양쪽에 있다", () => {
    for (const key of ["buttonLabel", "panelEyebrow", "stepsHeading", "tipsHeading"]) {
      expect(koHelp[key], `ko ${key}`).toBeTruthy()
      expect(enHelp[key], `en ${key}`).toBeTruthy()
    }
  })
})

// 참가자 메뉴가 "미팅만"(기본)인 행사에서는 대시보드·기업 탐색·알림·프로필이 메뉴에 없다 — 그 메뉴를
// 안내하는 항목만 대체 문구로 바꿔 끼운다(F-NV-001 D15). 토픽을 통째로 복제하지 않는다.
describe("'미팅만' 행사용 대체 문구", () => {
  const koOverrides = koHelp[MEETINGS_ONLY_HELP_NAMESPACE] as Record<string, HelpTopicOverride>
  const enOverrides = enHelp[MEETINGS_ONLY_HELP_NAMESPACE] as Record<string, HelpTopicOverride>
  const catalogs = [
    ["ko", koHelp, koOverrides],
    ["en", enHelp, enOverrides],
  ] as const

  it("대상은 숨긴 메뉴를 안내하는 네 토픽이다", () => {
    expect([...MEETINGS_ONLY_HELP_TOPICS].sort()).toEqual(
      ["generalBuyer", "generalExhibitor", "meetingsBuyer", "welcome"].sort(),
    )
  })

  it("전체 메뉴에서는 어떤 토픽도 대체하지 않는다", () => {
    for (const id of ALL_TOPIC_IDS) expect(helpOverrideKey(id, "full")).toBeNull()
  })

  it("미팅만이면 대상 토픽만 대체 키(meetingsOnly.{토픽})를 돌려준다", () => {
    for (const id of ALL_TOPIC_IDS) {
      const expected = MEETINGS_ONLY_HELP_TOPICS.includes(id) ? `meetingsOnly.${id}` : null
      expect(helpOverrideKey(id, "meetings_only")).toBe(expected)
    }
  })

  it("카탈로그의 대체 문구는 대상 토픽과 정확히 일치한다(빠진 것도, 죽은 키도 없다)", () => {
    for (const [lang, , overrides] of catalogs) {
      expect(Object.keys(overrides).sort(), lang).toEqual([...MEETINGS_ONLY_HELP_TOPICS].sort())
    }
  })

  it("대체 문구는 steps·tips 배열만 갖고, 비어 있지 않다", () => {
    for (const [lang, , overrides] of catalogs) {
      for (const id of MEETINGS_ONLY_HELP_TOPICS) {
        const override = overrides[id]
        const keys = Object.keys(override)
        expect(keys.length, `${lang} ${id}`).toBeGreaterThan(0)
        for (const key of keys) {
          expect(["steps", "tips"], `${lang} ${id}.${key}`).toContain(key)
          const items = override[key as "steps" | "tips"]
          expect(Array.isArray(items) && items.length > 0, `${lang} ${id}.${key}`).toBe(true)
        }
      }
    }
  })

  it("applyHelpOverride — 있는 배열만 대신하고 제목·소개·나머지 배열은 그대로다", () => {
    const base: HelpTopic = { title: "제목", intro: "소개", steps: ["a", "b"], tips: ["t"] }

    expect(applyHelpOverride(base, null)).toBe(base)
    expect(applyHelpOverride(base, undefined)).toBe(base)
    expect(applyHelpOverride(base, { steps: ["x"] })).toEqual({ ...base, steps: ["x"] })
    expect(applyHelpOverride(base, { tips: ["y", "z"] })).toEqual({ ...base, tips: ["y", "z"] })
    expect(applyHelpOverride(base, { steps: ["x"], tips: [] })).toEqual({ ...base, steps: ["x"], tips: [] })
    expect(base.steps).toEqual(["a", "b"]) // 원본을 고치지 않는다
  })

  // 대체한 뒤 그 토픽에 숨긴 메뉴 안내가 남아 있지 않은지 — 토픽별로 "무엇을 안내하면 안 되는가"가 다르다.
  // 단계 전체를 본다 — 첫 항목만 보면 뒤 항목에 남은 "프로필과 신청서를…" 같은 안내를 놓친다(교차 리뷰 지적).
  it("대체한 뒤에는 숨긴 메뉴를 안내하는 문구가 없다", () => {
    const topicOf = (catalog: Record<string, unknown>, overrides: Record<string, HelpTopicOverride>, id: HelpTopicId) =>
      applyHelpOverride(catalog[id] as HelpTopic, overrides[id])

    const ko = (id: HelpTopicId) => topicOf(koHelp, koOverrides, id)
    expect(ko("generalBuyer").steps.join(" ")).not.toMatch(/홈|대시보드|기업 탐색|알림|프로필/)
    expect(ko("generalExhibitor").steps.join(" ")).not.toMatch(/홈|대시보드|기업 탐색|알림|프로필/)
    expect(ko("meetingsBuyer").tips.join(" ")).not.toMatch(/기업 탐색/)
    expect(ko("welcome").steps.join(" ")).not.toMatch(/홈 화면/)
    expect(ko("welcome").steps.join(" ")).toMatch(/미팅 화면으로 입장/)

    const en = (id: HelpTopicId) => topicOf(enHelp, enOverrides, id)
    expect(en("generalBuyer").steps.join(" ")).not.toMatch(/Dashboard|Discover|Notifications|Profile/)
    expect(en("generalExhibitor").steps.join(" ")).not.toMatch(/Dashboard|Discover|Notifications|Profile/i)
    expect(en("meetingsBuyer").tips.join(" ")).not.toMatch(/Discover/)
    expect(en("welcome").steps.join(" ")).not.toMatch(/home screen/i)
    expect(en("welcome").steps.join(" ")).toMatch(/Meetings screen/)
  })

  // 배열을 통째로 대신하므로 바뀌지 않는 항목은 원문을 한 번 더 적게 된다 — 한쪽만 고쳐져 갈라지지 않게 묶는다.
  it("바뀌지 않는 항목은 원문과 글자까지 같다", () => {
    for (const [lang, catalog, overrides] of catalogs) {
      const base = (id: HelpTopicId) => catalog[id] as HelpTopic
      // generalBuyer: "미팅 화면에서 응답·관리" 단계만 남는다(메뉴 나열·탐색에서 신청은 빠진다).
      expect(overrides.generalBuyer.steps?.[1], `${lang} generalBuyer`).toBe(base("generalBuyer").steps[2])
      expect(overrides.generalBuyer.steps, `${lang} generalBuyer`).toHaveLength(2)
      // generalExhibitor: 받은 요청 응답 단계만 원문 그대로다. 첫 항목(메뉴 나열)과 마지막 항목(프로필·신청서
      // 채우기 — 프로필 메뉴가 없어 할 수 없는 안내)은 바뀐다. 마지막 항목은 미팅 도움말의 회의록 단계와 같은 문장이다.
      expect(overrides.generalExhibitor.steps?.[1], `${lang} generalExhibitor`).toBe(base("generalExhibitor").steps[1])
      expect(overrides.generalExhibitor.steps, `${lang} generalExhibitor`).toHaveLength(base("generalExhibitor").steps.length)
      expect(base("meetingsBuyer").steps, `${lang} generalExhibitor`).toContain(overrides.generalExhibitor.steps?.[2])
      // welcome: 마지막 항목("…으로 입장")만 바뀐다.
      expect(overrides.welcome.steps?.slice(0, 3), `${lang} welcome`).toEqual(base("welcome").steps.slice(0, 3))
      expect(overrides.welcome.steps, `${lang} welcome`).toHaveLength(base("welcome").steps.length)
      // 첫 항목은 두 일반 도움말이 같은 문장을 쓴다.
      expect(overrides.generalBuyer.steps?.[0], lang).toBe(overrides.generalExhibitor.steps?.[0])
    }
  })
})
