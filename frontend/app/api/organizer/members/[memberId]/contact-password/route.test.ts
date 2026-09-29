// 담당자 비밀번호 설정 BFF — 평문은 본문으로만 흐르고, 백엔드 거부 코드는 그대로 올라온다.
//
// 관할(sub는 자기 바이어만)·운영자 계정 보호는 FastAPI가 판정한다 — 이 라우트는 재검사하지 않고
// 403/409를 통과시킨다. 여기서 고정하는 건 "경로·본문을 맞게 만들고, 평문을 응답에 안 싣는다"다.
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ token: "session-token" as string | null }))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({ role: "organizer", permissionLevel: "sub" }),
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
  return new Request("http://localhost/api/organizer/members/org-1/contact-password", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ memberId: "org-1" })

describe("담당자 비밀번호 설정 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
  })

  it("행사 스코프 경로로 프록시하고 담당자 이메일만 돌려준다", async () => {
    const fetchMock = backend(
      Response.json({
        organization_id: "org-1",
        member_id: "m-1",
        contact_email: "contact@hanoi.example",
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ password: "Nabi2026pw" }), { params })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      success: true,
      id: "org-1",
      contactEmail: "contact@hanoi.example",
    })
    expect(text).not.toContain("Nabi2026pw") // 평문도 해시도 응답에 없다

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/contact-password"))!
    // 호스트는 NABI_BACKEND_URL(기본 localhost:8000) — 여기서 고정하는 건 행사 스코프 경로다.
    expect(String(call[0])).toMatch(
      /\/api\/admin\/events\/event-first\/organizations\/org-1\/contact-password$/,
    )
    expect((call[1] as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ password: "Nabi2026pw" })
  })

  it("백엔드 거부 코드(409 OPERATOR_ACCOUNT)를 상태·코드 그대로 올려보낸다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(
        Response.json({ detail: { code: "OPERATOR_ACCOUNT", message: "거부" } }, { status: 409 }),
      ),
    )

    const response = await PATCH(request({ password: "Nabi2026pw" }), { params })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ success: false, error: "OPERATOR_ACCOUNT" })
  })

  it("관할 밖(403)도 그대로 통과시킨다 — 여기서 성공으로 덮지 않는다", async () => {
    vi.stubGlobal("fetch", backend(Response.json({ detail: "관할 밖" }, { status: 403 })))

    const response = await PATCH(request({ password: "Nabi2026pw" }), { params })

    expect(response.status).toBe(403)
    expect((await response.json()).success).toBe(false)
  })

  it("빈 비밀번호는 백엔드까지 가지 않고 422로 막는다", async () => {
    const fetchMock = backend(Response.json({}))
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ password: "" }), { params })

    expect(response.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("목업 모드(세션 쿠키 없음)에서는 저장할 곳이 없어 화면 흐름만 유지한다", async () => {
    state.token = null
    const fetchMock = backend(Response.json({}))
    vi.stubGlobal("fetch", fetchMock)

    const response = await PATCH(request({ password: "Nabi2026pw" }), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, id: "org-1", contactEmail: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
