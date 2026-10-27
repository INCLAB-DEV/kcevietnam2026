// 로그인 요청(start·complete) 실패의 공용 표현 — 클라 안전(순수) 모듈.
//
// 왜 필요한가(2026-10-02 부하 테스트, 첫 로그인 100명 동시): 백엔드가 평문 500("Internal Server Error")을 내자
// BFF가 그걸 JSON으로 읽다 SyntaxError로 같이 터졌고, http 어댑터는 상태 코드만 담은 Error를 던졌으며, 로그인
// 화면은 그 예외를 받지 않아 버튼이 계속 도는 채로 멈췄다. 이제 BFF는 어떤 실패든 JSON 오류(detail.code)와 상태
// 코드로 돌려주고(lib/auth/login-bff), http 어댑터는 그걸 이 에러로 던지며, 로그인 화면이 종류별 안내로 바꾼다.
//
// 비즈니스 결과(rejected·not_found·consent_required·ticket_invalid 등)는 여기 오지 않는다 — 그건 200 결과다(계약).

export class LoginRequestError extends Error {
  readonly status: number
  readonly code: string | null

  // message는 로그용 설명(경로·상태·코드) — 화면 문구는 loginFailureKind로 고른다.
  constructor(path: string, status: number, code: string | null) {
    super(`auth request failed: ${path} (${status}${code ? ` ${code}` : ""})`)
    this.name = "LoginRequestError"
    this.status = status
    this.code = code
  }
}

// FastAPI·BFF 오류 바디({detail: {code, message}})에서 code를 꺼낸다. 형식 밖(문자열 detail·검증 배열 등)이면 null.
export function loginErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const detail = (body as { detail?: unknown }).detail
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null
  const code = (detail as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

export type LoginFailureKind = "busy" | "unavailable"

// 서버가 "지금 몰려 있다"고 직접 밝힌 코드 — 백엔드 비밀번호 대조 자리(로그인 login_busy·그 밖 server_busy).
const BUSY_CODES: ReadonlySet<string> = new Set(["login_busy", "server_busy"])

// 화면 문구 종류(2026-10-03 교차리뷰 LOW — "요청이 많아요"는 서버가 몰림을 밝혔을 때만).
//  - busy        : 503, 또는 코드가 login_busy·server_busy — 잠시 뒤 같은 요청을 다시 보내면 되는 몰림이라
//                  "로그인 요청이 많아요".
//  - unavailable : 그 밖의 전부 — 다른 5xx(평문 500을 BFF가 바꾼 upstream_error·BFF가 백엔드에 닿지 못한 502
//                  upstream_unavailable 포함), 예상 밖 4xx, 응답을 아예 못 받은 네트워크 단절. 몰림인지 장애인지
//                  알 수 없으니 기존 "인증 서버가 일시적으로 응답하지 않습니다" 안내를 쓴다.
export function loginFailureKind(error: unknown): LoginFailureKind {
  if (error instanceof LoginRequestError && (error.status === 503 || (error.code !== null && BUSY_CODES.has(error.code)))) {
    return "busy"
  }
  return "unavailable"
}
