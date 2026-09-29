import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

// route.ts가 next/headers의 cookies()로 세션 토큰을 읽는다. 테스트는 Next 요청 스코프 밖에서
// 라우트 핸들러를 직접 부르므로(실제 서버 렌더가 아님) cookies()가
// "called outside a request scope"로 던진다 — 이 라우트가 필요로 하는 값만 흉내낸 스텁으로 대체한다.
let sessionToken: string | undefined
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE && sessionToken ? { value: sessionToken } : undefined),
  }),
}))

const { GET } = await import("./route")

// GH #1 회귀 방지 — standalone 서버의 request.url origin은 Dockerfile의 HOSTNAME=0.0.0.0
// 바인드 주소를 쓴다. 이 라우트는 반드시 Host 헤더(또는 X-Forwarded-Host) 기준으로 리다이렉트
// origin을 계산해야 하며, 0.0.0.0이 Location 헤더에 나타나면 안 된다.
describe("/api/auth/refresh", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    sessionToken = "demo-token"
    vi.stubGlobal("fetch", fetchMock)
    // bootstrapMeCookies가 부르는 GET /api/me — 실패해도 리다이렉트는 진행되므로 최소 응답만.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function requestWithCookieAndHost(host: string | null, url: string) {
    const headers = new Headers()
    if (host) headers.set("host", host)
    return new Request(url, { headers })
  }

  it("Host 헤더가 바인드 주소(0.0.0.0)와 달라도 그 Host를 기준으로 리다이렉트한다", async () => {
    const request = requestWithCookieAndHost(
      "app.example.com",
      "http://0.0.0.0:3000/api/auth/refresh?next=/meetings",
    )
    const response = await GET(request)
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://app.example.com/meetings")
  })

  it("X-Forwarded-Host가 있으면 그걸 우선한다", async () => {
    const headers = new Headers({
      cookie: `${SESSION_COOKIE}=demo-token`,
      host: "0.0.0.0:3000",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    })
    const request = new Request("http://0.0.0.0:3000/api/auth/refresh?next=/meetings", { headers })
    const response = await GET(request)
    expect(response.headers.get("location")).toBe("https://app.example.com/meetings")
  })

  it("Location 헤더에 0.0.0.0이 절대 나타나지 않는다", async () => {
    const request = requestWithCookieAndHost(
      "app.example.com",
      "http://0.0.0.0:3000/api/auth/refresh?next=/meetings",
    )
    const response = await GET(request)
    expect(response.headers.get("location")).not.toContain("0.0.0.0")
  })

  it("Host 헤더가 없으면(로컬/테스트) request.url의 origin으로 폴백한다", async () => {
    const request = requestWithCookieAndHost(null, "http://localhost:3000/api/auth/refresh?next=/meetings")
    const response = await GET(request)
    expect(response.headers.get("location")).toBe("http://localhost:3000/meetings")
  })

  it("세션 쿠키가 없으면 Host 기준 /login으로 리다이렉트한다", async () => {
    sessionToken = undefined
    const headers = new Headers({ host: "app.example.com" })
    const request = new Request("http://0.0.0.0:3000/api/auth/refresh?next=/meetings", { headers })
    const response = await GET(request)
    expect(response.headers.get("location")).toBe("http://app.example.com/login")
  })
})
