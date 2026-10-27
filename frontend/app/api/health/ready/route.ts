// 준비 상태 헬스체크 — 외부 헬스체크(Route 53)가 보는 경로. Next 프로세스만 보는 /api/health(그대로 둔다)와 달리
// 백엔드 GET /health/ready(FastAPI → DB SELECT 1)까지 확인해 200/503을 그대로 비춘다. 인증 불필요(proxy.ts
// matcher가 /api/* 제외). Next는 살아 있는데 백엔드·DB가 죽은 상태를 잡으려는 것이다.
//
// 응답 대기는 짧게 끊는다(1.5초) — Route 53은 연결 뒤 2초 안에 응답을 받아야 정상으로 본다. 백엔드는 DB 확인을
// 1초에서 끊는다(backend/app/main.py READY_DB_TIMEOUT_SECONDS). 원인은 숨기고 상태만 낸다.
import { NextResponse } from "next/server"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"
const READY_TIMEOUT_MS = 1500

export const dynamic = "force-dynamic"

function unavailable(): NextResponse {
  return NextResponse.json({ status: "unavailable" }, { status: 503 })
}

export async function GET() {
  try {
    const upstream = await fetch(`${BACKEND_URL}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READY_TIMEOUT_MS),
    })
    if (!upstream.ok) return unavailable()
  } catch {
    return unavailable() // 연결 실패·시간 초과
  }
  return NextResponse.json({ status: "ok" }, { status: 200 })
}
