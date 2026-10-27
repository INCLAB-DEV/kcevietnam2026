import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test-session" }) }),
}))

import { DELETE } from "./route"

describe("admin BFF DELETE", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("preserves an upstream 204 response with no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    )

    const response = await DELETE(
      new Request(
        "http://localhost/api/admin/events/event-1/interpreters/interpreter-1",
        {
          method: "DELETE",
        }
      ),
      {
        params: Promise.resolve({
          path: ["events", "event-1", "interpreters", "interpreter-1"],
        }),
      }
    )

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  it("keeps an upstream conflict response visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: "VENUE_IN_USE" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      )
    )

    const response = await DELETE(
      new Request("http://localhost/api/admin/events/event-1/venues/venue-1", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({
          path: ["events", "event-1", "venues", "venue-1"],
        }),
      }
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ detail: { code: "VENUE_IN_USE" } })
  })
})
