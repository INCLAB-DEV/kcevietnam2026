import "server-only"

// GET /api/admin/me 서버 전용 조회 — "지금 로그인한 운영자"의 단일 진실원천.
//
// 참가자용 lib/auth/me-client.ts(fetchMe)의 운영자판이다. 운영자는 fetchMe로 잡히지 않는다:
// 그쪽은 organizations에 속한 참가 주체(Principal.organization_id)를 전제하는데 운영자는
// organizers 계정이라 소속 org·역할이 없다. 그래서 별도 엔드포인트·별도 클라이언트다.
//
// 실세션 판정은 **SESSION_COOKIE 존재 여부**만 본다 — organizer는 lib/auth/http-session.ts의
// resolveHttpSession 대상이 아니고(그 함수는 ROLE_COOKIE가 buyer/exhibitor일 때만 실세션으로 본다),
// 이 레포의 다른 운영자 실연동 경로(lib/organizer/http-members-client.ts resolveOrganizerToken,
// OP-003 상태변경 라우트, OP-005 배정 프록시)가 전부 같은 규칙을 쓴다. 규칙을 맞춰야 "실 데이터 +
// 목업 이름" 같은 어긋남이 구조적으로 안 생긴다 — 신원과 데이터가 같은 세션 판정을 공유한다.
//
// 같은 요청 안에서 셸·페이지가 중복 호출해도 React cache()로 1회만 나간다.

import { cache } from "react"
import { cookies } from "next/headers"

import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import type { OperatorMe } from "@/lib/auth/operator-identity"

// 실 운영자 세션인가 — 목업 세션을 쓸지(dev), 백엔드 신원을 쓸지(실연동)를 가르는 단 하나의 스위치.
// 여기가 true면 신원은 반드시 fetchOperatorMe()에서 나온다. 실패해도 목업으로 되돌아가지 않는다.
export async function hasOperatorSession(): Promise<boolean> {
  return !!(await cookies()).get(SESSION_COOKIE)?.value
}

// 실 운영자 신원. 세션 쿠키가 없거나 백엔드가 거부/미가동이면 조용히 null —
// 호출부는 목업 인물이 아니라 **빈 신원**으로 폴백한다(operatorSidebarUser(null)).
export const fetchOperatorMe = cache(async (): Promise<OperatorMe | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const base = process.env.NABI_BACKEND_URL
  if (!token || !base) return null
  try {
    const res = await fetch(`${base}/api/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as OperatorMe
  } catch {
    return null
  }
})
