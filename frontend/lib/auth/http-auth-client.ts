// F-AU-001 인증 경계의 HTTP 구현 — 실연동(BE #19~#22) 시 mock-auth-client를 대신한다.
// 브라우저 → Next BFF route handler(/api/auth/*) → FastAPI 의 2-hop(ADR-0001 경계): client
// component는 FastAPI에 직접 붙지 않고 같은 출처의 BFF만 호출한다. BFF가 서버 env로 FastAPI를 가린다.
//
// HTTP JSON은 snake_case, 이 seam은 camelCase — 매핑은 이 어댑터가 전담한다(계약 §FE seam).
// deeplink는 BFF가 이미 DeeplinkCheck 형상으로 매핑해 주므로 그대로 통과시킨다.

import type {
  AuthClient,
  AuthRequestOptions,
  CompleteLoginInput,
  CompleteLoginResult,
  ConsentDocument,
  DeeplinkCheck,
  LoginGate,
  StartLoginInput,
  StartLoginResult,
} from "./auth-types"
import { LoginRequestError, loginErrorCode } from "./login-errors"

// FastAPI gate(snake) → seam gate(camel).
function toGate(gate: { application_status: LoginGate["applicationStatus"]; has_profile: boolean }): LoginGate {
  return { applicationStatus: gate.application_status, hasProfile: gate.has_profile }
}

// signal을 끊으면 브라우저가 요청 자체를 취소한다 — 뒤늦은 응답의 Set-Cookie(세션)가 적용되지 않고, BFF도 끊긴 걸
// 알고 백엔드 호출을 끊는다(lib/auth/login-bff). 끊긴 요청은 fetch의 AbortError로 끝난다(LoginRequestError 아님).
async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  // BFF는 비즈니스 결과도 200으로 내려준다(계약). 비정상(503 login_busy·5xx 등)은 상태와 detail.code를 실은
  // LoginRequestError로 드러낸다 — 화면(login-flow)이 받아 종류별로 안내한다(lib/auth/login-errors).
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null)
    throw new LoginRequestError(path, res.status, loginErrorCode(errorBody))
  }
  return (await res.json()) as T
}

export const httpAuthClient: AuthClient = {
  async checkDeeplinkToken(token: string): Promise<DeeplinkCheck> {
    // BFF가 200 context→valid / 401 reason→expired|invalid 로 이미 매핑해 DeeplinkCheck를 돌려준다.
    return postJson<DeeplinkCheck>("/api/auth/deeplink", { token })
  },

  async startLogin(
    { username, password, deeplinkToken }: StartLoginInput,
    options?: AuthRequestOptions,
  ): Promise<StartLoginResult> {
    const data = await postJson<StartLoginSnake>(
      "/api/auth/login/start",
      { username, password, deeplink_token: deeplinkToken ?? null },
      options?.signal,
    )
    switch (data.outcome) {
      case "rejected":
        return { outcome: "rejected", reason: data.reason }
      case "not_found":
        return { outcome: "not_found" }
      case "succeeded":
        return { outcome: "succeeded", role: data.role, gate: toGate(data.gate) }
      case "consent_required":
        return { outcome: "consent_required", loginTicket: data.login_ticket, documents: data.documents }
    }
  },

  async completeLogin({ loginTicket, acceptedDocIds }: CompleteLoginInput): Promise<CompleteLoginResult> {
    const data = await postJson<CompleteLoginSnake>("/api/auth/login/complete", {
      login_ticket: loginTicket,
      accepted_doc_ids: acceptedDocIds,
    })
    switch (data.outcome) {
      case "succeeded":
        return { outcome: "succeeded", role: data.role, gate: toGate(data.gate) }
      case "consent_incomplete":
        return { outcome: "consent_incomplete", missingRequired: data.missing_required }
      case "ticket_invalid":
        return { outcome: "ticket_invalid", reason: data.reason }
    }
  },
}

// ── FastAPI 응답 형상(snake_case) ────────────────────────────────────────────────
type GateSnake = { application_status: LoginGate["applicationStatus"]; has_profile: boolean }

type StartLoginSnake =
  | { outcome: "rejected"; reason: "invalid_credentials" | "account_locked" | "upstream_unavailable" }
  | { outcome: "not_found" }
  | { outcome: "succeeded"; role: StartSucceededRole; gate: GateSnake; route: string; roles: string[] }
  | { outcome: "consent_required"; login_ticket: string; documents: ConsentDocument[] }

type CompleteLoginSnake =
  | { outcome: "succeeded"; role: StartSucceededRole; gate: GateSnake; route: string; roles: string[] }
  | { outcome: "consent_incomplete"; missing_required: string[] }
  | { outcome: "ticket_invalid"; reason: "expired" | "consumed" | "forged" }

// HTTP 경로 역할 — 참가자(buyer/exhibitor) + 데모 전용 운영사(organizer, 정식 D5 경로는 별도 예정).
type StartSucceededRole = "buyer" | "exhibitor" | "organizer"
