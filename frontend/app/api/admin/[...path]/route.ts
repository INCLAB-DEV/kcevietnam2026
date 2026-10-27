// 슈퍼어드민 콘솔 BFF — 같은 출처 /api/admin/* 를 FastAPI /api/admin/* 로 통과시키는 프록시.
//
// 클라이언트(admin-actions의 dispatch)는 토큰을 만지지 않는다 — 로그인 BFF가 심어둔 httpOnly
// 세션 쿠키를 이 라우트가 서버 측에서 읽어 `Authorization: Bearer` 로 붙인다(클라 JS 미노출,
// lib/auth/session-cookie.ts). 접근 제한의 권위는 FastAPI 가드(require_event_master 등)가
// 내린다 — 여기서 재검사하지 않고 401/403을 그대로 통과시킨다(경계 B 단일 지점).
//
// 응답은 상태코드·본문·content-type 통과 — JSON(대부분)과 xlsx 바이너리(엑셀 export) 모두 지원.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ path: string[] }> }

async function proxy(method: string, request: Request, { params }: Ctx): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.json({ success: false, error: "no_session" }, { status: 401 })
  }

  const { path } = await params
  const target = `${BACKEND_URL}/api/admin/${path.join("/")}${new URL(request.url).search}`

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

  // Fetch forbids a body for 204/205/304, including an empty ArrayBuffer. FastAPI's
  // successful DELETE returns 204; attaching that empty buffer made this BFF throw 500.
  const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304
  const response = new NextResponse(noBody ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
  })
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

export async function PATCH(request: Request, ctx: Ctx) {
  return proxy("PATCH", request, ctx)
}

export async function DELETE(request: Request, ctx: Ctx) {
  return proxy("DELETE", request, ctx)
}
