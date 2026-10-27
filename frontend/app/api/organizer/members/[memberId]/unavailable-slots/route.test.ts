// 미팅 불가 시간 저장 BFF — 전체 치환 본문을 행사 스코프 경로로 보내고 저장된 프로필을 돌려준다.
// master 전용 판정은 백엔드가 한다(sub는 403) — 여기서 재검사하지 않고 그대로 통과시킨다.
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ token: "session-token" as string | null }))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({ role: "organizer", permissionLevel: "master" }),
}))
import { PATCH } from "./route"

const EVENTS = { items: [{ id: "event-first" }] }

function backend(patchResponse: Response) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/api/admin/events")) return Response.json(EVENTS)
    return patchResponse
  })
}

function request(body: unknown) {
  return new Request("http://localhost/api/organizer/members/org-1/unavailable-slots", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ memberId: "org-1" }) }

describe("미팅 불가 시간 저장 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
  })

  it("전체 목록을 행사 스코프 경로로 보내고 저장된 프로필을 돌려준다", async () => {
    const saved = {
      org_event_role_id: "role-1",
      application_status: "approved",
      unavailable_meeting_slots: ["2026-10-20T10:00", "2026-10-21T14:00"],
    }
    const fetchMock = backend(Response.json(saved))
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(
      request({ slots: ["2026-10-20T10:00", "2026-10-21T14:00"] }),
      params,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, id: "org-1", profile: saved })
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/unavailable-slots"))!
    expect(String(call[0])).toMatch(
      /\/api\/admin\/events\/event-first\/organizations\/org-1\/unavailable-slots$/,
    )
    expect((call[1] as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      slots: ["2026-10-20T10:00", "2026-10-21T14:00"],
    })
  })

  it("sub(403)는 상태·사유 그대로 올려보낸다 — 성공으로 덮지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(Response.json({ detail: "운영자(master) 권한이 필요합니다" }, { status: 403 })),
    )

    const response = await PATCH(request({ slots: [] }), params)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      success: false,
      error: "운영자(master) 권한이 필요합니다",
    })
  })

  it("slots가 배열이 아니면 백엔드에 보내지 않고 422", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ slots: "2026-10-20T10:00" }), params)

    expect(response.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("세션이 없으면(목 세션) 저장된 척하지 않는다", async () => {
    state.token = null
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ slots: [] }), params)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ success: false, error: "mock_session" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 본문은 전체 치환이라 잘못된 값이 그대로 저장된다 — 슬롯 id 형식("YYYY-MM-DDTHH:MM")과 개수를 여기서 본다.
  it.each([
    ["초가 붙은 시각", ["2026-10-20T10:00:00"]],
    ["날짜만", ["2026-10-20"]],
    ["빈 문자열", [""]],
    ["임의 문자열", ["2026-10-20T10:00", "<script>"]],
    ["문자열이 아닌 값", [20261020]],
  ])("슬롯 형식이 아니면(%s) 백엔드에 보내지 않고 422", async (_label, slots) => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ slots }), params)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toBe("validation_failed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 칸 수 상한은 없다 — 격자 크기는 행사 설정이 정한다. 슬롯이 짧고 기간이 긴 행사의 정상 격자가 그대로
  // 통과해야 한다(10분 슬롯 × 09:00~18:00 × 10일 = 540칸). 전체 치환이라 한 칸만 풀어도 전체가 다시 실린다.
  it("칸 수가 많은 정상 격자도 통과한다(10분 슬롯 × 9시간 × 10일 = 540칸)", async () => {
    const slots: string[] = []
    for (let day = 1; day <= 10; day++) {
      for (let minute = 9 * 60; minute < 18 * 60; minute += 10) {
        const hh = String(Math.floor(minute / 60)).padStart(2, "0")
        const mm = String(minute % 60).padStart(2, "0")
        slots.push(`2026-10-${String(day).padStart(2, "0")}T${hh}:${mm}`)
      }
    }
    expect(slots).toHaveLength(540)
    vi.stubGlobal("fetch", backend(Response.json({ unavailable_meeting_slots: slots })))

    const response = await PATCH(request({ slots }), params)
    expect(response.status).toBe(200)
  })
})
