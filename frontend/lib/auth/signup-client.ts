// 자체 회원가입 — FE↔백엔드 경계(seam) 계약. 로그인(AuthClient, ADR-0008 경계 B)과 같은 스왑 패턴:
// mock 구현이 기본(데모/테스트), NEXT_PUBLIC_AUTH_CLIENT="http" 시 BFF 경유 HTTP 구현으로 스왑한다
// (화면 코드 불변). 가입 가능한 역할은 바이어/참가사 둘뿐 — 운영자 계열은 이 경로로 만들 수 없다
// (슈퍼어드민 등은 DB에서만 부여, F-AU 가입 요구사항).
//
// HTTP 계약: POST /api/auth/signup { email, password, name, phone?, org_name_ko, org_name_en?,
// role: "buyer"|"exhibitor", event_id?, email_verification_token } → 201 성공(내부 id 미노출) /
// 409 이메일 중복 / 422 검증 실패 / 403 인증 토큰 위조·만료·소진·이메일 불일치.
// HTTP JSON은 snake_case, 이 seam은 camelCase — 매핑은 httpSignupClient가 전담(auth-types와 동형 규칙).
//
// 이메일 실존 인증(#9, 발주자 정정 2026-09-15 "가입 중 코드 확인"): 가입 전에 POST
// /api/auth/signup/email-code(발송) → POST /api/auth/signup/email-code/verify(확인)를 거쳐
// verification_token을 받아야 signup()이 성공한다. 토큰 없이 signup()을 부르면 백엔드가 422/403으로
// 거부하므로, signup-form.tsx는 이 토큰을 손에 넣기 전까지 제출 버튼을 비활성 상태로 둔다.

export type SignupRole = "buyer" | "exhibitor"

export interface SignupInput {
  email: string
  password: string
  name: string
  phone?: string
  orgNameKo: string
  orgNameEn?: string
  role: SignupRole
  eventId?: string
  emailVerificationToken: string
}

// succeeded            : 201 — 계정 생성 완료(내부 id는 응답에 노출되지 않는다).
// email_taken          : 409 — 이미 가입된 이메일.
// validation_error     : 422 — 필드별 인라인 에러로 매핑해 폼에 되돌린다.
// verification_invalid : 403 — 인증 토큰 위조·만료·소진, 또는 가입 이메일과 불일치.
export type SignupResult =
  | { outcome: "succeeded" }
  | { outcome: "email_taken" }
  | { outcome: "validation_error"; fieldErrors: Partial<Record<keyof SignupInput, string>> }
  | { outcome: "verification_invalid" }

// sent          : 200 — 실제로 발송됨(회원 존재 여부는 노출하지 않는다, enumeration 방지).
// rate_limited  : 429 — 60초 재발송 쿨다운 또는 시간당 5회 상한 초과.
// invalid_email : 422 — 이메일 형식 오류.
export type EmailCodeRequestResult =
  | { outcome: "sent" }
  | { outcome: "rate_limited" }
  | { outcome: "invalid_email" }

// verified      : 200 — 코드 일치. token은 signup()의 emailVerificationToken에 실어 보낸다.
// invalid_code  : 422 — 불일치·만료·소진(5회 초과 포함)·미발송.
export type EmailCodeVerifyResult =
  | { outcome: "verified"; token: string }
  | { outcome: "invalid_code" }

export interface SignupClient {
  signup(input: SignupInput): Promise<SignupResult>
  requestEmailCode(email: string): Promise<EmailCodeRequestResult>
  verifyEmailCode(email: string, code: string): Promise<EmailCodeVerifyResult>
}

// ── mock ──────────────────────────────────────────────────────────────────────
// 6/17 데모·테스트 기본 구현. 성공·409(이메일 중복) 시나리오만 시뮬레이션한다 — 422는 RHF+zod가
// 제출 전에 이미 걸러내므로(client-side validation) mock이 흉내낼 필요가 없다(login mock과 동일 원칙).
export const DUPLICATE_EMAIL_SENTINEL = "taken@nabi.demo"

// 데모용 고정 코드 — 메일함이 없는 mock 환경에서 화면을 그대로 통과시킨다. 다른 6자리 값은
// 전부 invalid_code로 흉내낸다(422 시나리오를 폼에서 눈으로 확인할 수 있도록).
export const MOCK_VERIFICATION_CODE = "123456"
const MOCK_VERIFICATION_TOKEN = "mock-email-verification-token"

