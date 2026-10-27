// 페이지 진입 라우트 가드의 순수 결정 로직 (HM-001 / #8, FE ADR-0002 합성 게이트).
// 단계: 로그인 여부 → 역할 → 게이트(참가자 전용). 화면/미들웨어는 이 결과로 리다이렉트만 한다.
// now / 신청기간은 주입받는다(Date.now 하드코딩 금지, KST 기준 YYYY-MM-DD).
//
// 합성 게이트(ADR-0002): "승인된 기업만 본 서비스" 규칙을 여기서 강제한다.
//  - service 게이트(본 서비스 nav): application_status === "approved" AND 신청기간 종료. 미충족 → /welcome.
//  - apply 게이트(/exhibitor/apply): 신청기간 중 AND status ∈ {registered, changes_requested}. 그 외 → /welcome.
//  - 운영자는 게이트 면제(역할 정책만). 미인증은 공개 경로(/login) 외 모두 /login으로 차단한다.
// 종전 SERVICE_OPENS_AT 단독 타이밍 게이트는 이 합성 게이트가 대체한다.

import type { ApplicationStatus } from "@/lib/bm/types"
import { isApplicationOpen } from "@/lib/bm/application-period"

export type ParticipantRole = "buyer" | "exhibitor"
export type SessionRole = ParticipantRole | "organizer"

// 인증된 참가자는 application_status를 함께 싣는다(게이트가 읽음). 운영자는 무관(optional).
// status 미상(undefined)은 안전하게 미승인으로 취급 → 본 서비스 차단(/welcome).
export type Session =
  | { authenticated: false }
  | { authenticated: true; role: SessionRole; applicationStatus?: ApplicationStatus }

export interface RouteGuardInput {
  session: Session
  targetPath: string
  now: string // YYYY-MM-DD (KST)
  applicationOpensAt: string // YYYY-MM-DD (KST) — 비즈매칭 신청 시작(events.application_start)
  applicationClosesAt: string // YYYY-MM-DD (KST) — 신청 종료(events.application_end)
}

export type RouteAccess =
  | { allowed: true }
  | {
      allowed: false
      reason: "unauthenticated" | "forbidden-role" | "service-locked" | "apply-locked"
      redirectTo: string
    }

// none  : 역할 정책만(게이트 면제) — /login·/welcome·/organizer
// service: 본 서비스 nav — approved AND 신청기간 종료
// apply : /exhibitor/apply 작성/수정 — 신청기간 중 AND status ∈ {registered, changes_requested}
type GateKind = "none" | "service" | "apply"

interface RoutePolicy {
  allowedRoles: SessionRole[]
  gate: GateKind
}

function isPublic(path: string): boolean {
  // /signup: 자체 회원가입(F-AU-00X) — 로그인과 동일하게 인증 게이트 밖의 공개 진입점.
  return path === "/login" || path === "/signup"
}

// 후행 슬래시 정규화 — "/discover/"를 "/discover"와 동일 취급(루트 "/"는 보존).
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

function policyFor(path: string): RoutePolicy {
  if (path === "/organizer" || path.startsWith("/organizer/")) {
    return { allowedRoles: ["organizer"], gate: "none" }
  }
  // 슈퍼어드민 콘솔(/admin) — 시스템 관리 표면. /organizer(행사 운영)와 같은 역할 정책이며,
  // organizer 안의 권한등급(master=슈퍼어드민 / sub=서브어드민 읽기전용)은 라우트가 아니라
  // 화면에서 가른다(lib/admin/guard). 참가자는 여기서 자기 홈으로 되돌려진다.
  if (path === "/admin" || path.startsWith("/admin/")) {
    return { allowedRoles: ["organizer"], gate: "none" }
  }
  // 입장 전 랜딩 — 미승인 참가자가 사는 곳. 게이트 면제(여기로 리다이렉트되므로 루프 방지). 운영자는 대상 아님.
  if (path === "/welcome") {
    return { allowedRoles: ["buyer", "exhibitor"], gate: "none" }
  }
  // 참가사 신청서 작성/수정 — apply 게이트(신청기간 중 + 미제출/보완요청). 단독 화면(AppShell 밖).
  if (path === "/exhibitor/apply" || path.startsWith("/exhibitor/apply/")) {
    return { allowedRoles: ["exhibitor"], gate: "apply" }
  }
  // 바이어 신청서 작성/수정(BM-001) — 참가사 apply와 대칭. 같은 apply 게이트로 보호한다.
  if (path === "/apply" || path.startsWith("/apply/")) {
    return { allowedRoles: ["buyer"], gate: "apply" }
  }
  // 기업 탐색은 인증 참가자 전용 — 본 서비스 게이트 적용(ADR-0002).
  if (path === "/discover" || path.startsWith("/discover/")) {
    return { allowedRoles: ["buyer", "exhibitor"], gate: "service" }
  }
  // 알림은 참가사/바이어 전용 — 운영자 알림 미제공.
  if (path === "/notifications") {
    return { allowedRoles: ["buyer", "exhibitor"], gate: "service" }
  }
  // 내 미팅(MY-001)은 참가사·바이어 공용 인증 전용. 운영사는 대상 아님.
  if (path === "/meetings" || path.startsWith("/meetings/")) {
    return { allowedRoles: ["buyer", "exhibitor"], gate: "service" }
  }
  // 그 외(/, /profile, /exhibitor/profile …)는 참가자 전용 + 본 서비스 게이트.
  return { allowedRoles: ["buyer", "exhibitor"], gate: "service" }
}

function roleHome(role: SessionRole): string {
  return role === "organizer" ? "/organizer" : "/"
}

export function resolveRouteAccess(input: RouteGuardInput): RouteAccess {
  const targetPath = normalizePath(input.targetPath)
  if (isPublic(targetPath)) return { allowed: true }

  const policy = policyFor(targetPath)

  if (!input.session.authenticated) {
    return { allowed: false, reason: "unauthenticated", redirectTo: "/login" }
  }

  const { role } = input.session

  if (!policy.allowedRoles.includes(role)) {
    return { allowed: false, reason: "forbidden-role", redirectTo: roleHome(role) }
  }

  // 운영자·게이트 없는 경로는 여기서 통과(역할 정책만).
  if (role === "organizer" || policy.gate === "none") return { allowed: true }

  const status = input.session.applicationStatus
  const open = isApplicationOpen(input.now, {
    opensAt: input.applicationOpensAt,
    closesAt: input.applicationClosesAt,
  })
  if (policy.gate === "service") {
    // 본 서비스 진입 = 승인만으로 즉시(2026-09-09 정책 변경: 신청기간 종료 대기 제거 — 승인=입장).
    // 가입→승인→서핑(Discover)→컨택이 곧바로 이어지게. 신청기간은 apply 게이트에만 남는다.
    if (status === "approved") return { allowed: true }
    return { allowed: false, reason: "service-locked", redirectTo: "/welcome" }
  }

  // apply 게이트: 신청기간 중에는 진입 허용 — 폼이 status로 편집/읽기전용을 정한다(registered·submitted·
  // changes_requested=작성/수정, approved·rejected=신청서 보기). 신청기간 종료 후에는 잠금 → /welcome.
  if (open) return { allowed: true }
  return { allowed: false, reason: "apply-locked", redirectTo: "/welcome" }
}
