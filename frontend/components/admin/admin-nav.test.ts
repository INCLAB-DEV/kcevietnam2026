import { describe, expect, test } from "vitest"
import { ADMIN_NAV_ITEMS, adminNavItemsFor, isActiveAdminNav } from "./admin-nav"

describe("admin navigation", () => {
  test("places meeting assignment directly below meeting management", () => {
    const labels = ADMIN_NAV_ITEMS.map((item) => item.label)
    const meetingsIndex = labels.indexOf("미팅 관리")
    expect(labels[meetingsIndex + 1]).toBe("미팅 배정")
  })

  test("sub(canWrite=false)에겐 거버넌스 화면(미팅 배정·운영자 관리)을 빼고, master엔 전부 둔다", () => {
    expect(adminNavItemsFor(true)).toEqual(ADMIN_NAV_ITEMS)
    const subHrefs = adminNavItemsFor(false).map((item) => item.href)
    expect(subHrefs).not.toContain("/admin/forced-matching")
    expect(subHrefs).not.toContain("/admin/organizers")
    expect(subHrefs).toContain("/admin/organizations")
    expect(subHrefs).toHaveLength(ADMIN_NAV_ITEMS.length - 2)
  })

  test("marks forced matching active without activating the dashboard", () => {
    expect(isActiveAdminNav("/admin/forced-matching", "/admin/forced-matching")).toBe(true)
    expect(isActiveAdminNav("/admin/forced-matching", "/admin")).toBe(false)
  })
})
