import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test-session" }) }),
}))
import { httpAdminReadClient } from "./http-client"

describe("admin organization list paging", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("loads every page before applying the admin category filters", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: `org-${i}`,
      name_ko: `합성 ${i}`,
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
    }))
    const last = [
      {
        id: "org-100",
        name_ko: "마지막 합성",
        is_exhibitor: true,
        is_buyer: false,
        application_status: "approved",
        content_category: "broadcasting",
      },
    ]
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/unavailable-slots")) return Response.json({})
      return Response.json({
        items: url.includes("offset=100") ? last : first,
        total: 101,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const rows = await httpAdminReadClient.getOrganizations("event-1")
    expect(rows).toHaveLength(101)
    expect(rows.at(-1)?.content_category).toBe("broadcasting")
    expect(
      fetchMock.mock.calls.some(([url]) => url.includes("offset=100"))
    ).toBe(true)
  })
})
