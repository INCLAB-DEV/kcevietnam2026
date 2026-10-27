// 운영자 콘솔(/organizer·/admin) 서버 읽기 실패의 공용 표현 — 클라 안전(순수) 모듈.
//
// 왜 필요한가(2026-09-17 서브 운영자 오류 화면 결함): 서버 컴포넌트의 읽기 어댑터가 FastAPI 403을
// 받으면 평범한 Error를 던졌고, 운영자 라우트엔 error.tsx도 없어 sub 운영자가 로그인 직후 사이드바·
// 로그아웃도 없는 서버 오류 화면을 봤다. 이제 읽기 어댑터는 이 에러를 던지고, 콘솔 크롬 안의
// error.tsx가 403/404를 사람이 읽는 안내로 바꾼다.
//
// ⚠ 프로덕션에서 서버 컴포넌트 에러는 message가 가려진 채 클라로 넘어온다(Next error.js 문서) — 그래서
//   상태를 message가 아니라 **digest**로 싣는다. Next는 이미 digest가 있는 에러의 digest를 그대로
//   존중해 클라에 전달한다(next/dist/server/app-render/create-error-handler). digest에는 상태 코드만
//   담는다(경로·토큰 등 민감 정보 금지).

export const OPERATOR_FORBIDDEN_DIGEST = "NABI_OPERATOR_HTTP_403"
export const OPERATOR_NOT_FOUND_DIGEST = "NABI_OPERATOR_HTTP_404"

export type OperatorErrorKind = "forbidden" | "not_found" | "unknown"

export class OperatorHttpError extends Error {
  readonly status: number
  readonly digest?: string

  // message: 서버 로그용 설명(호출 경로·백엔드 에러 코드). 클라엔 digest만 의미가 있다.
  constructor(status: number, message: string) {
    super(message)
    this.name = "OperatorHttpError"
    this.status = status
    if (status === 403) this.digest = OPERATOR_FORBIDDEN_DIGEST
    else if (status === 404) this.digest = OPERATOR_NOT_FOUND_DIGEST
  }
}

// error.tsx가 받은 에러(프로덕션에선 digest만 믿을 수 있다) 또는 서버에서 직접 잡은 에러 → 종류.
export function operatorErrorKind(error: unknown): OperatorErrorKind {
  if (error instanceof OperatorHttpError) {
    if (error.status === 403) return "forbidden"
    if (error.status === 404) return "not_found"
    return "unknown"
  }
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? (error as { digest?: unknown }).digest
      : undefined
  if (digest === OPERATOR_FORBIDDEN_DIGEST) return "forbidden"
  if (digest === OPERATOR_NOT_FOUND_DIGEST) return "not_found"
  return "unknown"
}
