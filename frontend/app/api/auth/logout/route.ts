// F-AU-001 로그아웃 BFF: 로그인 라우트(start/complete)가 심은 httpOnly 실 세션 쿠키 4종은
// httpOnly라 클라이언트 JS(document.cookie)로는 지울 수 없다 — 서버 라우트에서 Set-Cookie
// (Max-Age=0)로 폐기해야 한다. 쿠키 이름·path/sameSite/httpOnly 옵션은 session-cookie.ts의
// 상수를 그대로 재사용해 로그인 때 심은 것과 대칭을 맞춘다(다른 옵션이면 브라우저가 별개
// 쿠키로 취급해 삭제가 안 먹는다).

import { NextResponse } from "next/server"

import { resolvePublicOrigin } from "@/lib/auth/request-origin"
import {
  ORG_COOKIE,
  REFRESHED_COOKIE,
  ROLE_COOKIE,
  SESSION_COOKIE,
  STATUS_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie"

const SESSION_COOKIES = [SESSION_COOKIE, ROLE_COOKIE, ORG_COOKIE, STATUS_COOKIE, REFRESHED_COOKIE]
// dev 스위처 쿠키(proxy.ts가 심음, httpOnly 아님) — 브라우저 주소창 리셋 시 함께 청소한다.
const DEV_COOKIES = ["nabi_dev_as", "nabi_dev_status", "nabi_dev_period"]

function clearCookies(response: NextResponse) {
  for (const name of SESSION_COOKIES) {
    response.cookies.set(name, "", { ...sessionCookieOptions, maxAge: 0 })
  }
  for (const name of DEV_COOKIES) {
    response.cookies.set(name, "", { path: "/", sameSite: "lax", maxAge: 0 })
  }
  return response
}

export async function POST() {
  return clearCookies(NextResponse.json({ ok: true }))
}

// 브라우저 주소창에서 방문만 해도 세션·dev 쿠키가 전부 초기화되는 리셋 경로.
// localhost 쿠키가 쌓여 헤더가 비대해지는 로컬 개발 문제의 원클릭 처방이기도 하다.
export async function GET(request: Request) {
  // request.url의 origin이 아니라 Host 헤더 기반 공개 origin을 써야 한다 — GH #1.
  const origin = resolvePublicOrigin(request, new URL(request.url))
  return clearCookies(NextResponse.redirect(new URL("/login", origin)))
}
