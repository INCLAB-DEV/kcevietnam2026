// 참가자 메뉴 — 행사 설정값(F-NV-001 D15). 참가사·바이어 화면의 왼쪽 메뉴를 미팅만 낼지
// ("meetings_only", 기본) 전부 낼지("full") 행사가 고른다. 슈퍼어드민이 /admin/settings에서 바꾸고
// (PATCH /api/admin/events/{id}/settings), 참가자 화면은 GET /api/me의 roles[].participant_menu로 받는다.
//
// **화면 구성용 값이다 — 권한이 아니다**(ADR-0015). "미팅만"이어도 숨긴 화면(/discover·/notifications·
// 프로필)은 주소로 들어오면 그대로 열리고 백엔드 API도 그대로 동작한다. 이 값으로 라우트를 막지 않는다
// (proxy·route-guard는 이 값을 모른다) — 그래서 이 모듈에는 "어디로 보낼까"만 있고 "막을까"는 없다.
//
// 순수 함수만 둔다(부수효과 없음) — 서버(셸·페이지)·클라(사이드바·패널)·어드민 콘솔이 같은 어휘를 쓰고
// 단위 테스트한다. 백엔드 어휘의 정본은 backend/app/models.py PARTICIPANT_MENUS(= DB CHECK)다.

export const PARTICIPANT_MENUS = ["meetings_only", "full"] as const
export type ParticipantMenu = (typeof PARTICIPANT_MENUS)[number]

// 기본값 — 값을 알 수 없을 때의 **유일한** 폴백이다. 프런트의 모든 폴백(응답에 필드가 없음·모르는 값·
// /api/me 조회 실패·목업 세션·컨텍스트 밖 렌더·생략한 인자)이 이 상수 하나를 본다. 값을 따로 적지 않는다
// — 기본값이 바뀌면 여기 한 줄만 고친다(백엔드 짝: backend/app/models.py DEFAULT_PARTICIPANT_MENU).
//
// "미팅만"이 기본인 건 발주사 결정이다(2026-10-08): 배포하는 순간 참가사·바이어 화면이 미팅 전용으로
// 보여야 하고, 누가 설정을 따로 켤 필요가 없어야 한다. 전체 메뉴는 행사 설정에서 고르면 돌아오고,
// 그렇게 고른 행사의 화면은 이 설정이 생기기 전과 완전히 같다.
export const DEFAULT_PARTICIPANT_MENU: ParticipantMenu = "meetings_only"

// 백엔드 응답 값 → 참가자 메뉴. 필드가 없거나(구 백엔드·롤아웃 중) 모르는 값이면 기본값이다.
export function parseParticipantMenu(value: unknown): ParticipantMenu {
  return (PARTICIPANT_MENUS as readonly unknown[]).includes(value)
    ? (value as ParticipantMenu)
    : DEFAULT_PARTICIPANT_MENU
}

// GET /api/me 응답 중 이 판정에 필요한 부분만(lib/auth/me-client.ts의 MeResponse와 구조적으로 호환) —
// server-only 모듈을 import하지 않아 클라·테스트 어디서나 쓸 수 있다(lib/auth/sidebar-user.ts와 같은 방식).
export interface ParticipantMenuSource {
  roles?: ReadonlyArray<{
    is_buyer: boolean
    is_exhibitor: boolean
    participant_menu?: string | null
  }> | null
}

// 지금 화면에 적용할 참가자 메뉴. 값은 행사 단위라 "어느 행사의 값인가"를 골라야 한다 — 로그인한
// 역할(바이어/참가사)로 참가 중인 행사의 것을 쓴다(/welcome이 신청 상태를 고르는 행과 같은 규칙).
// 그 역할의 행이 없으면 첫 행(참가 순), 그마저 없으면(me 조회 실패·역할 행 없음) 기본값이다.
export function resolveParticipantMenu(
  me: ParticipantMenuSource | null | undefined,
  role: "buyer" | "exhibitor",
): ParticipantMenu {
  const roles = me?.roles ?? []
  const row = roles.find((r) => (role === "buyer" ? r.is_buyer : r.is_exhibitor)) ?? roles[0]
  return parseParticipantMenu(row?.participant_menu)
}

// 승인된 참가자가 본 서비스에 들어왔을 때의 도착 화면. 미팅만이면 대시보드가 메뉴에 없으므로 미팅
// ("/meetings"), 전체 메뉴는 대시보드("/")다. 로그인 후 /welcome의 입장 동선과 "/" 직접 접근이
// 이 함수 하나를 본다 — 그래서 "/"를 가리키는 다른 동선(역할 불일치 리다이렉트·쿠키 재동기화의 기본
// next·승인 알림의 목적지)은 고치지 않아도 "/"를 거쳐 여기 닿는다.
export function participantHomePath(menu: ParticipantMenu): "/" | "/meetings" {
  return menu === "meetings_only" ? "/meetings" : "/"
}
