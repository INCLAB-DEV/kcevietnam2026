import { describe, expect, it } from "vitest"
import { canWriteAdmin, resolveAdminAccess } from "./guard"
import { resolveRouteAccess } from "@/lib/auth/route-guard"

// 가드는 두 겹이다: 라우트(역할) + 권한등급(master/sub). 둘 다 외부 관찰 동작으로 고정한다.

describe("resolveAdminAccess — 권한등급 게이트", () => {
  it("organizer(master)는 전체 권한 — 거버넌스·신청서 편집 모두", () => {
    const access = resolveAdminAccess({ role: "organizer", permissionLevel: "master" })
    expect(access.kind).toBe("full")
    expect(canWriteAdmin(access)).toBe(true)
    expect(access.canEditOrgProfiles).toBe(true)
  })

  it("organizer(sub)는 신청서 편집은 가능, 거버넌스는 조회만 (ADR-0012 개정)", () => {
    const access = resolveAdminAccess({ role: "organizer", permissionLevel: "sub" })
    expect(access.kind).toBe("read-only")
    expect(canWriteAdmin(access)).toBe(false) // 거버넌스(설정·역할·명단)는 막힌다
    expect(access.canEditOrgProfiles).toBe(true) // 관할 기업 신청서는 편집 가능
    if (access.kind === "read-only") expect(access.notice).toContain("조회만")
  })

  it("권한등급 미상 organizer는 안전하게 sub로 떨어진다 (미상 ≠ 거버넌스 전권)", () => {
    const access = resolveAdminAccess({ role: "organizer" })
    expect(access.kind).toBe("read-only")
    expect(canWriteAdmin(access)).toBe(false)
    expect(access.canEditOrgProfiles).toBe(true)
  })

  it("참가자(buyer/exhibitor)는 접근 불가 — 본 서비스 홈으로", () => {
    for (const role of ["buyer", "exhibitor"] as const) {
      const access = resolveAdminAccess({ role })
      expect(access.kind).toBe("denied")
      if (access.kind === "denied") expect(access.redirectTo).toBe("/")
      expect(canWriteAdmin(access)).toBe(false)
      expect(access.canEditOrgProfiles).toBe(false) // 진입 불가 = 신청서 편집도 없음
    }
  })
})

describe("route-guard — /admin 라우트 정책", () => {
  const base = {
    now: "2026-08-28",
    applicationOpensAt: "2026-08-26",
    applicationClosesAt: "2026-09-11",
  }

  it("organizer는 /admin 과 하위 경로에 진입할 수 있다", () => {
    for (const path of ["/admin", "/admin/organizations", "/admin/settings"]) {
      expect(
        resolveRouteAccess({
          ...base,
          session: { authenticated: true, role: "organizer" },
          targetPath: path,
        }),
      ).toEqual({ allowed: true })
    }
  })

  it("참가자는 /admin 에서 자기 홈으로 되돌려진다", () => {
    const access = resolveRouteAccess({
      ...base,
      session: { authenticated: true, role: "buyer", applicationStatus: "approved" },
      targetPath: "/admin/organizations",
    })
    expect(access).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/" })
  })

  it("미인증은 /admin 에서 로그인으로 차단된다", () => {
    const access = resolveRouteAccess({
      ...base,
      session: { authenticated: false },
      targetPath: "/admin",
    })
    expect(access).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
  })

  it("/admin 은 신청기간·승인 게이트를 타지 않는다 (운영자는 게이트 면제)", () => {
    // 신청기간이 한참 남은 시점이라도 운영자는 막히지 않는다.
    expect(
      resolveRouteAccess({
        now: "2026-01-01",
        applicationOpensAt: "2026-08-26",
        applicationClosesAt: "2026-09-11",
        session: { authenticated: true, role: "organizer" },
        targetPath: "/admin",
      }),
    ).toEqual({ allowed: true })
  })
})
