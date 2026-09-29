// 관심기업(북마크) 뮤테이션/조회 BFF — 같은 출처 /api/discover/bookmarks/* 를
// FastAPI /api/discover/bookmarks/* 로 통과시키는 프록시(app/api/bm/[[...path]]/route.ts와
// 동일 패턴, H-01: 서버 영속화). 클라(lib/discover/bookmark-store)는 토큰을 만지지 않는다 —
// 로그인 BFF가 심어둔 httpOnly 세션 쿠키를 이 라우트가 서버 측에서 읽어 `Authorization: Bearer`로
// 붙인다(클라 JS 미노출, lib/auth/session-cookie.ts). 소유권·가시성·승인 검사는
// FastAPI(app/discover/service.py)가 내린다 — 여기서 재검사하지 않고 상태코드·본문을 그대로
// 통과시킨다(경계 B 단일 지점).
//
// [[...path]] (옵셔널 catch-all): GET/POST(세그먼트 없음, 목록·등록)와
// DELETE /api/discover/bookmarks/{orgId}(세그먼트 1개, 해제)를 한 라우트가 받는다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ path?: string[] }> }

async function proxy(method: string, request: Request, { params }: Ctx): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.json(
      { detail: { code: "NO_SESSION", message: "로그인이 필요합니다" } },
      { status: 401 }
    )
  }

  const { path } = await params
  const segments = path ?? []
  const target = `${BACKEND_URL}/api/discover/bookmarks${segments.length ? "/" + segments.join("/") : ""}${new URL(request.url).search}`

  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = request.headers.get("content-type")
  if (contentType) headers["content-type"] = contentType

  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE"
  const body = hasBody ? await request.arrayBuffer() : undefined

  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody && body && body.byteLength > 0 ? body : undefined,
  })

  const data = await upstream.arrayBuffer()
  const response = new NextResponse(data.byteLength > 0 ? data : null, { status: upstream.status })
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

export async function DELETE(request: Request, ctx: Ctx) {
  return proxy("DELETE", request, ctx)
}
