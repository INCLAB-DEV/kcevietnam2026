// 자체 회원가입 BFF: 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계 B). login/start
// route(app/api/auth/login/start/route.ts)와 동일한 통과(pass-through) 패턴 — 비즈니스 결과
// (201/409/422)를 FastAPI가 그대로 내려주면 상태코드·바디를 보존해 전달한다. camelCase↔snake_case
// 매핑은 client 어댑터(lib/auth/signup-client.ts의 httpSignupClient)가 담당한다.

import { NextResponse } from "next/server"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export async function POST(request: Request) {
  const body = await request.json()

  const upstream = await fetch(`${BACKEND_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
