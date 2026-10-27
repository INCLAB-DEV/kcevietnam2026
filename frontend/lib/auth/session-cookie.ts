// 로그인 세션 쿠키 — BFF route handler 전용 공용 규약(브라우저 JS에 노출하지 않는다).
//
// FastAPI 로그인 트랜잭션(/api/auth/login/start·complete)이 성공 응답에 실어주는 access_token을
// BFF가 httpOnly 쿠키로 보관한다. 이후 인증이 필요한 같은 출처 요청(어드민 콘솔 BFF 프록시 등)은
// 서버 측에서 이 쿠키를 읽어 `Authorization: Bearer` 로 FastAPI에 전달한다 — 클라이언트 JS는
// 토큰을 만지지 않는다(ADR-0001/0008 경계 B, XSS 노출면 최소화).
//
// 데모 토큰은 백엔드 프로세스 수명 동안만 유효(인메모리 유저풀) — 백엔드 재시작 시 재로그인 필요.

export const SESSION_COOKIE = "nabi_session"

// role은 access_token과 같은 로그인 응답 바디에 실려 오지만(토큰 자체엔 역할이 없다 — 데모 토큰은
// "access-{subject}-{seq}" 형식일 뿐), FastAPI에 다시 물어볼 "/me" 류 엔드포인트가 아직 없어 FE가
// 이후 요청에서 역할을 알 방법이 없다. 그래서 토큰과 나란히 별도 httpOnly 쿠키로 함께 심는다 —
// 미팅 화면처럼 "지금 로그인한 게 바이어인지 참가사인지"가 화면 분기에 필요한 곳에서 읽는다.
export const ROLE_COOKIE = "nabi_session_role"

// 로그인 완료 직후 BFF가 FastAPI GET /api/me를 호출해 함께 심는 쿠키 2종(P1-1 부트스트랩).
// org: organization_id(UUID) — 미팅 목록 역산(deriveViewerOrgId) 없이 "내 org"를 바로 안다.
// status: 첫 event role의 application_status — route-guard 합성 게이트가 읽는다(proxy.ts).
// /api/me 실패 시(엔드포인트 미가동 등) org는 비워두고 status만 로그인 응답의 gate로 폴백한다
// (lib/auth/real-session.ts·app/api/auth/login/complete/route.ts 참고).
export const ORG_COOKIE = "nabi_session_org"
export const STATUS_COOKIE = "nabi_session_status"
// 파생 쿠키 재동기화를 이미 한 번 시도했다는 표식(app/api/auth/refresh) — 갱신이 실패해도
// /welcome이 무한히 재시도하지 않게 하는 짧은 수명의 안전장치다.
export const REFRESHED_COOKIE = "nabi_status_refreshed"

// 7일 — 데모 세션치고 넉넉하되 영구이지 않게. 백엔드 재시작 시 토큰은 자연 만료 취급된다.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: MAX_AGE_SECONDS,
  // prod 배포 차단 P0: HTTPS에서만 전송되도록 강제. 로컬 http 개발은 secure=false로 유지해야
  // 브라우저가 쿠키를 심어준다. 로그아웃 라우트(app/api/auth/logout/route.ts)도 이 옵션을 그대로
  // 재사용해 삭제 Set-Cookie를 만들므로(대칭 옵션이어야 삭제가 먹는다), 여기 한 곳만 고치면 된다.
  // NABI_COOKIE_SECURE=false 는 HTTP ALB 데모 배포용 탈출구 — HTTPS(ACM 인증서) 적용 전까지
  // NODE_ENV=production이어도 secure를 강제로 끈다. 그 외에는 기존 NODE_ENV 기준 그대로.
  secure: process.env.NABI_COOKIE_SECURE === "false" ? false : process.env.NODE_ENV === "production",
} as const

// 로그인 성공 응답 body에서 access_token을 추출한다 — 없으면(계약 밖 응답) null.
export function extractAccessToken(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as { outcome?: unknown; access_token?: unknown }
  if (record.outcome !== "succeeded") return null
  return typeof record.access_token === "string" ? record.access_token : null
}

// 로그인 응답의 role → ROLE_COOKIE에 심을 값. buyer/exhibitor(참가자, F-MY-001)에 더해
// organizer도 포함한다 — route-guard(/organizer, /admin)가 이 쿠키를 읽어 통과시킨다
// (lib/auth/real-session.ts). 계약 밖 값이면 null — 호출부가 쿠키를 심지 않고 폴백한다.
//
// 보안 참고: organizer의 프로덕션 실인증(D5, cognito 경로)은 아직 없다 — 이 role이 organizer로
// 나오는 경로는 현재 데모 로그인(AUTH_BACKEND=demo)뿐이라, 이 변경은 실질적으로 데모 운영자
// 로그인을 라우트 가드에 연결하는 것이다(prod 구멍 아님).
export function extractRole(data: unknown): "buyer" | "exhibitor" | "organizer" | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as { outcome?: unknown; role?: unknown }
  if (record.outcome !== "succeeded") return null
  return record.role === "buyer" || record.role === "exhibitor" || record.role === "organizer"
    ? record.role
    : null
}
