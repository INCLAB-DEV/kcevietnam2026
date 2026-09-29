// 가입 이메일 인증코드 확인 BFF(#9): 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계 B).
// 성공(200) 시 verification_token을 그대로 되돌린다 — signup-client.ts의 signup()이 그 토큰을
// email_verification_token으로 실어 보낸다.

import { NextResponse } from "next/server"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export async function POST(request: Request) {
  const body = await request.json()

  const upstream = await fetch(`${BACKEND_URL}/api/auth/signup/email-code/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
