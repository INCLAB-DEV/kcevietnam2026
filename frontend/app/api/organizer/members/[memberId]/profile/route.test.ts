// 행사 운영 콘솔의 신청서 읽기(GET)·쓰기(PATCH) BFF — 관리자 콘솔과 같은 백엔드 엔드포인트를 행사
// 스코프 경로로 부르고, 응답을 손대지 않고 올려보낸다.
//
// 여기서 고정하는 것:
//   · GET — 운영자 상세를 그대로 내려준다(편집 패널이 코드값을 그대로 받아야 한다). 참가사면 미팅 불가
//     시간 격자의 축도 함께. 관할 밖(403)·없음(404)은 성공으로 덮지 않는다.
//   · PATCH — 본문 patch를 그대로 통과시키고, 백엔드가 돌려준 **저장된 프로필**을 응답에 싣는다
//     (패널이 보낸 값이 아니라 서버 값으로 다시 그린다). 세션이 없는 목 분기는 프로필 없이 답한다.
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string | null,
  authenticated: true,
  role: "organizer",
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: state.authenticated }),
  resolveRequestSession: async () => ({ role: state.role, permissionLevel: "sub" }),
}))
import { GET, PATCH } from "./route"

const EVENTS = { items: [{ id: "event-first" }] }
const EVENT = {
  id: "event-first",
  name: "K-콘텐츠 엑스포",
  exhibition_start: "2026-10-20",
  exhibition_end: "2026-10-21",
}
const SETTINGS = {
  event_id: "event-first",
  slot_minutes: 60,
  slot_gap_minutes: 0,
  operating_start: "10:00:00",
  operating_end: "13:00:00",
  lunch_start: null,
  lunch_end: null,
}
const EXHIBITOR_DETAIL = {
  id: "org-1",
  org_event_role_id: "role-1",
  event_id: "event-first",
  is_exhibitor: true,
  is_buyer: false,
  application_status: "approved",
  exhibitor_profile: {
    org_event_role_id: "role-1",
    application_status: "approved",
    preferred_buyer_countries: ["vietnam"],
    preferred_buyer_types: ["media"],
    unavailable_meeting_slots: ["2026-10-20T10:00"],
  },
  buyer_profile: null,
}
const BUYER_DETAIL = {
  id: "org-2",
  org_event_role_id: "role-2",
  event_id: "event-first",
  is_exhibitor: false,
  is_buyer: true,
  application_status: "submitted",
  exhibitor_profile: null,
  buyer_profile: { org_event_role_id: "role-2", application_status: "submitted", org_types: ["media", "other"] },
}

type Handler = (url: string, init?: RequestInit) => Response | undefined

function backend(handler: Handler) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const path = String(url)
    if (path.endsWith("/api/admin/events")) return Response.json(EVENTS)
    return handler(path, init) ?? new Response("unexpected", { status: 500 })
  })
}

