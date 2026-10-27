import { describe, expect, it } from "vitest"
import { resolveRealSession } from "./real-session"

describe("resolveRealSession — 실 로그인 세션 쿠키 → route-guard Session", () => {
  it("세션 토큰이 없으면 실 세션 아님(null)", () => {
    expect(resolveRealSession({ session: null, role: "buyer", status: "approved" })).toBeNull()
    expect(resolveRealSession({ session: undefined, role: "buyer", status: "approved" })).toBeNull()
  })

  it("역할이 buyer/exhibitor/organizer가 아니면 null(미상 값 방어)", () => {
    expect(resolveRealSession({ session: "tok", role: undefined, status: "approved" })).toBeNull()
    expect(resolveRealSession({ session: "tok", role: "garbage", status: "approved" })).toBeNull()
  })

  it("유효한 buyer/exhibitor 세션이면 authenticated:true", () => {
    expect(resolveRealSession({ session: "tok", role: "buyer", status: "approved" })).toEqual({
      authenticated: true,
      role: "buyer",
      applicationStatus: "approved",
    })
    expect(resolveRealSession({ session: "tok", role: "exhibitor", status: "registered" })).toEqual({
      authenticated: true,
      role: "exhibitor",
      applicationStatus: "registered",
    })
  })

  it("organizer 세션이면 authenticated:true(라우트 가드가 /organizer·/admin 통과에 사용)", () => {
    expect(resolveRealSession({ session: "tok", role: "organizer", status: null })).toEqual({
      authenticated: true,
      role: "organizer",
      applicationStatus: undefined,
    })
  })

  it("status가 없거나(부트스트랩 실패) 계약 밖 값이면 applicationStatus는 undefined(안전하게 미승인)", () => {
    expect(resolveRealSession({ session: "tok", role: "buyer", status: null })).toEqual({
      authenticated: true,
      role: "buyer",
      applicationStatus: undefined,
    })
    expect(resolveRealSession({ session: "tok", role: "buyer", status: "not-a-real-status" })).toEqual({
      authenticated: true,
      role: "buyer",
      applicationStatus: undefined,
    })
  })
})
