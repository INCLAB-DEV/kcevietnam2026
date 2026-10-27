// 참가사·바이어 프로필 BFF — 같은 출처 /api/bm/* 를 FastAPI /api/bm/* 로 통과시키는 프록시
// (app/api/admin/[...path]/route.ts와 동일 패턴). 클라 프로필 클라이언트(lib/bm/http-exhibitor-client·
// lib/bm/http-buyer-client)는 토큰을 만지지 않는다 — 로그인 BFF가 심어둔 httpOnly 세션 쿠키를
// 이 라우트가 서버 측에서 읽어 `Authorization: Bearer` 로 붙인다(클라 JS 미노출,
// lib/auth/session-cookie.ts). 소유권(403)·존재(404)는 FastAPI(app/bm/router.py _load_owned_role)가
// 내린다 — 여기서 재검사하지 않고 상태코드·본문을 그대로 통과시킨다(경계 B 단일 지점).
//
// [[...path]] (옵셔널 catch-all): 현재 모든 라우트가 /buyer|/exhibitor 하위 세그먼트를 요구하지만,
// admin/meetings BFF와 동일한 옵셔널 catch-all 관례를 따라 향후 루트 경로가 생겨도 이 한 라우트가
// 받는다.

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
  const target = `${BACKEND_URL}/api/bm${segments.length ? "/" + segments.join("/") : ""}${new URL(request.url).search}`

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

export async function PATCH(request: Request, ctx: Ctx) {
  return proxy("PATCH", request, ctx)
}