const params = (memberId = "org-1") => ({ params: Promise.resolve({ memberId }) })
const getRequest = () => new Request("http://localhost/api/organizer/members/org-1/profile")
const patchRequest = (body: unknown) =>
  new Request("http://localhost/api/organizer/members/org-1/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

afterEach(() => {
  vi.unstubAllGlobals()
  state.token = "session-token"
  state.authenticated = true
  state.role = "organizer"
})

describe("행사 운영 콘솔 신청서 BFF — GET(단건 조회)", () => {
  it("운영자 상세를 그대로 내려주고, 참가사면 미팅 불가 시간 격자의 축을 함께 만든다", async () => {
    const fetchMock = backend((url) => {
      if (url.endsWith("/api/admin/events/event-first/organizations/org-1")) {
        return Response.json(EXHIBITOR_DETAIL)
      }
      if (url.endsWith("/api/admin/events/event-first/settings")) return Response.json(SETTINGS)
      if (url.endsWith("/api/admin/events/event-first")) return Response.json(EVENT)
      return undefined
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(getRequest(), params())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    // 코드값 그대로 — 라벨 문자열로 바꾸지 않는다.
    expect(body.detail).toEqual(EXHIBITOR_DETAIL)
    expect(body.slotGrid).toEqual({
      dateIds: ["2026-10-20", "2026-10-21"],
      times: ["10:00", "11:00", "12:00"],
    })
    // 세션 토큰은 서버에서 Bearer로 붙는다.
    const detailCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/organizations/org-1"))!
    expect((detailCall[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer session-token",
    })
  })

  it("바이어는 격자를 만들지 않는다(행사·설정을 더 읽지 않는다)", async () => {
    const fetchMock = backend((url) =>
      url.endsWith("/organizations/org-2") ? Response.json(BUYER_DETAIL) : undefined,
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(getRequest(), params("org-2"))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.detail).toEqual(BUYER_DETAIL)
    expect(body.slotGrid).toBeNull()
    // 행사 목록(행사 해석) + 상세 = 2회뿐.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("행사 설정을 못 읽어도 신청서 조회는 막지 않는다 — 격자만 null", async () => {
    vi.stubGlobal(
      "fetch",
      backend((url) => {
        if (url.endsWith("/organizations/org-1")) return Response.json(EXHIBITOR_DETAIL)
        if (url.endsWith("/settings")) return Response.json({ detail: "boom" }, { status: 500 })
        if (url.endsWith("/api/admin/events/event-first")) return Response.json(EVENT)
        return undefined
      }),
    )

    const response = await GET(getRequest(), params())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.detail).toEqual(EXHIBITOR_DETAIL)
    expect(body.slotGrid).toBeNull()
  })

  it("관할 밖 바이어(403)는 상태·사유 그대로 올려보낸다 — 성공으로 덮지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() => Response.json({ detail: "이 바이어는 관할 밖입니다" }, { status: 403 })),
    )

    const response = await GET(getRequest(), params())

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ success: false, error: "이 바이어는 관할 밖입니다" })
  })

  it("없는 기업(404)도 그대로 올려보낸다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() => Response.json({ detail: "기업을 찾을 수 없습니다" }, { status: 404 })),
    )
    const response = await GET(getRequest(), params())
    expect(response.status).toBe(404)
    expect((await response.json()).success).toBe(false)
  })

  it("세션이 없으면(목 세션) 지어낸 신청서를 내려주지 않는다", async () => {
    state.token = null
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(getRequest(), params())

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ success: false, error: "mock_session" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("세션도 목 로그인도 없으면 401, 운영자가 아니면 403", async () => {
    state.token = null
    state.authenticated = false
    expect((await GET(getRequest(), params())).status).toBe(401)

    state.authenticated = true
    state.role = "buyer"
    expect((await GET(getRequest(), params())).status).toBe(403)
  })
})

describe("행사 운영 콘솔 신청서 BFF — PATCH(저장)", () => {
  it("직접 수정은 본문 patch를 그대로 PATCH .../profile로 보내고 저장된 프로필을 돌려준다", async () => {
    const saved = { org_event_role_id: "role-1", application_status: "approved", intro_ko: "저장됨" }
    const fetchMock = backend((url) =>
      url.includes("/organizations/org-1/profile") ? Response.json(saved) : undefined,
    )
    vi.stubGlobal("fetch", fetchMock)
    const patch = {
      preferred_buyer_countries: ["vietnam", "thailand"],
      preferred_buyer_types: ["media"],
    }

    const response = await PATCH(patchRequest({ role: "exhibitor", mode: "edit", patch }), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, id: "org-1", profile: saved })
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/profile"))!
    expect(String(call[0])).toMatch(
      /\/api\/admin\/events\/event-first\/organizations\/org-1\/profile\?role=exhibitor$/,
    )
    expect((call[1] as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(patch)
  })

  it("대리작성은 POST .../proxy-profile로 보낸다", async () => {
    const fetchMock = backend((url) =>
      url.includes("/proxy-profile") ? Response.json({ application_status: "approved" }) : undefined,
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(
      patchRequest({ role: "buyer", mode: "proxy", patch: { website: "https://x.example" } }),
      params(),
    )

    expect(response.status).toBe(200)
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/proxy-profile"))!
    expect(String(call[0])).toMatch(/\/organizations\/org-1\/proxy-profile\?role=buyer$/)
    expect((call[1] as RequestInit).method).toBe("POST")
  })

  it("백엔드 거부(403 부스는 슈퍼관리자만)를 그대로 올려보낸다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() =>
        Response.json({ detail: "부스 지정은 슈퍼관리자만 할 수 있습니다" }, { status: 403 }),
      ),
    )

    const response = await PATCH(
      patchRequest({ role: "exhibitor", mode: "edit", patch: { booth_location: "01" } }),
      params(),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      success: false,
      error: "부스 지정은 슈퍼관리자만 할 수 있습니다",
    })
  })

  it("세션이 없는 목 분기는 저장된 프로필 없이 답한다(패널은 이를 저장 확인 실패로 다룬다)", async () => {
    state.token = null
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(
      patchRequest({ role: "exhibitor", mode: "edit", patch: {} }),
      params(),
    )

    expect(await response.json()).toEqual({ success: true, id: "org-1" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
