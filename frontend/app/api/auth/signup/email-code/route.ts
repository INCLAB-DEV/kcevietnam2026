// 가입 이메일 인증코드 발송 BFF(#9): 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계 B).
// app/api/auth/signup/route.ts와 동일한 통과(pass-through) 패턴 — 200/429/422를 그대로 전달한다.

import { NextResponse } from "next/server"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export async function POST(request: Request) {
  const body = await request.json()

  const upstream = await fetch(`${BACKEND_URL}/api/auth/signup/email-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
