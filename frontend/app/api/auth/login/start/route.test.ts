import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ORG_COOKIE, ROLE_COOKIE, SESSION_COOKIE, STATUS_COOKIE } from "@/lib/auth/session-cookie"
import { POST } from "./route"

// 2026-10-02 부하 테스트 회귀 방지 — 첫 로그인이 몰리자 백엔드가 평문 500("Internal Server Error")을 냈고, 이 라우트가
// upstream.json()에서 SyntaxError로 같이 터졌다(Next 로그: Unexpected token 'I', "Internal S"... is not valid JSON).
// 이제 어떤 실패든 던지지 않고 {detail: {code, message}} JSON 오류 + 상태 코드로 돌려준다(lib/auth/login-bff).
// 성공 계약(본문 통과 + 세션·역할 쿠키 + /api/me 부트스트랩)은 그대로다.

const fetchMock = vi.fn()

// signal — 브라우저 연결을 흉내 낸다. 실제 런타임에선 브라우저가 응답 전에 연결을 닫으면 request.signal이 abort된다.
function startRequest(
  body: unknown = { username: "buyer@example.com", password: "Passw0rd1" },
  signal?: AbortSignal,
) {
  return new Request("http://localhost:3000/api/auth/login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  // 백엔드 실패는 서버 로그에 남긴다(console.error) — 테스트 출력만 조용히 둔다.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("/api/auth/login/start — 백엔드 실패를 JSON 오류로", () => {
  it("백엔드가 평문 500을 내도 던지지 않고 같은 상태의 JSON 오류(upstream_error)를 돌려준다", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }),
    )

    const res = await POST(startRequest())

    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect((await res.json()).detail.code).toBe("upstream_error")
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it("503 login_busy(JSON)는 상태·본문 그대로 통과시킨다", async () => {
    const busy = { detail: { code: "login_busy", message: "로그인 요청이 많아요. 잠시 후 다시 시도해 주세요." } }
    fetchMock.mockResolvedValueOnce(jsonResponse(busy, 503))

    const res = await POST(startRequest())

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(busy)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it("백엔드에 닿지 못하면(연결 거부) 502 upstream_unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))

    const res = await POST(startRequest())

    expect(res.status).toBe(502)
    expect((await res.json()).detail.code).toBe("upstream_unavailable")
  })

  it("200인데 본문이 JSON이 아니면(계약 위반) 502 upstream_error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }))

    const res = await POST(startRequest())

    expect(res.status).toBe(502)
    expect((await res.json()).detail.code).toBe("upstream_error")
  })

  it("브라우저가 보낸 본문이 JSON이 아니면 백엔드를 부르지 않고 400 invalid_body", async () => {
    const res = await POST(startRequest("{not json"))

    expect(res.status).toBe(400)
    expect((await res.json()).detail.code).toBe("invalid_body")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("백엔드 오류 응답의 원인(평문)을 화면 응답에 싣지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error: QueuePool limit of size 10 overflow 20 reached", { status: 500 }),
    )

    const res = await POST(startRequest())

    expect(await res.text()).not.toContain("QueuePool")
  })
})

// 화면이 로그인 시도를 그만두면(입력 수정·화면 이탈) 브라우저가 요청을 끊는다(lib/auth/http-auth-client). BFF도 그걸
// 받아 백엔드 호출을 끊고, 아무도 받지 않는 응답에 세션 쿠키를 싣지 않는다.
describe("/api/auth/login/start — 브라우저가 요청을 끊으면", () => {
  // 실제 fetch처럼: 응답 없이 매달려 있다가 signal이 끊기면 그 사유로 거절한다.
  function hangUntilAborted(_url: string, init: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  }

  it("백엔드 fetch에 request.signal을 넘긴다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: "rejected", reason: "invalid_credentials" }))
    const request = startRequest()

    await POST(request)

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(request.signal)
  })

  it("백엔드를 기다리는 중이면 백엔드 호출을 끊고, 쿠키·오류 로그 없이 끝낸다", async () => {
    fetchMock.mockImplementationOnce(hangUntilAborted)
    const browser = new AbortController()
    const pending = POST(startRequest(undefined, browser.signal))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const upstreamSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal
    expect(upstreamSignal.aborted).toBe(false)

    browser.abort()
    const res = await pending

    expect(upstreamSignal.aborted).toBe(true)
    expect(res.status).toBe(499)
    expect((await res.json()).detail.code).toBe("client_closed_request")
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
    // 백엔드 장애가 아니다 — "백엔드에 닿지 못함" 오류 로그를 남기지 않는다.
    expect(console.error).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("백엔드가 성공을 돌려준 뒤에 끊긴 걸 알았으면 세션 쿠키를 싣지 않고 /api/me 부트스트랩도 부르지 않는다", async () => {
    const browser = new AbortController()
    fetchMock.mockImplementationOnce(async () => {
      browser.abort() // 백엔드 응답이 오는 사이에 브라우저가 끊었다
      return jsonResponse({
        outcome: "succeeded",
        role: "buyer",
        gate: { application_status: "submitted", has_profile: true },
        route: "/home",
        roles: ["buyer"],
        access_token: "id-token-of-abandoned-attempt",
      })
    })

    const res = await POST(startRequest(undefined, browser.signal))

    expect(res.status).toBe(499)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect(res.cookies.get(ROLE_COOKIE)).toBeUndefined()
    expect(await res.text()).not.toContain("id-token-of-abandoned-attempt")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("/api/auth/login/start — 성공 계약 그대로", () => {
  it("재방문 succeeded: 본문을 그대로 넘기고 세션·역할 쿠키와 /api/me 부트스트랩 쿠키를 심는다", async () => {
    const succeeded = {
      outcome: "succeeded",
      role: "buyer",
      gate: { application_status: "submitted", has_profile: true },
      route: "/home",
      roles: ["buyer"],
      access_token: "id-token-1",
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(succeeded))
      .mockResolvedValueOnce(
        jsonResponse({ organization_id: "org-1", roles: [{ application_status: "approved" }] }),
      )

    const res = await POST(startRequest())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(succeeded)
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("id-token-1")
    expect(res.cookies.get(ROLE_COOKIE)?.value).toBe("buyer")
    expect(res.cookies.get(ORG_COOKIE)?.value).toBe("org-1")
    expect(res.cookies.get(STATUS_COOKIE)?.value).toBe("approved")
    // 1) 로그인 start, 2) 발급 토큰으로 GET /api/me — 순서·경로 그대로.
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/auth\/login\/start$/)
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/me$/)
  })

  it("consent_required·rejected 같은 비즈니스 결과는 200 본문 그대로, 쿠키 없이", async () => {
    const rejected = { outcome: "rejected", reason: "invalid_credentials" }
    fetchMock.mockResolvedValueOnce(jsonResponse(rejected))

    const res = await POST(startRequest())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rejected)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
