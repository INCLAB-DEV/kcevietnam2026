// 세션 파생 쿠키(org·신청상태) 재동기화 BFF.
//
// 왜 필요한가: 라우트 게이트(proxy.ts → route-guard)는 성능상 매 요청마다 백엔드를 부르지 않고
// **로그인 시점에 심은 STATUS_COOKIE**로 승인 여부를 판단한다. 그런데 승인은 운영자가 나중에
// 누르는 서버 측 사건이라, 승인 전에 로그인해 둔 참가자의 쿠키는 계속 옛 상태(submitted)로 남는다.
// 그 상태로 서비스에 들어오려 하면 게이트가 /welcome으로 되돌리고, /welcome은 실시간 /api/me로
// approved를 보고 다시 /로 보내 **무한 리다이렉트**가 된다(2026-09-10 실사용자 보고).
//
// 이 라우트가 그 갈림을 없앤다 — /api/me를 다시 읽어 쿠키를 최신 상태로 덮은 뒤 next로 보낸다.
// 재시도 폭주를 막으려고 시도 자체를 짧은 마커 쿠키로 남긴다(REFRESHED_COOKIE) — 갱신에 실패해도
// 호출부(/welcome)가 그 마커를 보고 더는 이리로 보내지 않는다(루프 대신 안내 화면으로 degrade).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"

import { bootstrapMeCookies } from "@/lib/auth/me-bootstrap"
import { resolvePublicOrigin } from "@/lib/auth/request-origin"
import { REFRESHED_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session-cookie"

export const dynamic = "force-dynamic"

const REFRESHED_TTL_SECONDS = 30

// 오픈 리다이렉트 방지 — 같은 출처의 절대경로만 허용한다("//host"·"http://" 차단).
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/"
  return raw
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const next = safeNext(url.searchParams.get("next"))
  // request.url의 origin이 아니라 Host 헤더 기반 공개 origin을 써야 한다 — GH #1.
  const origin = resolvePublicOrigin(request, url)
  const target = new URL(next, origin)

  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.redirect(new URL("/login", origin))
  }

  const response = NextResponse.redirect(target)
  // 마커를 먼저 심는다 — 아래 부트스트랩이 실패(백엔드 장애)해도 재시도 루프에 빠지지 않게.
  response.cookies.set(REFRESHED_COOKIE, "1", {
    ...sessionCookieOptions,
    maxAge: REFRESHED_TTL_SECONDS,
  })
  await bootstrapMeCookies(response, token, undefined)
  return response
}
