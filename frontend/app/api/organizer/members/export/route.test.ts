import { afterEach, describe, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({
  token: "session-token",
  event: "server-event",
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/organizer/backend-proxy", () => ({
  BACKEND_URL: "http://backend.test",
  resolveEventId: async () => ({ ok: true, value: state.event }),
}))
import { POST } from "./route"

describe("필터 엑셀 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
  })
  it("필터 본문을 보존하고 행사와 인증은 서버에서 결정한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([80, 75]), {
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        })
      )
    vi.stubGlobal("fetch", fetchMock)
    const body = {
      tab: "exhibitor",
      content_categories: ["broadcasting"],
      statuses: ["registered"],
      ordered_ids: ["one"],
    }
    const response = await POST(
      new Request(
        "http://localhost/api/organizer/members/export?event_id=attacker-event",
        { method: "POST", body: JSON.stringify(body) }
      )
    )
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/admin/export/organizations.xlsx?event_id=server-event",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          authorization: "Bearer session-token",
        }),
      })
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([80, 75])
    )
  })
  it("세션이 없으면 서버를 호출하지 않는다", async () => {
    state.token = ""
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(
      (
        await POST(
          new Request("http://localhost", { method: "POST", body: "{}" })
        )
      ).status
    ).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("실 서버 오류를 빈 엑셀 성공으로 바꾸지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    expect(
      (
        await POST(
          new Request("http://localhost", {
            method: "POST",
            body: '{"tab":"exhibitor"}',
          })
        )
      ).status
    ).toBe(502)
  })
})
