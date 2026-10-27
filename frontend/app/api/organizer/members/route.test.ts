// 단건 등록 BFF — 담당자 비밀번호 통과 + sub 관할(바이어 전용) 게이트.
//
// 실세션(SESSION_COOKIE 있음)에선 FastAPI가 최종 권위라 이 라우트는 본문만 바꿔 넘긴다. 쿠키가
// 없는 목업 모드(dev 스위처)에선 이 라우트가 유일한 게이트라, sub가 참가사를 만들지 못하게
// 여기서 막는지까지 고정한다.
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string | null,
  permissionLevel: "master" as "master" | "sub",
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({
    role: "organizer",
    permissionLevel: state.permissionLevel,
  }),
}))
import { POST } from "./route"

const EVENTS = { items: [{ id: "event-first" }] }

function backend(createResponse: Response) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/api/admin/events")) return Response.json(EVENTS)
    return createResponse
  })
}

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/organizer/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("참가기업 단건 등록 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
    state.permissionLevel = "master"
  })

  it("비밀번호를 contact_password로 바꿔 그대로 넘기고, 응답엔 되돌려주지 않는다", async () => {
    const fetchMock = backend(Response.json({ id: "org-1" }, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      request({
        name: "하노이미디어",
        role: "buyer",
        contactEmail: "contact@hanoi.example",
        password: "Nabi2026pw",
      }),
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ success: true, id: "org-1" })
    expect(text).not.toContain("Nabi2026pw") // 평문을 응답으로 되돌리지 않는다

    const createCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/organizations"))!
    // 호스트는 NABI_BACKEND_URL(기본 localhost:8000) — 여기서 고정하는 건 행사 스코프 경로다.
    expect(String(createCall[0])).toMatch(/\/api\/admin\/events\/event-first\/organizations$/)
    const sent = JSON.parse((createCall[1] as RequestInit).body as string)
    expect(sent.contact_password).toBe("Nabi2026pw")
    expect(sent.contact_email).toBe("contact@hanoi.example")
  })

  it("비밀번호가 없으면 contact_password를 아예 싣지 않는다", async () => {
    const fetchMock = backend(Response.json({ id: "org-2" }, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)

    await POST(request({ name: "무비번", role: "buyer" }))

    const createCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/organizations"))!
    expect(JSON.parse((createCall[1] as RequestInit).body as string)).not.toHaveProperty(
      "contact_password",
    )
  })

  it("백엔드 정책 거부(422 PASSWORD_POLICY)를 코드 그대로 올려보낸다", async () => {
    const fetchMock = backend(
      Response.json({ detail: { code: "PASSWORD_POLICY", message: "정책" } }, { status: 422 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(request({ name: "정책위반", role: "buyer", password: "short1" }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, error: "PASSWORD_POLICY" })
  })

  it("목업 모드에서 sub는 바이어만 만들 수 있다(참가사는 403)", async () => {
    state.token = null
    state.permissionLevel = "sub"

    const buyer = await POST(request({ name: "바이어사", role: "buyer" }))
    expect(buyer.status).toBe(200)

    const exhibitor = await POST(request({ name: "참가사", role: "exhibitor" }))
    expect(exhibitor.status).toBe(403)
    expect(await exhibitor.json()).toEqual({ success: false, error: "forbidden_sub" })
  })

  it("목업 모드에서 master는 참가사도 만들 수 있다", async () => {
    state.token = null
    state.permissionLevel = "master"

    const response = await POST(request({ name: "참가사", role: "exhibitor" }))
    expect(response.status).toBe(200)
  })
})
