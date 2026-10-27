import "server-only"

// 지금 요청에 적용할 참가자 메뉴(F-NV-001 D15) — 서버 컴포넌트 공용 진입점.
//
// 셸(사이드바)·"/"·/welcome·/meetings·/discover/{id}가 각자 값을 구하면 한 요청 안에서 메뉴와 도착
// 화면이 갈릴 수 있다. 전부 이 함수를 불러 같은 원천(GET /api/me, fetchMe는 요청당 1회 캐시)과 같은
// 해석(lib/event/participant-menu.ts)을 쓴다.
//
// 실 세션(로그인 BFF가 심은 세션·역할 쿠키)이면 행사 설정을 따른다 — 호출부가 이미 갖고 있는
// resolveHttpSession() 결과를 그대로 넘긴다(null이면 목업 세션). 조회가 실패하거나 응답에 값이 없으면
// 기본값(미팅만)이다.
//
// 목업·dev 세션에는 행사 설정이 없다. dev 오버라이드 쿠키(nabi_dev_menu = full|meetings_only)가 명시했으면
// 그 값, 아니면 역시 기본값이다 — 메뉴 5개를 전제하는 dev 화면은 그 쿠키를 full로 두고 연다(심는 법은
// lib/mock/session.ts의 DEV_MENU_COOKIE 주석). dev 쿠키는 dev에서만 읽힌다(lib/mock/session-server.ts의
// devCookie 게이트) — prod에서 실 세션이 아닌 요청은 언제나 기본값이다.

import { fetchMe } from "@/lib/auth/me-client"
import type { HttpSession } from "@/lib/auth/http-session"
import {
  parseParticipantMenu,
  resolveParticipantMenu,
  type ParticipantMenu,
} from "@/lib/event/participant-menu"
import { requestParticipantMenuOverride } from "@/lib/mock/session-server"

export async function participantMenuForSession(
  realSession: HttpSession | null,
): Promise<ParticipantMenu> {
  if (!realSession) return parseParticipantMenu(await requestParticipantMenuOverride())
  return resolveParticipantMenu(await fetchMe(), realSession.role)
}
