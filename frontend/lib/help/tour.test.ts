import { describe, it, expect, beforeEach } from "vitest"

import {
  resolveTourId,
  TOURS,
  hasSeenTour,
  markTourSeen,
  tourSeenStorageKey,
  type TourId,
} from "./tour"
import type { UserRole } from "@/components/layout/nav"
import koMessages from "@/messages/ko.json"
import enMessages from "@/messages/en.json"

type TourCatalog = Record<
  string,
  { steps: Array<{ title: string; description: string }> }
>
const koTour = (koMessages.help as unknown as { tour: TourCatalog }).tour
const enTour = (enMessages.help as unknown as { tour: TourCatalog }).tour

const ALL_TOUR_IDS = Object.keys(TOURS) as TourId[]

describe("resolveTourId — 라우트·역할 → 투어 ID(정적 도움말 규칙 재사용)", () => {
  it.each([
    ["/welcome", "buyer", "welcome"],
    ["/welcome", "exhibitor", "welcome"],
    ["/discover", "buyer", "discoverBuyer"],
    ["/discover", "exhibitor", "discoverExhibitor"],
    ["/discover/org-1", "buyer", "discoverBuyer"],
    ["/meetings", "buyer", "meetingsBuyer"],
    ["/meetings/m-1", "exhibitor", "meetingsExhibitor"],
    ["/profile", "buyer", "profileBuyer"],
    ["/exhibitor/profile", "exhibitor", "profileExhibitor"],
    ["/apply", "buyer", "applyBuyer"],
    ["/exhibitor/apply", "exhibitor", "applyExhibitor"],
    ["/organizer", "organizer", "organizerDashboard"],
    ["/organizer/members", "organizer", "organizerMembers"],
    ["/organizer/members/org-1", "organizer", "organizerMembers"],
    ["/organizer/forced-matching", "organizer", "organizerForcedMatching"],
  ] as const)("(%s, %s) → %s", (pathname, role, expected) => {
    expect(resolveTourId(pathname, role as UserRole)).toBe(expected)
  })

  it("투어가 없는 화면은 null 을 돌려준다(패널만 폴백)", () => {
    // 홈·알림·admin·미지정 라우트는 도움말 패널은 있으나 요소 앵커드 투어는 없다.
    expect(resolveTourId("/", "buyer")).toBeNull()
    expect(resolveTourId("/", "exhibitor")).toBeNull()
    expect(resolveTourId("/notifications", "buyer")).toBeNull()
    expect(resolveTourId("/admin", "organizer")).toBeNull()
    expect(resolveTourId("/admin/events", "organizer")).toBeNull()
    expect(resolveTourId("/some/unknown/route", "buyer")).toBeNull()
  })

  it("항상 TOURS 에 존재하는 투어 ID 또는 null 만 반환한다", () => {
    const roles: UserRole[] = ["buyer", "exhibitor", "organizer"]
    const routes = [
      "/",
      "/welcome",
      "/discover",
      "/meetings",
      "/profile",
      "/exhibitor/profile",
      "/apply",
      "/exhibitor/apply",
      "/notifications",
      "/organizer",
      "/organizer/members",
      "/organizer/forced-matching",
      "/admin",
      "/random",
    ]
    for (const route of routes) {
      for (const role of roles) {
        const id = resolveTourId(route, role)
        if (id !== null) expect(ALL_TOUR_IDS).toContain(id)
      }
    }
  })
})

describe("TOURS 레지스트리 — 셀렉터·문구 정합성", () => {
  it("모든 스텝 셀렉터가 [data-tour=...] 형태의 비어있지 않은 문자열이다", () => {
    for (const id of ALL_TOUR_IDS) {
      expect(TOURS[id].length, `${id} 스텝 없음`).toBeGreaterThan(0)
      for (const step of TOURS[id]) {
        expect(step.element).toMatch(/^\[data-tour="[a-z-]+"\]$/)
      }
    }
  })

  it("각 투어의 셀렉터 개수 = ko/en 메시지 steps 개수(index zip 계약)", () => {
    for (const id of ALL_TOUR_IDS) {
      expect(koTour[id], `ko help.tour.${id} 누락`).toBeDefined()
      expect(enTour[id], `en help.tour.${id} 누락`).toBeDefined()
      expect(koTour[id].steps.length, `ko ${id} steps 개수`).toBe(
        TOURS[id].length
      )
      expect(enTour[id].steps.length, `en ${id} steps 개수`).toBe(
        TOURS[id].length
      )
    }
  })

  it("모든 스텝 문구(title·description)가 ko/en 양쪽에 채워져 있다", () => {
    for (const id of ALL_TOUR_IDS) {
      for (const [lang, cat] of [
        ["ko", koTour],
        ["en", enTour],
      ] as const) {
        cat[id].steps.forEach((s, i) => {
          expect(s.title, `${lang} ${id}.steps.${i}.title`).toBeTruthy()
          expect(
            s.description,
            `${lang} ${id}.steps.${i}.description`
          ).toBeTruthy()
        })
      }
    }
  })

  it("투어 컨트롤(next/prev/done)·재생 라벨이 ko/en 양쪽에 있다", () => {
    for (const cat of [koTour, enTour] as unknown as Array<
      Record<string, unknown>
    >) {
      const controls = cat.controls as {
        next: string
        prev: string
        done: string
      }
      expect(controls.next).toBeTruthy()
      expect(controls.prev).toBeTruthy()
      expect(controls.done).toBeTruthy()
      expect(cat.replay).toBeTruthy()
    }
  })
})

describe("최초 1회 자동시작 플래그(localStorage)", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("처음엔 안 봤음(false), markTourSeen 이후엔 봤음(true)", () => {
    const id: TourId = "discoverBuyer"
    expect(hasSeenTour(id)).toBe(false)
    markTourSeen(id)
    expect(hasSeenTour(id)).toBe(true)
  })

  it("플래그는 투어별로 독립적이다(한 화면을 봐도 다른 화면은 그대로 자동시작 대상)", () => {
    markTourSeen("organizerDashboard")
    expect(hasSeenTour("organizerDashboard")).toBe(true)
    expect(hasSeenTour("organizerMembers")).toBe(false)
  })

  it("저장 키 형식은 nabi-tour-seen:<id>", () => {
    expect(tourSeenStorageKey("welcome")).toBe("nabi-tour-seen:welcome")
    markTourSeen("welcome")
    expect(window.localStorage.getItem("nabi-tour-seen:welcome")).toBe("1")
  })
})
