// F-AU-001 로그인 2단계(complete) BFF: 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계).
// 약관 동의 → 세션 발급 트랜잭션. 비즈니스 결과는 200으로 내려오므로 body(snake_case)를 통과시킨다.
// camelCase 매핑은 client 어댑터(http-auth-client)가 담당.
// 성공 응답의 access_token은 httpOnly 쿠키로 보관한다(클라이언트 JS 미노출, session-cookie.ts).
//
// P1-1 부트스트랩: 로그인 성공 직후 발급 토큰으로 FastAPI GET /api/me를 호출해 org·신청상태 쿠키를
// 마저 심는다(lib/auth/me-bootstrap.ts) — 최초 진입자(약관 동의 후 이 라우트로 성공)는 여기서,
// 재방문자(app/api/auth/login/start/route.ts에서 곧바로 succeeded)는 그쪽에서 같은 헬퍼를 부른다.

import { NextResponse } from "next/server"
import {
  ROLE_COOKIE,
  SESSION_COOKIE,
  extractAccessToken,
  extractRole,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie"
import { bootstrapMeCookies } from "@/lib/auth/me-bootstrap"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export async function POST(request: Request) {
  const body = await request.json()

  const upstream = await fetch(`${BACKEND_URL}/api/auth/login/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const data = await upstream.json()
  const response = NextResponse.json(data, { status: upstream.status })
  const token = extractAccessToken(data)
  if (token) {
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions)
    // role은 토큰 자체엔 없다 — 나란히 쿠키로 심어둔다(참가자 실 세션 분기가 읽는다,
    // lib/auth/http-session.ts·lib/auth/real-session.ts 참고).
    const role = extractRole(data)
    if (role) {
      response.cookies.set(ROLE_COOKIE, role, sessionCookieOptions)
      const record = data as { gate?: { application_status?: unknown } }
      await bootstrapMeCookies(response, token, record.gate?.application_status)
    }
  }
  return response
}
