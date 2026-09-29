import { NextResponse, type NextRequest } from "next/server"
import { resolveRouteAccess, type Session as GuardSession } from "@/lib/auth/route-guard"
import { resolveRealSession } from "@/lib/auth/real-session"
import { resolveApplicationPeriod } from "@/lib/bm/application-period"
import { ROLE_COOKIE, SESSION_COOKIE, STATUS_COOKIE } from "@/lib/auth/session-cookie"
import {
  DEV_AS_COOKIE,
  DEV_STATUS_COOKIE,
  DEV_PERIOD_COOKIE,
  toGuardSession,
} from "@/lib/mock/session"

// Next 16 미들웨어(=proxy). 페이지 진입 전 라우트 가드를 적용해 로그인·역할·합성 게이트로 리다이렉트한다.
// 결정 로직은 lib/auth/route-guard(단위 테스트됨), 여기선 요청→가드 연결만 한다.
//
// dev 전환(?as/?status/?period): proxy가 값을 쿠키로 미러링하고 쿼리 없는 URL로 redirect한다.
// 이후 서버 컴포넌트는 이 쿠키만 읽어 세션·기간을 해석 → nav(쿠키)와 페이지 데이터(쿠키)가 한 계정을
// 보게 되어 divergence가 구조적으로 불가능. dev 쿼리는 오직 여기(proxy)에서만 해석한다.
//
// 실 로그인 세션(P1-4): 로그인 BFF가 심은 쿠키 3종(nabi_session/_role/_status)이 있으면 그 세션으로
// 게이트를 판정한다(판정 자체는 순수 함수 lib/auth/real-session.ts로 뽑아 테스트). 우선순위:
//   dev에서 ?as=/dev 쿠키가 명시적으로 활성 → dev 세션이 실 세션보다 우선(기존 스위처·테스트 보존)
//   그 외 실 세션이 있으면 실 세션
//   dev인데 아무 것도 없으면(첫 방문 등) 기존 기본 mock 세션(데모 편의, 종전 동작 그대로)
//   prod인데 실 세션도 없으면 미인증 — 예전엔 여기서도 항상 기본 mock buyer로 통과시켰다(TODO 표식이
//   붙어 있던 실연동 전 placeholder). 이제 실 로그인만이 prod 진입 조건이다.

// 비즈매칭 신청기간(KST). 권위 출처는 Event DB(events.application_start/end). 데모는 env 임시 주입.
// 미설정이면 항상 열림 → 신청기간 미종료라 본 서비스(nav)는 잠긴다(승인+종료 둘 다 필요).
const APP_OPENS_AT = process.env.BM_APPLICATION_OPENS_AT ?? "2000-01-01"
const APP_CLOSES_AT = process.env.BM_APPLICATION_CLOSES_AT ?? "2999-12-31"
const DEV_SWITCHER_ENABLED = process.env.NODE_ENV !== "production"

function kstToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
}

export function proxy(request: NextRequest): NextResponse {
  const url = request.nextUrl
  // dev 컨텍스트: URL 쿼리(전환 트리거)가 우선, 없으면 기존 쿠키. prod에선 dev 스위처 비활성.
  // prod에선 쿼리·쿠키 둘 다 무시 — 쿠키 위조(role/status 상승)를 막는다.
  const param = (key: string) => (DEV_SWITCHER_ENABLED ? url.searchParams.get(key) : null)
  const cookie = (key: string) =>
    DEV_SWITCHER_ENABLED ? (request.cookies.get(key)?.value ?? null) : null

  const asParam = param("as")
  const statusParam = param("status")
  const periodParam = param("period")
  const as = asParam ?? cookie(DEV_AS_COOKIE)
  const status = statusParam ?? cookie(DEV_STATUS_COOKIE)
  const periodOverride = periodParam ?? cookie(DEV_PERIOD_COOKIE)

  const period = resolveApplicationPeriod({
    override: periodOverride,
    opensAt: APP_OPENS_AT,
    closesAt: APP_CLOSES_AT,
  })

  // dev 스위처가 이번 요청에서(쿼리) 또는 이전 선택이 쿠키로(DEV_AS_COOKIE) 살아있으면 "명시적으로
  // 활성" — prod에서는 as가 항상 null이라 이 값도 항상 false(위 param/cookie 게이팅 재사용).
  const devOverrideActive = as !== null
  const realSession =
    process.env.NEXT_PUBLIC_AUTH_CLIENT === "http"
      ? resolveRealSession({
          session: request.cookies.get(SESSION_COOKIE)?.value,
          role: request.cookies.get(ROLE_COOKIE)?.value,
          status: request.cookies.get(STATUS_COOKIE)?.value,
        })
      : null
  const guardSession: GuardSession = devOverrideActive
    ? toGuardSession(as, status)
    : (realSession ?? (DEV_SWITCHER_ENABLED ? toGuardSession(as, status) : { authenticated: false }))

  const access = resolveRouteAccess({
    session: guardSession,
    targetPath: url.pathname,
    now: kstToday(),
    applicationOpensAt: period.opensAt,
    applicationClosesAt: period.closesAt,
  })

  // dev 쿼리(as/status/period)가 오면 쿠키에 박고 쿼리 없는 URL로 redirect → 페이지는 쿼리를 보지 못한다.
  const hasDevParam = asParam !== null || statusParam !== null || periodParam !== null
  if (hasDevParam) {
    const redirectUrl = url.clone()
    redirectUrl.searchParams.delete("as")
    redirectUrl.searchParams.delete("status")
    redirectUrl.searchParams.delete("period")
    redirectUrl.pathname = access.allowed ? url.pathname : access.redirectTo
    const res = NextResponse.redirect(redirectUrl)
    const opts = { path: "/", sameSite: "lax" as const }
    if (asParam !== null) res.cookies.set(DEV_AS_COOKIE, asParam, opts)
    if (statusParam !== null) res.cookies.set(DEV_STATUS_COOKIE, statusParam, opts)
    if (periodParam !== null) res.cookies.set(DEV_PERIOD_COOKIE, periodParam, opts)
    return res
  }

  if (!access.allowed) {
    const redirectUrl = url.clone()
    redirectUrl.pathname = access.redirectTo
    return NextResponse.redirect(redirectUrl)
  }

  return NextResponse.next()
}

// 정적 자산·_next 내부 요청·API 라우트는 가드 제외.
// /api/*는 BFF 라우트 핸들러(인증 시작·딥링크 등) — 자체 인증을 하므로 페이지 게이트를 적용하면
// 미인증 로그인 POST가 /welcome으로 리다이렉트돼 인증을 시작조차 못 한다(합성 게이트는 페이지 전용).
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.).*)"],
}
