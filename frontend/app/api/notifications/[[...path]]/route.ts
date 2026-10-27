// NT-001 알림 인박스 BFF — 같은 출처 /api/notifications/* 를 FastAPI /api/notifications/* 로
// 통과시키는 프록시(app/api/admin/[...path]/route.ts와 동일 패턴). 클라이언트
// (lib/notifications/inbox-actions.ts)는 토큰을 만지지 않는다 — 로그인 BFF가 심어둔 httpOnly
// 세션 쿠키를 이 라우트가 서버 측에서 읽어 `Authorization: Bearer`로 붙인다(클라 JS 미노출,
// lib/auth/session-cookie.ts). 접근 제한의 권위는 FastAPI(get_current_principal)가 내린다 —
// 여기서 재검사하지 않고 상태코드·본문을 그대로 통과시킨다(경계 B 단일 지점).
//
// [[...path]] (옵셔널 catch-all)인 이유: GET /api/notifications(목록, 세그먼트 없음)와
// POST /api/notifications/{id}/read · POST /api/notifications/read-all(세그먼트 있음)을
// 모두 이 한 라우트가 받아야 한다.
//
// admin BFF와 달리 GET도 이 프록시를 탄다 — /notifications 인박스의 최초 페이지는 서버 컴포넌트가
// lib/notifications/http-inbox-client.ts로 FastAPI를 직접 호출하지만(서버-서버 호출은 BFF 왕복이
// 불필요, meetings 읽기와 동일 이유), "더보기"(next_cursor)·읽음 처리는 클라이언트 이벤트라 같은
// 출처 경로가 필요하다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { noSessionResponse } from "@/lib/auth/no-session-response"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ path?: string[] }> }

async function proxy(method: string, request: Request, { params }: Ctx): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return noSessionResponse()

  const { path } = await params
  const segments = path ?? []
  const target = `${BACKEND_URL}/api/notifications${segments.length ? "/" + segments.join("/") : ""}${new URL(request.url).search}`

  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = request.headers.get("content-type")
  if (contentType) headers["content-type"] = contentType

  const hasBody = method !== "GET" && method !== "HEAD"
  const body = hasBody ? await request.arrayBuffer() : undefined

  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody && body && body.byteLength > 0 ? body : undefined,
  })

  const data = await upstream.arrayBuffer()
  const response = new NextResponse(data, { status: upstream.status })
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType) response.headers.set("content-type", upstreamType)
  return response
}

export async function GET(request: Request, ctx: Ctx) {
  return proxy("GET", request, ctx)
}

export async function POST(request: Request, ctx: Ctx) {
  return proxy("POST", request, ctx)
}