export const mockSignupClient: SignupClient = {
  async signup(input: SignupInput): Promise<SignupResult> {
    if (input.email.trim().toLowerCase() === DUPLICATE_EMAIL_SENTINEL) {
      return { outcome: "email_taken" }
    }
    if (!input.emailVerificationToken) {
      return { outcome: "verification_invalid" }
    }
    return { outcome: "succeeded" }
  },

  async requestEmailCode(): Promise<EmailCodeRequestResult> {
    return { outcome: "sent" }
  },

  async verifyEmailCode(_email: string, code: string): Promise<EmailCodeVerifyResult> {
    if (code === MOCK_VERIFICATION_CODE) {
      return { outcome: "verified", token: MOCK_VERIFICATION_TOKEN }
    }
    return { outcome: "invalid_code" }
  },
}

// ── http ──────────────────────────────────────────────────────────────────────
function toSnakeBody(input: SignupInput) {
  return {
    email: input.email,
    password: input.password,
    name: input.name,
    phone: input.phone || undefined,
    org_name_ko: input.orgNameKo,
    org_name_en: input.orgNameEn || undefined,
    role: input.role,
    event_id: input.eventId || undefined,
    email_verification_token: input.emailVerificationToken,
  }
}

// FastAPI(pydantic) 표준 422 형태({"detail":[{"loc":["body","email"],"msg":"...","type":"..."}]})를
// 필드별 메시지로 변환한다. loc 마지막 세그먼트(snake_case)를 seam 필드명(camelCase)으로 매핑.
const SNAKE_TO_CAMEL: Record<string, keyof SignupInput> = {
  email: "email",
  password: "password",
  name: "name",
  phone: "phone",
  org_name_ko: "orgNameKo",
  org_name_en: "orgNameEn",
  role: "role",
  event_id: "eventId",
  email_verification_token: "emailVerificationToken",
}

function mapValidationErrors(body: unknown): Partial<Record<keyof SignupInput, string>> {
  const errors: Partial<Record<keyof SignupInput, string>> = {}
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!Array.isArray(detail)) return errors
  for (const issue of detail) {
    const loc = (issue as { loc?: unknown })?.loc
    const msg = (issue as { msg?: unknown })?.msg
    const lastSeg = Array.isArray(loc) ? loc[loc.length - 1] : undefined
    const field = typeof lastSeg === "string" ? SNAKE_TO_CAMEL[lastSeg] : undefined
    if (field && typeof msg === "string") errors[field] = msg
  }
  return errors
}

// 브라우저 → 이 client → 같은 출처 BFF(app/api/auth/signup/route.ts) → FastAPI(ADR-0001 경계).
export const httpSignupClient: SignupClient = {
  async signup(input: SignupInput): Promise<SignupResult> {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toSnakeBody(input)),
    })
    if (res.status === 201) return { outcome: "succeeded" }
    if (res.status === 409) return { outcome: "email_taken" }
    if (res.status === 403) return { outcome: "verification_invalid" }
    if (res.status === 422) {
      const data = await res.json().catch(() => null)
      return { outcome: "validation_error", fieldErrors: mapValidationErrors(data) }
    }
    throw new Error(`signup request failed (${res.status})`)
  },

  async requestEmailCode(email: string): Promise<EmailCodeRequestResult> {
    const res = await fetch("/api/auth/signup/email-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
    if (res.status === 200) return { outcome: "sent" }
    if (res.status === 429) return { outcome: "rate_limited" }
    if (res.status === 422) return { outcome: "invalid_email" }
    throw new Error(`email code request failed (${res.status})`)
  },

  async verifyEmailCode(email: string, code: string): Promise<EmailCodeVerifyResult> {
    const res = await fetch("/api/auth/signup/email-code/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    })
    if (res.status === 200) {
      const data = await res.json().catch(() => null)
      const token = (data as { verification_token?: string } | null)?.verification_token
      if (!token) throw new Error("email code verify response missing verification_token")
      return { outcome: "verified", token }
    }
    if (res.status === 422) return { outcome: "invalid_code" }
    throw new Error(`email code verify failed (${res.status})`)
  },
}

// ── resolver ──────────────────────────────────────────────────────────────────
// auth-client.ts와 동일한 env 스위치(NEXT_PUBLIC_AUTH_CLIENT)를 공유한다.
export function resolveSignupClient(): SignupClient {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http" ? httpSignupClient : mockSignupClient
}

// 기본 주입용 단일 인스턴스 — signup-form.tsx의 client 기본값.
export const defaultSignupClient: SignupClient = resolveSignupClient()
