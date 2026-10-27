// 리뷰 클라이언트 선택 — realSession(실 로그인 세션)이면 실 백엔드(FastAPI, /api/reviews BFF 경유),
// 아니면 인메모리 mock. mock 모드 보존 원칙: 호출부가 인자 없이 부르면 항상 mock. 실세션 판정은
// 서버 컴포넌트(app/meetings/[meetingId]/page.tsx)가 resolveHttpSession()으로 내려 ReviewFlow에
// prop으로 전달한다. (exhibitor-client.ts 의 getExhibitorClient 와 같은 seam 패턴.)

import type { ReviewClient } from "./types"
import { mockReviewClient } from "./mock-review-client"
import { createHttpReviewClient } from "./http-review-client"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"

// locale — 백엔드가 문장을 만들어 주는 호출(러브콜 메일·보고서 내보내기)의 언어. ReviewFlow가 화면
// 로케일을 넘긴다(목업 클라이언트는 쓰지 않는다).
export function getReviewClient(realSession = false, locale: Locale = DEFAULT_LOCALE): ReviewClient {
  return realSession ? createHttpReviewClient(locale) : mockReviewClient
}
