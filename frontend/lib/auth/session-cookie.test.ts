import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_COOKIE, extractAccessToken, extractRole, sessionCookieOptions } from "./session-cookie"

describe("로그인 응답에서 세션 토큰 추출", () => {
  it("succeeded + access_token 이면 토큰을 꺼낸다", () => {
    const data = { outcome: "succeeded", role: "organizer", access_token: "access-mbr-org-01-1" }
    expect(extractAccessToken(data)).toBe("access-mbr-org-01-1")
  })

  it("succeeded 여도 토큰이 없으면 null (계약 밖 응답 방어)", () => {
    expect(extractAccessToken({ outcome: "succeeded" })).toBeNull()
  })

  it("성공 외 결과는 토큰이 있어도 무시한다", () => {
    expect(extractAccessToken({ outcome: "rejected", access_token: "x" })).toBeNull()
    expect(extractAccessToken({ outcome: "consent_required", access_token: "x" })).toBeNull()
  })

  it("null·문자열 등 비객체 입력은 null", () => {
    expect(extractAccessToken(null)).toBeNull()
    expect(extractAccessToken("succeeded")).toBeNull()
    expect(extractAccessToken(undefined)).toBeNull()
  })
})

describe("로그인 응답에서 role 추출(ROLE_COOKIE에 심을 값)", () => {
  it("buyer/exhibitor/organizer는 그대로 반환한다", () => {
    expect(extractRole({ outcome: "succeeded", role: "buyer" })).toBe("buyer")
    expect(extractRole({ outcome: "succeeded", role: "exhibitor" })).toBe("exhibitor")
    // organizer 실 로그인 → ROLE_COOKIE="organizer" → route-guard가 /organizer·/admin 통과시킨다.
    expect(extractRole({ outcome: "succeeded", role: "organizer" })).toBe("organizer")
  })

  it("계약 밖 role이거나 succeeded가 아니면 null", () => {
    expect(extractRole({ outcome: "succeeded", role: "garbage" })).toBeNull()
    expect(extractRole({ outcome: "rejected", role: "organizer" })).toBeNull()
    expect(extractRole(null)).toBeNull()
  })
})

describe("세션 쿠키 규약", () => {
  it("httpOnly + lax 로 클라 JS에 노출하지 않는다", () => {
    expect(SESSION_COOKIE).toBe("nabi_session")
    expect(sessionCookieOptions.httpOnly).toBe(true)
    expect(sessionCookieOptions.sameSite).toBe("lax")
    expect(sessionCookieOptions.maxAge).toBeGreaterThan(0)
  })
})

describe("세션 쿠키 secure 플래그 (NABI_COOKIE_SECURE 오버라이드, HTTP ALB 데모)", () => {
  afterEach(() => {
    // vi.stubEnv로 건드린 값은 unstubAllEnvs가 원래값으로 되돌려준다(NODE_ENV는 readonly 타입이라
    // 직접 대입 불가 — stubEnv/unstubAllEnvs 쌍으로만 다뤄야 한다).
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("NABI_COOKIE_SECURE=false 면 production이어도 secure=false (HTTP ALB)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NABI_COOKIE_SECURE", "false")
    vi.resetModules()
    const mod = await import("./session-cookie")
    expect(mod.sessionCookieOptions.secure).toBe(false)
  })

  it("NABI_COOKIE_SECURE 미설정 + production 이면 기존대로 secure=true", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NABI_COOKIE_SECURE", undefined)
    vi.resetModules()
    const mod = await import("./session-cookie")
    expect(mod.sessionCookieOptions.secure).toBe(true)
  })

  it("NABI_COOKIE_SECURE 미설정 + 비-production 이면 기존대로 secure=false", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("NABI_COOKIE_SECURE", undefined)
    vi.resetModules()
    const mod = await import("./session-cookie")
    expect(mod.sessionCookieOptions.secure).toBe(false)
  })
})
