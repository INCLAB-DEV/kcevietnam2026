import "server-only"

// 실 로그인 세션의 공용 판정 헬퍼 — 도메인 중립 위치(원래 lib/meeting/http-meetings-client.ts에
// 미팅 화면 전용으로 있던 resolveHttpMeetingSession을 승격). Discover·홈 대시보드로 실연동 범위가
// 넓어지며, "지금 실 세션인가"를 화면마다 따로 판정하면 갈릴 수 있어(예: 한쪽만 세션 쿠키 유무를
// 놓치는 상황) 이 한 곳으로 모은다 — server.ts의 read seam과 각 페이지가 모두 이 함수를 쓴다.
//
// NEXT_PUBLIC_AUTH_CLIENT==="http" **이고** 로그인 BFF가 심은 세션·역할 쿠키가 실제로 있을 때만
// http로 분기한다(스위치 하나만으로 판단하지 않는다) — .env.local이 이미 전역
// NEXT_PUBLIC_AUTH_CLIENT=http라, 쿠키 유무까지 봐야 기존 ?as= mock 개발 스위처가 안 죽는다.

import { cookies } from "next/headers"
import { ORG_COOKIE, ROLE_COOKIE, SESSION_COOKIE } from "@/lib/auth/session-cookie"
import type { ViewerRole } from "@/lib/types"

export interface HttpSession {
  role: ViewerRole
  // 로그인 BFF가 /api/me 부트스트랩으로 심은 org UUID(P1-1). /api/me가 실패했던 로그인이면 null —
  // 호출부는 mock 세션의 orgId 등으로 폴백한다(예: app/meetings/page.tsx).
  orgId: string | null
}

export async function resolveHttpSession(): Promise<HttpSession | null> {
  if (process.env.NEXT_PUBLIC_AUTH_CLIENT !== "http") return null
  const jar = await cookies()
  if (!jar.get(SESSION_COOKIE)?.value) return null
  const role = jar.get(ROLE_COOKIE)?.value
  if (role !== "buyer" && role !== "exhibitor") return null
  return { role, orgId: jar.get(ORG_COOKIE)?.value ?? null }
}
