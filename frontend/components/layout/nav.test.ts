import { describe, expect, it } from "vitest"
import { NAV_ITEMS, navItemsFor } from "./nav"
import { DEFAULT_PARTICIPANT_MENU } from "@/lib/event/participant-menu"

// 운영자 nav의 권한 필터(2026-09-17) — sub(무역관)·등급 미상에겐 master 전용 항목(배정·관리자 콘솔)을
// 내지 않는다. 참가자 nav는 등급과 무관하고, 행사의 참가자 메뉴(F-NV-001 D15)로 갈린다.
describe("navItemsFor", () => {
  it("master는 운영자 항목 전부", () => {
    expect(navItemsFor("organizer", "master")).toEqual(NAV_ITEMS.organizer)
  })

  it("sub는 매칭 현황·참가기업 관리만", () => {
    expect(navItemsFor("organizer", "sub").map((item) => item.href)).toEqual([
      "/organizer",
      "/organizer/members",
    ])
  })

  it("등급 미상은 sub와 같다(최소 권한)", () => {
    expect(navItemsFor("organizer")).toEqual(navItemsFor("organizer", "sub"))
  })

  it("참가자 nav는 등급과 무관하다", () => {
    expect(navItemsFor("buyer", "master", "full")).toEqual(navItemsFor("buyer", undefined, "full"))
    expect(navItemsFor("exhibitor", "sub", "meetings_only")).toEqual(
      navItemsFor("exhibitor", undefined, "meetings_only"),
    )
  })
})

// 참가자 메뉴(F-NV-001 D15) — 행사 설정으로 참가사·바이어 nav를 미팅 한 항목으로 줄인다.
describe("navItemsFor — 참가자 메뉴", () => {
  it.each(["buyer", "exhibitor"] as const)("%s: 전체 메뉴(full)를 명시하면 5개 전부", (role) => {
    expect(navItemsFor(role, undefined, "full")).toEqual(NAV_ITEMS[role])
    expect(navItemsFor(role, undefined, "full")).toHaveLength(5)
  })

  it.each(["buyer", "exhibitor"] as const)("%s: 미팅만(meetings_only)이면 미팅 한 항목", (role) => {
    const items = navItemsFor(role, undefined, "meetings_only")
    expect(items.map((item) => [item.labelKey, item.href])).toEqual([["meetings", "/meetings"]])
  })

  it.each(["buyer", "exhibitor"] as const)("%s: 값을 생략하면 기본값 — 미팅 한 항목", (role) => {
    expect(DEFAULT_PARTICIPANT_MENU).toBe("meetings_only")
    expect(navItemsFor(role)).toEqual(navItemsFor(role, undefined, DEFAULT_PARTICIPANT_MENU))
    expect(navItemsFor(role).map((item) => item.href)).toEqual(["/meetings"])
  })

  it("미팅 항목은 전체 메뉴의 그것과 같은 정의다(라벨·주소·아이콘을 따로 두지 않는다)", () => {
    for (const role of ["buyer", "exhibitor"] as const) {
      const [only] = navItemsFor(role, undefined, "meetings_only")
      expect(NAV_ITEMS[role]).toContain(only)
    }
  })

  it("운영자 nav는 참가자 메뉴와 무관하다", () => {
    for (const menu of ["full", "meetings_only"] as const) {
      expect(navItemsFor("organizer", "master", menu)).toEqual(NAV_ITEMS.organizer)
      expect(navItemsFor("organizer", "sub", menu)).toEqual(navItemsFor("organizer", "sub"))
    }
  })
})
