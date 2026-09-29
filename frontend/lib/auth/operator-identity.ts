// 운영자(운영사·어드민) 신원의 순수 해석 — `GET /api/admin/me` 응답을 화면이 쓰는 형태로 옮긴다.
// 참가자 쪽 lib/auth/sidebar-user.ts와 같은 자리이고 같은 원칙이다: **없는 값은 지어내지 않는다.**
//
// 이 모듈이 생긴 이유(2026-09-10 결함): 운영자 화면은 셸에 목업 세션(MOCK_ACCOUNTS.organizer)을
// 그대로 넘겼고, prod에서 dev 스위처가 꺼져 있어도 그 목업이 살아남아 실제 로그인한 운영자가
// "정세훈 / 2026 베트남 K-콘텐츠 엑스포 사무국"으로 보였다. 더 나쁜 건 그 이름이 대리작성·
// 미팅취소 감사기록의 actorName으로 DB에 박혔다는 것이다. 실 신원의 원천은 이제 백엔드다.
//
// 순수 함수만 둔다(fetch·쿠키 없음) — 호출부는 lib/auth/operator-me-client.ts(server-only).

import type { SidebarUser } from "@/components/app-sidebar"
import type { PermissionLevel } from "@/lib/mock/session"

export interface OperatorMeEvent {
  event_id: string
  /** 'master' | 'sub' — 계약 밖 값이 와도 타입이 깨지지 않도록 string으로 받고 아래에서 좁힌다. */
  permission_level: string
}

/** GET /api/admin/me 응답(app.admin.schemas.AdminMeOut)과 필드 단위로 대응. */
export interface OperatorMe {
  member_id: string
  organizer_id: string
  name: string | null
  email: string | null
  phone: string | null
  affiliation: string | null
  events: OperatorMeEvent[]
}

// 실세션인데 신원 조회가 실패했을 때 어드민 사이드바가 쓸 표기. 이름 칸이 구조상 비워질 수 없는
// 곳(admin-sidebar는 배지와 한 줄로 묶여 있다)에서만 쓴다 — **가짜 사람 이름 대신** 역할명이다.
export const OPERATOR_FALLBACK_NAME = "운영자"

function isPermissionLevel(value: string | undefined): value is PermissionLevel {
  return value === "master" || value === "sub"
}

// 실 운영자 신원 → 사이드바 표시. me가 null(조회 실패·미배선)이면 전 필드를 비운다 —
// 목업 인물로 대체하지 않는다(app-sidebar는 null인 줄을 통째로 숨긴다).
export function operatorSidebarUser(me: OperatorMe | null): SidebarUser {
  if (!me) return { name: null, affiliation: null, email: null, phone: null }
  return {
    name: me.name ?? null,
    affiliation: me.affiliation ?? null,
    email: me.email ?? null,
    phone: me.phone ?? null,
  }
}

// 이 운영자가 **해당 행사에서** 갖는 권한등급(ADR-0012 — 등급은 계정 전역이 아니라 계정×행사).
//
// eventId를 주지 않으면 배정된 첫 행사의 등급을 쓴다. 구 organizer 콘솔에는 행사 선택 UI가 없어
// "배정된 첫 행사" 전제로 돌아가는데(lib/organizer/backend-proxy.ts resolveEventId), 그 전제와
// 같은 규칙을 여기서도 쓴다.
//
// 모르면(조회 실패·그 행사에 배정 없음) undefined — **호출부가 자기 맥락에 맞는 폴백을 정한다.**
// 여기서 임의로 master나 sub를 지어내지 않는다: 어드민 거버넌스는 default-deny(sub)가 맞지만,
// 명단 화면에서 sub로 떨어뜨리면 정상 master가 목록을 통째로 못 보게 되는 등 맥락마다 다르다.
export function operatorPermissionLevel(
  me: OperatorMe | null,
  eventId?: string | null,
): PermissionLevel | undefined {
  if (!me || me.events.length === 0) return undefined
  const match = eventId ? me.events.find((e) => e.event_id === eventId) : me.events[0]
  const level = match?.permission_level
  return isPermissionLevel(level) ? level : undefined
}
