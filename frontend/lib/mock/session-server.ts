import { cookies } from "next/headers"
import {
  DEV_AS_COOKIE,
  DEV_STATUS_COOKIE,
  DEV_PERIOD_COOKIE,
  resolveMockSession,
  resolveOrganizerSession,
  toGuardSession,
  type MockSession,
} from "./session"
import type { Session as GuardSession } from "@/lib/auth/route-guard"
import { resolveRealSession } from "@/lib/auth/real-session"
import { ROLE_COOKIE, SESSION_COOKIE, STATUS_COOKIE } from "@/lib/auth/session-cookie"

// 요청 쿠키(DEV_AS_COOKIE) 단일 소스에서 세션을 해석한다. 페이지·셸 모두 이걸로 읽어
// nav(쿠키)와 페이지 데이터(쿠키)가 같은 계정을 보게 한다. proxy가 ?as를 이 쿠키로 미러링.
// next/headers는 서버 전용이라 순수 session.ts와 분리(= proxy/클라 import는 영향 없음).
//
// dev 전환 쿠키는 dev에서만 신뢰한다 — prod에선 무시해 쿠키 위조로 역할이 상승되는 걸 막는다
// (proxy와 동일 게이트). 실연동 시 Cognito 세션이 이 자리를 대체한다.
const DEV_SWITCHER_ENABLED = process.env.NODE_ENV !== "production"

async function devCookie(name: string): Promise<string | undefined> {
  if (!DEV_SWITCHER_ENABLED) return undefined
  return (await cookies()).get(name)?.value
}

export async function resolveRequestSession(): Promise<MockSession> {
  const [as, status] = await Promise.all([devCookie(DEV_AS_COOKIE), devCookie(DEV_STATUS_COOKIE)])
  return resolveMockSession(as, status)
}

// 운영자 라우트(/organizer/*, /admin/*)의 목업 세션 — 항상 organizer role, ?as=organizer-sub만
// 등급을 sub로 가른다. **dev 쿠키는 반드시 devCookie() 게이트를 통과해야 한다**: nabi_dev_as는
// httpOnly가 아니라(proxy.ts가 심는다) 브라우저 콘솔에서 한 줄로 세팅할 수 있어서, prod에서
// 이 쿠키를 직접 읽으면 누구나 화면의 신원·권한등급을 바꿀 수 있었다(2026-09-10 결함:
// admin-shell.tsx와 app/organizer/members/page.tsx가 jar.get(DEV_AS_COOKIE)를 직접 읽었다).
// 운영자 라우트의 목업 세션 해석은 이 함수 하나로 모은다 — 게이트를 빠뜨릴 자리를 없앤다.
export async function resolveOrganizerRequestSession(): Promise<MockSession> {
  return resolveOrganizerSession(await devCookie(DEV_AS_COOKIE))
}

// dev 계정 스위처가 이번 요청에 **명시적으로** 켜져 있는가(?as= 로 고른 계정이 쿠키에 살아있는가).
// proxy.ts의 devOverrideActive와 같은 판정이고 같은 용도다 — 우선순위 규칙("dev 스위처가 활성이면
// dev 세션이 실 세션보다 우선")을 셸에서도 그대로 지키기 위한 것. 덕분에 실 로그인 쿠키가 남아있는
// 로컬에서 ?as=organizer로 목업 화면을 보던 개발 흐름이 그대로 살아있다.
// prod에서는 devCookie()가 항상 undefined라 언제나 false — 실 세션만 남는다.
export async function devSessionOverrideActive(): Promise<boolean> {
  return (await devCookie(DEV_AS_COOKIE)) !== undefined
}

// prod 배포 차단 P0: dev 스위처가 꺼진 상태(DEV_SWITCHER_ENABLED=false)에서는 devCookie()가 항상
// undefined라 예전 toGuardSession(undefined, undefined)이 항상 MOCK_ACCOUNTS.buyer를
// "인증됨"으로 돌려줬다 — /api/buyer-profile·/api/buyer-apply·/api/organizer/** 같은 API 라우트는
// (프록시 미들웨어 게이트 밖, matcher가 api/를 제외) 이 guard.authenticated 하나만 보고 요청을
// 통과시키므로, 쿠키 한 장 없는 완전 미인증 요청도 "김바이어"로 서버 저장소에 쓸 수 있었다.
//
// proxy.ts(엣지 미들웨어)가 페이지 진입 게이트에 쓰는 것과 동일한 resolveRealSession으로 실
// 로그인 쿠키(SESSION_COOKIE/ROLE_COOKIE/STATUS_COOKIE)를 판정해 판정 기준을 일치시킨다. 실
// 세션도 없으면 명시적으로 미인증 — mock 신원으로 폴백하지 않는다.
async function resolveProdGuard(): Promise<GuardSession> {
  const jar = await cookies()
  const real = resolveRealSession({
    session: jar.get(SESSION_COOKIE)?.value,
    role: jar.get(ROLE_COOKIE)?.value,
    status: jar.get(STATUS_COOKIE)?.value,
  })
  return real ?? { authenticated: false }
}

export async function resolveRequestGuard(): Promise<GuardSession> {
  if (!DEV_SWITCHER_ENABLED) return resolveProdGuard()
  const [as, status] = await Promise.all([devCookie(DEV_AS_COOKIE), devCookie(DEV_STATUS_COOKIE)])
  return toGuardSession(as, status)
}

// dev 신청기간 오버라이드(?period=open|closed → 쿠키). proxy·페이지가 같은 값을 보도록 노출.
export async function requestPeriodOverride(): Promise<string | undefined> {
  return devCookie(DEV_PERIOD_COOKIE)
}
