import { describe, expect, it } from "vitest"
import { LoginRequestError, loginErrorCode, loginFailureKind } from "./login-errors"

describe("loginErrorCode", () => {
  it("{detail: {code}}에서 code를 꺼낸다", () => {
    expect(loginErrorCode({ detail: { code: "login_busy", message: "…" } })).toBe("login_busy")
  })

  it("형식 밖(문자열 detail·검증 배열·null·JSON 아님)이면 null", () => {
    expect(loginErrorCode({ detail: "Internal Server Error" })).toBeNull()
    expect(loginErrorCode({ detail: [{ loc: ["body", "username"], msg: "required" }] })).toBeNull()
    expect(loginErrorCode(null)).toBeNull()
    expect(loginErrorCode("Internal Server Error")).toBeNull()
  })
})

describe("loginFailureKind", () => {
  it("503 login_busy는 busy", () => {
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 503, "login_busy"))).toBe("busy")
  })

  it("코드가 없어도 503이면 busy, 코드가 login_busy·server_busy면 상태와 무관하게 busy", () => {
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 503, null))).toBe("busy")
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 503, "server_busy"))).toBe("busy")
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 500, "login_busy"))).toBe("busy")
  })

  it("그 밖의 5xx(평문 500·BFF 502)는 몰림이라 단정하지 않고 unavailable", () => {
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 500, null))).toBe("unavailable")
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 500, "upstream_error"))).toBe("unavailable")
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 502, "upstream_unavailable"))).toBe(
      "unavailable",
    )
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 504, null))).toBe("unavailable")
  })

  it("응답을 못 받은 네트워크 오류·예상 밖 4xx는 unavailable", () => {
    expect(loginFailureKind(new TypeError("Failed to fetch"))).toBe("unavailable")
    expect(loginFailureKind(new LoginRequestError("/api/auth/login/start", 400, "invalid_body"))).toBe("unavailable")
  })

  it("에러 메시지는 로그용으로 경로·상태·코드를 담는다", () => {
    const error = new LoginRequestError("/api/auth/login/start", 503, "login_busy")
    expect(error.message).toBe("auth request failed: /api/auth/login/start (503 login_busy)")
    expect(error.name).toBe("LoginRequestError")
  })
})
