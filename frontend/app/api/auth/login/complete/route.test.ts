import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ROLE_COOKIE, SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { POST } from "./route"

// complete도 start와 같은 공용 처리(lib/auth/login-bff)를 탄다 — 백엔드 실패는 던지지 않고 JSON 오류로, 성공은
// 본문 통과 + 쿠키. 전체 실패 행렬은 start/route.test.ts가 잠그고, 여기는 이 라우트가 같은 처리를 쓰는지 본다.

const fetchMock = vi.fn()

function completeRequest() {
  return new Request("http://localhost:3000/api/auth/login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login_ticket: "ticket-1", accepted_doc_ids: ["tos", "privacy", "sensitive"] }),
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("/api/auth/login/complete", () => {
  it("백엔드 평문 500 → 던지지 않고 500 JSON 오류(upstream_error)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))

    const res = await POST(completeRequest())

    expect(res.status).toBe(500)
    expect((await res.json()).detail.code).toBe("upstream_error")
  })

  it("503 JSON 오류는 상태·본문 그대로", async () => {
    const busy = { detail: { code: "login_busy", message: "로그인 요청이 많아요. 잠시 후 다시 시도해 주세요." } }
    fetchMock.mockResolvedValueOnce(jsonResponse(busy, 503))

    const res = await POST(completeRequest())

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(busy)
  })

  it("백엔드에 닿지 못하면 502 upstream_unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))

    const res = await POST(completeRequest())

    expect(res.status).toBe(502)
    expect((await res.json()).detail.code).toBe("upstream_unavailable")
  })

  it("succeeded면 본문 그대로 + 세션·역할 쿠키(백엔드 complete 경로로 보낸다)", async () => {
    const succeeded = {
      outcome: "succeeded",
      role: "exhibitor",
      gate: { application_status: "registered", has_profile: false },
      route: "/home",
      roles: ["exhibitor"],
      access_token: "id-token-2",
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(succeeded)).mockResolvedValueOnce(jsonResponse({}))

    const res = await POST(completeRequest())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(succeeded)
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("id-token-2")
    expect(res.cookies.get(ROLE_COOKIE)?.value).toBe("exhibitor")
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/auth\/login\/complete$/)
  })
})
