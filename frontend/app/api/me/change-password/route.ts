// 셀프 비밀번호 변경 BFF — 같은 출처 POST /api/me/change-password 를 FastAPI
// POST /api/me/change-password 로 통과시키는 프록시(app/api/bm/[[...path]]/route.ts와 동일 패턴).
// 클라(lib/auth/change-password-client)는 토큰을 만지지 않는다 — 로그인 BFF가 심어둔 httpOnly 세션
// 쿠키를 이 라우트가 서버 측에서 읽어 `Authorization: Bearer` 로 붙인다(클라 JS 미노출,
// lib/auth/session-cookie.ts). 현재 비밀번호 검증·정책 판정·계정 상태 판정은 전부
// FastAPI(app/auth/password_change.py)가 내린다 — 여기서 재검사하지 않고 상태코드·본문을 그대로
// 통과시킨다(경계 B 단일 지점). 403(현재 비밀번호 불일치)·409(로컬 비밀번호 없음)·422(정책 위반·
// 기존과 동일)가 화면까지 그대로 닿아야 다이얼로그가 서버 문구를 보여줄 수 있다.
//
// catch-all이 아닌 고정 경로다 — /api/me 하위에서 이 BFF가 받는 건 이 엔드포인트 하나뿐이고,
// GET /api/me 는 서버 컴포넌트가 lib/auth/me-client로 직접 호출한다(BFF를 거치지 않는다).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { noSessionResponse } from "@/lib/auth/no-session-response"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return noSessionResponse()

  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = request.headers.get("content-type")
  if (contentType) headers["content-type"] = contentType

  const body = await request.arrayBuffer()

  const upstream = await fetch(`${BACKEND_URL}/api/me/change-password`, {
    method: "POST",
    headers,
    body: body.byteLength > 0 ? body : undefined,
  })

  const data = await upstream.arrayBuffer()
  const response = new NextResponse(data.byteLength > 0 ? data : null, { status: upstream.status })
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType) response.headers.set("content-type", upstreamType)
  return response
}
