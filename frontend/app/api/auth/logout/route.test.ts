import { describe, it, expect } from "vitest"
import { GET, POST } from "./route"
import {
  ORG_COOKIE,
  REFRESHED_COOKIE,
  ROLE_COOKIE,
  SESSION_COOKIE,
  STATUS_COOKIE,
} from "@/lib/auth/session-cookie"

// 상태 재동기화 마커(REFRESHED_COOKIE)도 세션 파생물이라 로그아웃에서 함께 지운다.
const SESSION_NAMES = [SESSION_COOKIE, ROLE_COOKIE, ORG_COOKIE, STATUS_COOKIE, REFRESHED_COOKIE]
const DEV_NAMES = ["nabi_dev_as", "nabi_dev_status", "nabi_dev_period"]

function expectAllCookiesCleared(setCookie: string[]) {
  expect(setCookie).toHaveLength(SESSION_NAMES.length + DEV_NAMES.length)
  for (const name of SESSION_NAMES) {
    const header = setCookie.find((line) => line.startsWith(`${name}=`))
    expect(header, `${name} 쿠키가 삭제 헤더에 없다`).toBeDefined()
    expect(header).toMatch(/Max-Age=0/i)
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/Path=\//i)
  }
  for (const name of DEV_NAMES) {
    const header = setCookie.find((line) => line.startsWith(`${name}=`))
    expect(header, `${name} 쿠키가 삭제 헤더에 없다`).toBeDefined()
    expect(header).toMatch(/Max-Age=0/i)
  }
}

// 로그아웃 BFF — httpOnly 실 세션 쿠키 4종은 클라 JS로 못 지운다. 이 라우트가
// Set-Cookie(Max-Age=0)로 세션 5종 + dev 스위처 3종을 전부 폐기하는지 검증한다.
describe("/api/auth/logout", () => {
  it("POST: 세션 5종 + dev 3종 쿠키를 모두 만료시킨다(Max-Age=0)", async () => {
    const response = await POST()
    expectAllCookiesCleared(response.headers.getSetCookie())
  })

  it("GET: 같은 쿠키 정리 후 /login으로 리다이렉트한다(주소창 리셋 경로)", async () => {
    const response = await GET(new Request("http://localhost:3000/api/auth/logout"))
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost:3000/login")
    expectAllCookiesCleared(response.headers.getSetCookie())
  })

  // GH #1 회귀 방지 — standalone 서버의 request.url origin은 Dockerfile의 HOSTNAME=0.0.0.0
  // 바인드 주소를 쓴다. Host 헤더를 기준으로 리다이렉트해야 브라우저가 실제 서버로 돌아간다.
  it("GET: Host 헤더가 바인드 주소(0.0.0.0)와 달라도 그 Host 기준으로 리다이렉트한다", async () => {
    const request = new Request("http://0.0.0.0:3000/api/auth/logout", {
      headers: { host: "app.example.com" },
    })
    const response = await GET(request)
    expect(response.headers.get("location")).toBe("http://app.example.com/login")
    expect(response.headers.get("location")).not.toContain("0.0.0.0")
  })

  it("GET: X-Forwarded-Host가 있으면 그걸 우선한다", async () => {
    const request = new Request("http://0.0.0.0:3000/api/auth/logout", {
      headers: { host: "0.0.0.0:3000", "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" },
    })
    const response = await GET(request)
    expect(response.headers.get("location")).toBe("https://app.example.com/login")
  })
})
