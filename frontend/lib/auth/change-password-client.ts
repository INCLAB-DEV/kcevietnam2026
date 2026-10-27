// 셀프 비밀번호 변경 — FE↔백엔드 경계(seam) 계약. 로그인(AuthClient)·자체가입(SignupClient)과 같은
// 스왑 패턴: mock 구현이 기본(데모/테스트), NEXT_PUBLIC_AUTH_CLIENT="http" 시 BFF 경유 HTTP 구현으로
// 스왑한다(화면 코드 불변). 명단 업로드로 공통 비밀번호가 일괄 부여된 계정이 자기 비밀번호를 직접
// 바꾸는 경로다(발주자 요구사항 2026-09-30).
//
// HTTP 계약: POST /api/me/change-password { current_password, new_password }
//   200 { ok: true }                                  → succeeded
//   403 { detail: { code: "INVALID_CREDENTIALS" } }    → invalid_current (현재 비밀번호 불일치)
//   409 { detail: { code: "NO_LOCAL_PASSWORD" } }      → no_local_password (비밀번호 로그인 계정 아님)
//   422 { detail: { code: "PASSWORD_POLICY" } }        → policy_violation
//   422 { detail: { code: "SAME_PASSWORD" } }          → same_password
//   401 (세션 없음/위조)                                → unauthenticated
// HTTP JSON은 snake_case, 이 seam은 camelCase — 매핑은 httpChangePasswordClient가 전담(signup-client와 동형).
//
// ⚠ 서버 message를 그대로 실어 나른다 — 정책 문구("최소 8자, 영문+숫자")의 정본은 백엔드
// (app/auth/credentials.py)이고, 한국어 화면은 그 문구를 보여줘야 사용자가 무엇을 고쳐야 할지 안다.
// 다만 그 문구는 한국어다 — 화면(change-password-dialog.tsx)은 ko 로케일에서만 그대로 쓰고, en에서는
// outcome에 대응하는 번역 문구(messages의 changePassword.error*)를 쓴다. 서버가 문구를 싣지 않았거나
// (계약 밖 응답·네트워크 단절) 목업이면 message는 null이고, 화면이 로케일 문구로 채운다 — 이 모듈은
// 문장을 직접 만들지 않는다.
// 평문 비밀번호는 이 모듈 밖으로 나가지 않는다(로깅·에러 메시지에 싣지 않는다).

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

// succeeded         : 200 — 해시 교체 완료. 다음 로그인부터 새 비밀번호가 유효하다.
// invalid_current   : 403 — 현재 비밀번호 불일치(어느 필드가 왜 틀렸는지 이상은 서버도 알려주지 않는다).
// same_password     : 422 — 새 비밀번호가 기존과 동일.
// policy_violation  : 422 — 정책 위반. message가 정책 문구다.
// no_local_password : 409 — 로컬 비밀번호로 로그인하지 않는 계정(DX Korea 검증 대상).
// unauthenticated   : 401 — 세션 없음/만료. 화면은 안내만 하고 강제 이동은 하지 않는다.
// error             : 그 외(네트워크·파싱 실패·예상 밖 상태코드) 폴백.
// message는 서버가 준 한국어 문구(없으면 null) — 화면이 로케일에 따라 쓸지 말지를 정한다(위 주석).
export type ChangePasswordResult =
  | { outcome: "succeeded" }
  | { outcome: "invalid_current"; message: string | null }
  | { outcome: "same_password"; message: string | null }
  | { outcome: "policy_violation"; message: string | null }
  | { outcome: "no_local_password"; message: string | null }
  | { outcome: "unauthenticated" }
  | { outcome: "error"; message: string | null }

export interface ChangePasswordClient {
  changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult>
}

// ── mock ──────────────────────────────────────────────────────────────────────
// 데모·테스트 기본 구현. 성공 + "현재 비밀번호 불일치" 하나만 시뮬레이션한다 — 정책 위반·확인 불일치는
// 폼(zod)이 제출 전에 이미 걸러내므로 mock이 흉내낼 필요가 없다(signup mock과 동일 원칙).
export const MOCK_CURRENT_PASSWORD = "NabiDemo2026"

export const mockChangePasswordClient: ChangePasswordClient = {
  async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    if (input.currentPassword !== MOCK_CURRENT_PASSWORD) {
      // 서버 문구가 없는 목업 — 화면이 로케일 문구(changePassword.errorInvalidCurrent)로 채운다.
      return { outcome: "invalid_current", message: null }
    }
    return { outcome: "succeeded" }
  },
}

// ── http ──────────────────────────────────────────────────────────────────────

// 백엔드 에러 바디({"detail":{"code","message"}})에서 code/message를 꺼낸다. 계약 밖 바디면 빈 값.
function parseDetail(body: unknown): { code: string | null; message: string | null } {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail !== "object" || detail === null) return { code: null, message: null }
  const record = detail as { code?: unknown; message?: unknown }
  return {
    code: typeof record.code === "string" ? record.code : null,
    message: typeof record.message === "string" ? record.message : null,
  }
}

// code → outcome. 상태코드가 아니라 code로 가른다 — 422 하나에 두 outcome(정책 위반·기존과 동일)이
// 걸려 있어 상태코드만으로는 구분할 수 없다.
function outcomeOf(code: string | null, message: string | null): ChangePasswordResult {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return { outcome: "invalid_current", message }
    case "SAME_PASSWORD":
      return { outcome: "same_password", message }
    case "PASSWORD_POLICY":
      return { outcome: "policy_violation", message }
    case "NO_LOCAL_PASSWORD":
      return { outcome: "no_local_password", message }
    default:
      return { outcome: "error", message }
  }
}

// 브라우저 → 이 client → 같은 출처 BFF(app/api/me/change-password/route.ts) → FastAPI(ADR-0008 경계 B).
export const httpChangePasswordClient: ChangePasswordClient = {
  async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    let res: Response
    try {
      res = await fetch("/api/me/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          current_password: input.currentPassword,
          new_password: input.newPassword,
        }),
      })
    } catch {
      // 네트워크 단절 — 서버가 받았는지 알 수 없으므로 성공으로 넘기지 않는다.
      return { outcome: "error", message: null }
    }

    if (res.status === 200) return { outcome: "succeeded" }
    if (res.status === 401) return { outcome: "unauthenticated" }

    const body = await res.json().catch(() => null)
    const { code, message } = parseDetail(body)
    return outcomeOf(code, message)
  },
}

// ── resolver ──────────────────────────────────────────────────────────────────
// auth-client.ts·signup-client.ts와 동일한 env 스위치(NEXT_PUBLIC_AUTH_CLIENT)를 공유한다.
export function resolveChangePasswordClient(): ChangePasswordClient {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http"
    ? httpChangePasswordClient
    : mockChangePasswordClient
}

// 기본 주입용 단일 인스턴스 — change-password-dialog.tsx의 client 기본값.
export const defaultChangePasswordClient: ChangePasswordClient = resolveChangePasswordClient()
