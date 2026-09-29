// F-AU-001 인증 경계 구현 선택. 기본은 mock(데모 불변), env로 실연동 HTTP 구현으로 스왑한다.
//   NEXT_PUBLIC_AUTH_CLIENT="http"  → httpAuthClient (브라우저 → Next BFF → FastAPI)
//   그 외(미설정 포함)              → mockAuthClient (6/17 데모·테스트 기본)
// NEXT_PUBLIC_ 접두사라 client component에서도 읽힌다(login-flow.tsx 기본 client 주입에 쓴다).

import type { AuthClient } from "./auth-types"
import { mockAuthClient } from "./mock-auth-client"
import { httpAuthClient } from "./http-auth-client"

export function resolveAuthClient(): AuthClient {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http" ? httpAuthClient : mockAuthClient
}

// 기본 주입용 단일 인스턴스 — login-flow.tsx의 client 기본값.
export const defaultAuthClient: AuthClient = resolveAuthClient()
