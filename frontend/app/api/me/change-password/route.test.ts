import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

// route.ts가 next/headers의 cookies()로 세션 토큰을 읽는다 — refresh route.test.ts와 같은 스텁 패턴.
let sessionToken: string | undefined
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && sessionToken ? { value: sessionToken } : undefined,
  }),
}))

const { POST } = await import("./route")

function request(body: unknown) {
  return new Request("http://localhost/api/me/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/me/change-password (BFF)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionToken = undefined
  })

  it("세션 쿠키가 없으면 401 NO_SESSION, upstream은 부르지 않는다", async () => {
    sessionToken = undefined
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(request({ current_password: "a", new_password: "b" }))

    expect(response.status).toBe(401)
    expect((await response.json()).detail.code).toBe("NO_SESSION")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("세션 쿠키가 있으면 Bearer 헤더로 FastAPI에 POST하고 snake_case 본문을 그대로 넘긴다", async () => {
    sessionToken = "session-abc"
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    // 테스트용 평문 — 응답에 노출되면 안 되는 값.
    const response = await POST(
      request({ current_password: "OldPassw0rd", new_password: "NewPassw0rd1" }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://localhost:8000/api/me/change-password")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({ authorization: "Bearer session-abc" })
    const sentBody = JSON.parse(
      new TextDecoder().decode(init?.body as ArrayBuffer),
    )
    expect(sentBody).toEqual({ current_password: "OldPassw0rd", new_password: "NewPassw0rd1" })
  })

  it("upstream 422(PASSWORD_POLICY)를 상태·본문 그대로 통과시킨다", async () => {
    sessionToken = "session-abc"
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: { code: "PASSWORD_POLICY", message: "정책 위반" } }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(request({ current_password: "a", new_password: "short" }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: { code: "PASSWORD_POLICY", message: "정책 위반" },
    })
  })

  it("upstream 403(INVALID_CREDENTIALS)도 상태·본문 그대로 통과시킨다", async () => {
    sessionToken = "session-abc"
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { code: "INVALID_CREDENTIALS" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      request({ current_password: "wrong", new_password: "NewPassw0rd1" }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ detail: { code: "INVALID_CREDENTIALS" } })
  })
})
