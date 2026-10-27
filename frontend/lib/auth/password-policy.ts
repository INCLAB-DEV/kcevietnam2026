// 비밀번호 정책 — 백엔드 정본(backend/app/auth/credentials.py check_password_policy)과 같은 규칙의
// 화면용 사본이다. 최소 8자 + 영문 + 숫자 포함(그 외 문자 제한 없음). 최종 판정은 서버가 하고, 여기는
// 입력 즉시 안내·제출 차단용이다. 자체 회원가입 폼(components/auth/signup-form.tsx)과 명단 업로드의
// 공통 비밀번호(components/roster/roster-upload.tsx)가 같이 쓴다 — 두 화면의 규칙이 갈라지지 않게.

export const PASSWORD_MIN_LENGTH = 8

// bcrypt 72바이트 상한 — backend/app/auth/credentials.py PASSWORD_MAX_BYTES과 같은 값이다.
// 이걸 넘기면 서버가 (500이 아니라) 422로 거부한다. UTF-8은 한글·이모지가 문자당 여러 바이트라
// value.length(문자 수)가 아니라 인코딩된 바이트 길이로 재야 한다.
export const PASSWORD_MAX_BYTES = 72

export const PASSWORD_POLICY = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/

function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function exceedsPasswordByteLimit(value: string): boolean {
  return passwordByteLength(value) > PASSWORD_MAX_BYTES
}

export function isValidPassword(value: string): boolean {
  return PASSWORD_POLICY.test(value) && !exceedsPasswordByteLimit(value)
}
