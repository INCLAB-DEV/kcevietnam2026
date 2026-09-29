import { describe, it, expect } from "vitest"

import { resolveHelpTopicId, type HelpTopic, type HelpTopicId } from "./content"
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
