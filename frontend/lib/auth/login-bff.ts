// 로그인 두 단계(start·complete) BFF 공용 처리 — 브라우저 → route handler(서버) → FastAPI(ADR-0001 경계).
// app/api/auth/login/start/route.ts·app/api/auth/login/complete/route.ts가 경로만 바꿔 부른다.
//
// 비즈니스 결과는 FastAPI가 200으로 내려준다 — body(snake_case)를 그대로 통과시키고 상태를 보존한다(camelCase
// 매핑은 client 어댑터 http-auth-client 담당). 성공 응답의 access_token은 httpOnly 쿠키로 보관하고(session-cookie.ts),
// 역할 쿠키와 P1-1 부트스트랩(GET /api/me → org·신청상태 쿠키, me-bootstrap.ts)까지 심는다 — 재방문자는 start에서,
// 최초 진입자는 complete에서 로그인이 끝나므로 두 라우트가 똑같이 해야 한다.
//
// 실패는 던지지 않고 JSON 오류로 돌려준다(2026-10-02 부하 테스트 — 백엔드가 몰림으로 평문 500을 내자 예전 라우트가
// upstream.json()에서 SyntaxError로 같이 터져, 화면이 실패를 받지 못하고 멈췄다):
//   - 백엔드 JSON 응답(성공·비즈니스 결과·503 login_busy·422 등) → 상태·본문 그대로
//   - 백엔드가 JSON이 아닌 본문(풀 고갈 평문 500 등)        → 같은 상태(2xx였다면 502) + code "upstream_error"
//   - 백엔드에 닿지 못함(재시작 중·연결 거부·끊김)             → 502 + code "upstream_unavailable"
//   - 브라우저가 보낸 본문이 JSON이 아님                       → 400 + code "invalid_body"
// 오류 바디는 FastAPI와 같은 {detail: {code, message}} 모양이다 — 화면(lib/auth/login-errors)이 한 가지로 읽는다.
//
// 브라우저가 요청을 끊으면(입력을 고쳐 로그인 시도를 그만둠·화면을 떠남 — components/auth/login-flow) 백엔드 호출도
// 같이 끊는다: request.signal은 브라우저 연결이 응답 전에 닫히면 abort된다. 이 응답은 아무도 받지 않으므로 쿠키도
// 심지 않고 부트스트랩(/api/me)도 부르지 않는다 → 499 + code "client_closed_request"(백엔드 장애가 아니라 오류 로그 없음).

import { NextResponse } from "next/server"
import {
  ROLE_COOKIE,
  SESSION_COOKIE,
  extractAccessToken,
  extractRole,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie"
import { bootstrapMeCookies } from "@/lib/auth/me-bootstrap"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// 화면은 detail.code로만 문구를 고른다(lib/auth/login-errors → messages의 login.error*, 화면 로케일).
// 여기 message는 화면에 쓰이지 않는 로그·디버깅용 설명이라 문장을 로케일별로 두지 않는다.
const RETRY_LATER_MESSAGE = "Login request could not be processed; retry later"

function errorResponse(status: number, code: string, message: string = RETRY_LATER_MESSAGE): NextResponse {
  return NextResponse.json({ detail: { code, message } }, { status })
}

// 브라우저가 응답을 기다리지 않고 연결을 닫았다 — 이 응답은 전달되지 않는다. 499는 표준 코드가 아니라
// "client closed request" 관례(nginx)다.
function clientClosedResponse(): NextResponse {
  return errorResponse(499, "client_closed_request")
}

export async function forwardLoginStep(request: Request, backendPath: string): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, "invalid_body", "Request body is not valid JSON")
  }

  let upstream: Response
  try {
    upstream = await fetch(`${BACKEND_URL}${backendPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (err) {
    if (request.signal.aborted) return clientClosedResponse()
    // 원인(연결 거부 등)은 서버 로그에만 — 화면엔 코드만 간다. 자격증명이 든 요청 본문은 남기지 않는다.
    console.error(`[login-bff] ${backendPath} 백엔드에 닿지 못함`, err)
    return errorResponse(502, "upstream_unavailable")
  }

  let data: unknown
  try {
    data = await upstream.json()
  } catch {
    if (request.signal.aborted) return clientClosedResponse()
    console.error(`[login-bff] ${backendPath} 백엔드 응답이 JSON이 아님 (status ${upstream.status})`)
    return errorResponse(upstream.ok ? 502 : upstream.status, "upstream_error")
  }
  // 응답을 다 받은 뒤에 끊긴 걸 알았다 — 아래(쿠키·/api/me 부트스트랩)는 아무도 받지 않는 응답을 위한 일이다.
  if (request.signal.aborted) return clientClosedResponse()

  const response = NextResponse.json(data, { status: upstream.status })
  const token = extractAccessToken(data)
  if (token) {
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions)
    // role은 토큰 자체엔 없다 — 나란히 쿠키로 심어둔다(참가자 실 세션 분기가 읽는다,
    // lib/auth/http-session.ts·lib/auth/real-session.ts 참고).
    const role = extractRole(data)
    if (role) {
      response.cookies.set(ROLE_COOKIE, role, sessionCookieOptions)
      const record = data as { gate?: { application_status?: unknown } }
      await bootstrapMeCookies(response, token, record.gate?.application_status)
    }
  }
  return response
}
