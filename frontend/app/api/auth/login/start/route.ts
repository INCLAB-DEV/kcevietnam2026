// F-AU-001 로그인 1단계(start) BFF: 브라우저 → 이 route handler(서버) → FastAPI(ADR-0001 경계).
// 비즈니스 결과는 FastAPI가 200으로 내려준다 — body(snake_case)를 그대로 통과시키고 상태를 보존한다.
// camelCase 매핑은 client 어댑터(http-auth-client)가 담당.
// 성공 응답의 access_token은 httpOnly 쿠키로 보관한다(클라이언트 JS 미노출, session-cookie.ts).
//
// ⚠ 재방문자는 로그인이 여기서 곧바로 succeeded로 끝난다(약관 동의 스텝을 안 거친다) — 그래서
// P1-1 부트스트랩(GET /api/me → org·신청상태 쿠키)도 complete와 똑같이 여기서 불러야 한다
// (lib/auth/me-bootstrap.ts). 최초 진입자는 app/api/auth/login/complete/route.ts에서.
//
// 통과·쿠키·부트스트랩과 실패 처리(백엔드의 평문 500·연결 실패도 던지지 않고 JSON 오류로)는 complete와 같아
// lib/auth/login-bff.ts 한 곳에 둔다. 로그인이 몰리면 백엔드가 503 login_busy(JSON)를 내고 그대로 통과한다.

import { forwardLoginStep } from "@/lib/auth/login-bff"

export async function POST(request: Request) {
  return forwardLoginStep(request, "/api/auth/login/start")
}
