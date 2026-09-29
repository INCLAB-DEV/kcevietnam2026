// 미팅 회의록(F-MY-002) BFF — 같은 출처 /api/reviews/* 를 FastAPI /meetings/{id}/review... 로
// 통과시키는 프록시(app/api/admin/[...path]/route.ts와 동일 패턴). ⚠ 백엔드 리뷰 라우터는
// **무접두사**다(prefix="/meetings/{meeting_id}", backend/app/api/reviews.py — /api/meetings가 아니다).
// 예전엔 X-Org-Id 헤더를 그대로 믿는 자기신고 방식(deps.current_org_id, 누구나 위조 가능)을 썼는데
// 백엔드가 이미 제거·금지했다("다시 만들지 말 것", backend/app/api/deps.py) — 이제 주체는 서명된
// 세션(Bearer)에서만 나온다.
//
// 클라 리뷰 클라이언트(lib/review/http-review-client)는 토큰을 만지지 않는다 — 로그인 BFF가
// 심어둔 httpOnly 세션 쿠키를 이 라우트가 서버 측에서 읽어 Authorization: Bearer로 붙인다
// (lib/auth/session-cookie.ts). 참석자 검사(403)는 FastAPI(_require_participant)가 내린다.
//
// multipart(전사 오디오 업로드)도 바이트 그대로 통과한다(admin BFF의 xlsx 바이너리 export와 동일
// 기법) — content-type(boundary 포함)을 그대로 넘기고 body는 arrayBuffer로 원본을 보존한다.

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
    return NextResponse.json({ detail: { code: "NO_SESSION", message: "로그인이 필요합니다" } }, { status: 401 })
  }

  const { path } = await params
  const target = `${BACKEND_URL}/meetings/${path.join("/")}${new URL(request.url).search}`

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
