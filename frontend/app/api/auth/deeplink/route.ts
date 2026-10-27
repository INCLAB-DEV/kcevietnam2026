// F-AU-001 딥링크 토큰 검증 BFF(ADR-0001 경계): 브라우저 → 이 route handler(서버) → FastAPI.
// FastAPI 응답을 FE seam의 DeeplinkCheck 형상으로 매핑해 돌려준다(계약 §FE BFF route handlers).
//   200 { context:{username,name} } → { status:"valid", username, name }
//   401 { detail:{reason} }         → reason "expired" → expired, 그 외 → invalid
//   기타 비정상                       → invalid(막다른 길 방지 — 폼으로 빠지게)

import { NextResponse } from "next/server"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

export async function POST(request: Request) {
  const { token } = (await request.json()) as { token: string }

  const upstream = await fetch(`${BACKEND_URL}/api/auth/deeplink/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  })

  if (upstream.ok) {
    const data = (await upstream.json()) as { context: { username: string; name: string } }
    return NextResponse.json({ status: "valid", username: data.context.username, name: data.context.name })
  }

  let reason: string | undefined
  try {
    const err = (await upstream.json()) as { detail?: { reason?: string } }
    reason = err?.detail?.reason
  } catch {
    // 본문 없는/비-JSON 오류는 invalid로 처리
  }
  return NextResponse.json(reason === "expired" ? { status: "expired" } : { status: "invalid" })
}
