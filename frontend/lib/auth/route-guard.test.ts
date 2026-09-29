import { describe, it, expect } from "vitest"
import { resolveRouteAccess, type RouteGuardInput } from "./route-guard"

// 기본: 신청기간 8/26~9/11(종료됨, now=9/12), 승인된 참가자. 개별 케이스가 필요한 값만 덮어쓴다.
function guard(partial: Partial<RouteGuardInput> & { targetPath: string }): RouteGuardInput {
  return {
    session: { authenticated: true, role: "buyer", applicationStatus: "approved" },
    now: "2026-09-12", // 신청기간 종료 이후 (KST)
    applicationOpensAt: "2026-08-26",
    applicationClosesAt: "2026-09-11",
    ...partial,
  }
}

describe("resolveRouteAccess — 기본/역할", () => {
  it("미로그인으로 보호 페이지 접근 시 /login으로 리다이렉트한다", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/" }))
    ).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
  })

  it("/login은 공개 경로라 미로그인도 허용한다(리다이렉트 루프 방지)", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/login" }))
    ).toEqual({ allowed: true })
  })

  it("운영사가 참가자 전용 페이지(/discover)에 접근하면 forbidden-role, 운영사 홈으로", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: true, role: "organizer" }, targetPath: "/discover" }))
    ).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/organizer" })
  })

  it("참가자가 운영사 전용 페이지(/organizer/members)에 접근하면 forbidden-role, 참가자 홈으로", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "approved" }, targetPath: "/organizer/members" })
      )
    ).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/" })
  })

  it("운영사는 합성 게이트 면제 — 자기 대시보드 항상 접근", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "organizer" }, targetPath: "/organizer", now: "2026-08-01" })
      )
    ).toEqual({ allowed: true })
  })
})

describe("resolveRouteAccess — 본 서비스 nav 게이트 (승인=즉시 입장)", () => {
  it("승인 + 신청기간 종료 참가자는 본 서비스 진입 허용", () => {
    expect(
      resolveRouteAccess(guard({ targetPath: "/meetings" }))
    ).toEqual({ allowed: true })
  })

  it("승인 참가자는 신청기간 중에도 본 서비스 진입 허용 (승인=즉시 입장, 2026-09-09 정책 변경)", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer", applicationStatus: "approved" }, targetPath: "/", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("신청기간 종료지만 미승인(submitted)이면 본 서비스 차단 → /welcome", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "submitted" }, targetPath: "/profile" })
      )
    ).toEqual({ allowed: false, reason: "service-locked", redirectTo: "/welcome" })
  })

  it("status 미상(undefined)이면 안전하게 미승인 취급 → /welcome", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer" }, targetPath: "/" })
      )
    ).toEqual({ allowed: false, reason: "service-locked", redirectTo: "/welcome" })
  })

  it("신청기간과 무관하게 승인자는 본 서비스 진입 허용 (경계일 포함)", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer", applicationStatus: "approved" }, targetPath: "/", now: "2026-09-11" })
      )
    ).toEqual({ allowed: true })
  })
})

describe("resolveRouteAccess — 미인증은 nav 페이지 진입 불가 → /login", () => {
  it("기업 탐색(/discover)은 미로그인 시 /login으로 차단", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/discover", now: "2026-09-01" }))
    ).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
  })

  it("후행 슬래시(/discover/)·상세(/discover/:id)도 미로그인 시 /login", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/discover/", now: "2026-09-01" }))
    ).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/discover/ex-001", now: "2026-09-01" }))
    ).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
  })

  it("내 미팅(/meetings)도 미로그인 시 /login으로 차단", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: false }, targetPath: "/meetings", now: "2026-09-01" }))
    ).toEqual({ allowed: false, reason: "unauthenticated", redirectTo: "/login" })
  })

  it("인증 참가자는 /discover에도 본 서비스 게이트 적용 — 미승인이면 /welcome (F-DV-001 D11 대체)", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer", applicationStatus: "registered" }, targetPath: "/discover", now: "2026-09-01" })
      )
    ).toEqual({ allowed: false, reason: "service-locked", redirectTo: "/welcome" })
  })
})

describe("resolveRouteAccess — /welcome (입장 전 랜딩, 게이트 면제)", () => {
  it("미승인 참가자도 /welcome은 접근 허용(루프 방지)", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "registered" }, targetPath: "/welcome", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("운영사가 /welcome에 접근하면 forbidden-role, 운영사 홈으로", () => {
    expect(
      resolveRouteAccess(guard({ session: { authenticated: true, role: "organizer" }, targetPath: "/welcome" }))
    ).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/organizer" })
  })
})

describe("resolveRouteAccess — apply 게이트 (/exhibitor/apply)", () => {
  it("신청기간 중 + registered 참가사는 작성 허용", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "registered" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("신청기간 중 + changes_requested 참가사는 수정 허용", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "changes_requested" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("신청기간 중엔 submitted·approved·rejected도 apply 진입 허용 — 폼이 읽기전용(신청서 보기)으로 렌더", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "submitted" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "approved" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "rejected" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("신청기간 종료면 status와 무관하게 apply 잠금 → /welcome", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "registered" }, targetPath: "/exhibitor/apply", now: "2026-09-12" })
      )
    ).toEqual({ allowed: false, reason: "apply-locked", redirectTo: "/welcome" })
  })

  it("바이어가 /exhibitor/apply 접근 → forbidden-role(참가사 전용)", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer", applicationStatus: "registered" }, targetPath: "/exhibitor/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/" })
  })

  it("바이어 /apply도 같은 apply 게이트 — 신청기간 중 registered면 허용", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "buyer", applicationStatus: "registered" }, targetPath: "/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: true })
  })

  it("참가사가 /apply(바이어 전용) 접근 → forbidden-role", () => {
    expect(
      resolveRouteAccess(
        guard({ session: { authenticated: true, role: "exhibitor", applicationStatus: "registered" }, targetPath: "/apply", now: "2026-09-01" })
      )
    ).toEqual({ allowed: false, reason: "forbidden-role", redirectTo: "/" })
  })
})
