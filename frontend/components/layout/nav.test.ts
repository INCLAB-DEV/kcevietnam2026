import { describe, expect, it } from "vitest"
import { NAV_ITEMS, navItemsFor } from "./nav"

// 운영자 nav의 권한 필터(2026-09-17) — sub(무역관)·등급 미상에겐 master 전용 항목(배정·관리자 콘솔)을
// 내지 않는다. 참가자 nav는 등급과 무관하게 그대로다.
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
    expect(navItemsFor("buyer")).toEqual(NAV_ITEMS.buyer)
    expect(navItemsFor("exhibitor")).toEqual(NAV_ITEMS.exhibitor)
  })
})
