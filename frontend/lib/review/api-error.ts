// 리뷰 API 실패를 화면 문구로 가르기 위한 오류 타입 — HTTP 상태와 백엔드 detail.code(ai_busy·ai_failed·
// audio_too_large)를 그대로 들고 다닌다. 예전엔 "API 503: …" 문자열만 던져 화면이 실패 종류를 구분할 수
// 없었다(텍스트 정리 실패는 아예 아무것도 안 띄웠다). 메시지 형식은 그대로 둬 기존 로그·표시와 같다.

export class ReviewApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, body: string) {
    super(`API ${status}: ${body}`)
    this.name = "ReviewApiError"
    this.status = status
    this.code = code
  }
}

// FastAPI 오류 바디에서 detail.code 를 꺼낸다 — {detail: {code, message}} 형태만 코드가 있다.
// 문자열 detail·JSON 아님은 null(=종류 모름, 상태 코드로만 판단).
export function detailCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    const detail = parsed.detail
    if (detail && typeof detail === "object" && "code" in detail) {
      const code = (detail as { code: unknown }).code
      return typeof code === "string" ? code : null
    }
  } catch {
    // JSON이 아니면 코드 없음.
  }
  return null
}

// 러브콜 메일 발송 거절 코드 — 이 미팅 행사의 메일 스위치(운영 콘솔 "참가사·바이어 알림 메일")가 꺼져 있다(409).
// 백엔드 backend/app/api/love_call.py와 같은 값이다(알림 재발송 409와 같은 코드).
export const PARTICIPANT_EMAIL_DISABLED = "PARTICIPANT_EMAIL_DISABLED"

// 러브콜 메일 API 실패 — message는 화면에 그대로 띄울 문구(백엔드가 요청 로케일로 고른 고정 문구)이고, 종류는
// code(detail.code — 문자열 detail이면 null)로 가른다. ReviewApiError와 달리 메시지를 "API 409: {…}"로 감싸지 않는다
// — 러브콜 화면은 예전부터 e.message를 그대로 보여 준다.
export class LoveCallMailApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = "LoveCallMailApiError"
    this.status = status
    this.code = code
  }
}

// 행사 메일 스위치가 꺼져 발송이 거절됐는가 — 화면은 이때 '발송하기'를 잠그고 '보냄'으로 넘어가지 않는다.
export function isParticipantEmailDisabled(error: unknown): boolean {
  return error instanceof LoveCallMailApiError && error.code === PARTICIPANT_EMAIL_DISABLED
}

export type ReviewFailureKind = "aiBusy" | "audioTooLarge" | "other"

// 화면이 띄울 문구 종류. 코드가 우선이고, 코드가 없으면(프록시가 낸 413/503 등) 상태 코드로 판단한다.
export function reviewFailureKind(error: unknown): ReviewFailureKind {
  if (!(error instanceof ReviewApiError)) return "other"
  if (error.code === "audio_too_large" || error.status === 413) return "audioTooLarge"
  if (error.code === "ai_busy" || error.status === 503) return "aiBusy"
  return "other"
}
