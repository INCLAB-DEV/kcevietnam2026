import { describe, it, expect } from "vitest"
import { resolveMockSession, resolveOrganizerSession, toGuardSession, MOCK_ACCOUNTS } from "./session"

describe("resolveMockSession", () => {
  it("as=buyer → 바이어 계정", () => {
    const s = resolveMockSession("buyer")
    expect(s.role).toBe("buyer")
    expect(s.orgId).toBe("buyer-1")
    expect(s.user.name).toBe("김바이어")
  })

  it("as=exhibitor → 참가사 계정", () => {
    expect(resolveMockSession("exhibitor").role).toBe("exhibitor")
  })

  it("as=organizer → 운영사 계정", () => {
    expect(resolveMockSession("organizer").role).toBe("organizer")
  })

  it("미지정/잘못된 값은 기본 바이어로 폴백한다", () => {
    expect(resolveMockSession(null).role).toBe("buyer")
    expect(resolveMockSession(undefined).role).toBe("buyer")
    expect(resolveMockSession("invalid").role).toBe("buyer")
  })

  it("toGuardSession: as=guest는 미인증 세션", () => {
    expect(toGuardSession("guest")).toEqual({ authenticated: false })
  })

  it("toGuardSession: 계정값은 인증된 세션(role + application_status 포함)", () => {
    // 참가자는 기본 application_status(registered)를 함께 싣는다(게이트가 승인 여부를 봄).
    expect(toGuardSession("exhibitor")).toEqual({
      authenticated: true,
      role: "exhibitor",
      applicationStatus: "registered",
    })
    // 운영자는 application_status 없음(게이트 면제).
    expect(toGuardSession("organizer")).toEqual({
      authenticated: true,
      role: "organizer",
      applicationStatus: undefined,
    })
  })

  it("toGuardSession: ?status= 가 application_status를 덮어쓴다(참가자 한정)", () => {
    expect(toGuardSession("exhibitor", "approved")).toEqual({
      authenticated: true,
      role: "exhibitor",
      applicationStatus: "approved",
    })
    // 잘못된 status는 무시하고 계정 기본값.
    expect(toGuardSession("buyer", "bogus")).toEqual({
      authenticated: true,
      role: "buyer",
      applicationStatus: "registered",
    })
    // 운영자는 ?status= 무시.
    expect(toGuardSession("organizer", "approved")).toEqual({
      authenticated: true,
      role: "organizer",
      applicationStatus: undefined,
    })
  })

  it("toGuardSession: 미지정은 인증된 기본 바이어(registered)", () => {
    expect(toGuardSession(null)).toEqual({
      authenticated: true,
      role: "buyer",
      applicationStatus: "registered",
    })
  })

  it("모든 계정은 사이드바 유저 정보(name/affiliation/email/phone)를 갖는다", () => {
    for (const acc of Object.values(MOCK_ACCOUNTS)) {
      expect(acc.user.name.length).toBeGreaterThan(0)
      expect(acc.user.affiliation.length).toBeGreaterThan(0)
      expect(acc.user.email).toContain("@")
      expect(acc.user.phone.length).toBeGreaterThan(0)
    }
  })

  it("as=organizer-sub → sub 무역관 세션(role organizer)", () => {
    const s = resolveMockSession("organizer-sub")
    expect(s.role).toBe("organizer")
    expect(s.permissionLevel).toBe("sub")
    expect(s.tradeOffice).toContain("무역관")
  })
})

describe("resolveOrganizerSession — 운영자 라우트는 항상 organizer", () => {
  it("organizer → master, organizer-sub → sub", () => {
    expect(resolveOrganizerSession("organizer").permissionLevel).toBe("master")
    expect(resolveOrganizerSession("organizer-sub").permissionLevel).toBe("sub")
  })
  it("buyer 등 다른 값도 organizer(master)로 강제 — 강등 안 됨", () => {
    const s = resolveOrganizerSession("buyer")
    expect(s.role).toBe("organizer")
    expect(s.permissionLevel).toBe("master")
  })
})
