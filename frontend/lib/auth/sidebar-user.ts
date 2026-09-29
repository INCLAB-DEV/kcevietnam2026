// 실 세션 사이드바 신원 조립 — GET /api/me(fetchMe) 결과를 사이드바 표시 형태(SidebarUser)로
// 매핑한다. app-shell.tsx(서버 컴포넌트)에서 쓰는 로직을 순수 함수로 분리해 null 필드 처리(그
// 줄 숨김, app-sidebar.tsx)와 locale 분기를 컴포넌트 트리 없이 단위 테스트할 수 있게 한다.
//
// me가 null(세션 쿠키 없음·백엔드 미가동 등)이면 전 필드를 비운다 — mock 세션의 다른 인물 정보로
// 대체하지 않는다("실세션이면 fetchMe() 결과로 구성"이 원칙; 잘못된 신원을 보여주는 것보다 빈 줄이 낫다).

import type { SidebarUser } from "@/components/app-sidebar"
import type { Locale } from "@/lib/i18n/config"

// fetchMe()의 MeResponse와 구조적으로 호환(필요한 필드만) — lib/auth/me-client.ts(server-only)를
// 직접 import하지 않아 이 모듈은 클라/테스트 어디서나 부작용 없이 쓸 수 있다.
export interface SidebarIdentitySource {
  organization_name: string
  organization_name_en?: string | null
  member_name?: string | null
  member_email?: string | null
  member_phone?: string | null
}

export function resolveSidebarUser(me: SidebarIdentitySource | null, locale: Locale): SidebarUser {
  if (!me) return { name: null, affiliation: null, email: null, phone: null }
  // en 로케일에서 영문 소속명이 아직 없으면(백엔드 롤아웃 중) 원문 소속명으로 폴백 —
  // 소속 자체를 숨기는 것보다 낫다.
  const affiliation = locale === "en" ? (me.organization_name_en ?? me.organization_name) : me.organization_name
  return {
    name: me.member_name ?? null,
    affiliation: affiliation ?? null,
    email: me.member_email ?? null,
    phone: me.member_phone ?? null,
  }
}
