// F-AU-001 로그인 2단계(complete) BFF: 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계).
// 약관 동의 → 세션 발급 트랜잭션. 비즈니스 결과는 200으로 내려오므로 body(snake_case)를 통과시킨다.
// camelCase 매핑은 client 어댑터(http-auth-client)가 담당.
// 성공 응답의 access_token은 httpOnly 쿠키로 보관한다(클라이언트 JS 미노출, session-cookie.ts).
//
// P1-1 부트스트랩: 로그인 성공 직후 발급 토큰으로 FastAPI GET /api/me를 호출해 org·신청상태 쿠키를
// 마저 심는다(lib/auth/me-bootstrap.ts) — 최초 진입자(약관 동의 후 이 라우트로 성공)는 여기서,
// 재방문자(app/api/auth/login/start/route.ts에서 곧바로 succeeded)는 그쪽에서 같은 헬퍼를 부른다.
//
// 통과·쿠키·부트스트랩과 실패 처리(백엔드의 평문 500·연결 실패도 던지지 않고 JSON 오류로)는 start와 같아
// lib/auth/login-bff.ts 한 곳에 둔다.

import { forwardLoginStep } from "@/lib/auth/login-bff"

export async function POST(request: Request) {
  return forwardLoginStep(request, "/api/auth/login/complete")
}
