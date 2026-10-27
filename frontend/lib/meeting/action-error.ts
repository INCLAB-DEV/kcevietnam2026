// 미팅 뮤테이션(신청·수락·거절·취소) 실패 → 화면 문구.
//
// 백엔드(app/meetings/router.py)는 실패마다 `{code, message}`를 준다. message는 한국어 문장이라
// 그대로 띄우면 EN 화면에 한국어 토스트가 뜬다 — 그래서 로케일에 따라 원천을 가른다:
//   • ko : 백엔드 message를 그대로 쓴다. 날짜·슬롯 같은 구체 정보가 들어 있고("미팅 신청은
//          2026-10-02부터 가능합니다."), 한국어 사용자가 보던 문구가 바뀌지 않는다.
//   • en : code를 messages의 meeting.errors.{code}로 옮긴다(아는 코드만). 모르는 코드·코드 없는
//          실패(프록시 오류 등)는 호출부가 준 일반 실패 문구로 떨어진다.
// ko.json에도 같은 키가 있는 건 카탈로그 키 무결성(ko/en 동일 키 집합) 때문이고, 백엔드가 message를
// 싣지 않은 드문 경우의 폴백으로도 쓰인다.

import type { Locale } from "@/lib/i18n/config"
import type { MeetingActionResult } from "./meeting-actions"
import type { Translator } from "./meeting-projection"

// 백엔드 미팅 라우터의 에러 코드 목록(app/meetings/router.py 모듈 docstring) + BFF가 내는 NO_SESSION.
// 백엔드에 코드가 추가되면 여기와 messages의 meeting.errors에 함께 추가한다 — 빠뜨려도 화면이 깨지진
// 않고 일반 실패 문구로 떨어진다(action-error.test.ts가 카탈로그 쪽 누락을 잡는다).
export const MEETING_ERROR_CODES = [
  "EVENT_AMBIGUOUS",
  "ROLE_AMBIGUOUS",
  "PROFILE_NOT_APPROVED",
  "NOT_VISIBLE",
  "APPLICATION_WINDOW_CLOSED",
  "NOT_PARTICIPANT",
  "NOT_AWAITING_PARTY",
  "NOT_CANCELLABLE_PARTY",
  "VENUE_TYPE_DISABLED",
  "SLOT_INVALID",
  "REASON_REQUIRED",
  "MEMBER_NOT_IN_ORG",
  "SLOT_TAKEN",
  "DUPLICATE_APPLICATION",
  "VENUE_TAKEN",
  "INVALID_TRANSITION",
  "EVENT_SCHEDULE_UNSET",
  "NOT_FOUND",
  "NO_SESSION",
] as const

export type MeetingErrorCode = (typeof MEETING_ERROR_CODES)[number]

function isKnownCode(code: string | undefined): code is MeetingErrorCode {
  return code !== undefined && (MEETING_ERROR_CODES as readonly string[]).includes(code)
}

// BFF(Next 라우트 핸들러)가 직접 낸 코드 — 이 응답의 message는 한국어 사용자 문구가 아니라 로그용 영문
// 설명이다(lib/auth/no-session-response.ts). ko 화면에서도 그 message를 그대로 쓰지 않고 카탈로그로 간다.
const BFF_ORIGINATED_CODES: ReadonlySet<string> = new Set(["NO_SESSION"])

/**
 * 실패한 뮤테이션 결과를 화면 로케일의 문구로 바꾼다.
 * @param t "meeting.errors" 네임스페이스 번역기
 * @param fallback 코드도 문구도 쓸 수 없을 때의 일반 실패 문구(호출부가 액션별로 고른다)
 */
export function meetingActionErrorMessage(
  result: MeetingActionResult,
  locale: Locale,
  t: Translator,
  fallback: string,
): string {
  const fromBackend = !BFF_ORIGINATED_CODES.has(result.errorCode ?? "")
  if (locale === "ko" && result.message && fromBackend) return result.message
  if (isKnownCode(result.errorCode)) return t(result.errorCode)
  return fallback
}
