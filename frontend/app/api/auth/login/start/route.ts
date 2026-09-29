// F-AU-001 로그인 1단계(start) BFF: 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계).
// 비즈니스 결과는 FastAPI가 200으로 내려준다 — body(snake_case)를 그대로 통과시키고 상태를 보존한다.
// camelCase 매핑은 client 어댑터(http-auth-client)가 담당.
// 성공 응답의 access_token은 httpOnly 쿠키로 보관한다(클라이언트 JS 미노출, session-cookie.ts).
//
// ⚠ 재방문자는 로그인이 여기서 곧바로 succeeded로 끝난다(약관 동의 스텝을 안 거친다) — 그래서
// P1-1 부트스트랩(GET /api/me → org·신청상태 쿠키)도 complete와 똑같이 여기서 불러야 한다
// (lib/auth/me-bootstrap.ts). 최초 진입자는 app/api/auth/login/complete/route.ts에서.

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

  const upstream = await fetch(`${BACKEND_URL}/api/auth/login/start`, {
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
