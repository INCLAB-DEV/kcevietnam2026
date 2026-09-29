// F-DV-001/F-MT-001 — 상세 모달/카드에서 미팅 신청을 누르는 순간에만 읽는 가용성(슬롯·장소·AI 초안).
// 읽기 seam(serverApiClient)은 server-only라 클라가 직접 못 쓴다 → 이 route handler가 서버에서
// 대신 읽어 JSON으로 돌려준다(ADR-0008 경계 B: Next.js → API). 풀페이지는 서버에서 미리 읽어
// 내려주므로 이 경로를 타지 않고, 모달·카드만 lazy-fetch로 여기에 붙는다.
//
// 권한검사는 서버 한 곳(ADR-0008). availability는 인증된 참가자(매칭 대상 뷰어)에게만 내주고,
// 방향별 가시성(canViewOrg, 풀페이지와 동일)을 서버에서 강제한다. 미인증·운영자·비가시 대상은
// 데이터 없이 거절한다.

import { NextResponse } from "next/server"
import { getLocale } from "next-intl/server"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveLocale } from "@/lib/i18n/config"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { canViewOrg } from "@/lib/discover/visibility"
import type { ViewerRole } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams
  const orgId = searchParams.get("org")
  if (!orgId) return NextResponse.json({ error: "missing_org" }, { status: 400 })

  // 미인증은 미팅 신청 자격이 없다 — 서버는 데이터 없이 401.
  const guard = await resolveRequestGuard()
  if (!guard.authenticated) return NextResponse.json({ error: "unauthenticated" }, { status: 401 })

  // 운영자는 참가측 미팅 신청 대상이 아니다.
  const session = await resolveRequestSession()
  if (session.role === "organizer") return NextResponse.json({ error: "forbidden" }, { status: 403 })
  // 실 세션이면 그 역할을, 아니면 기존 mock/dev 세션(?as=)을 쓴다 — 풀페이지 상세와 동일 패턴
  // (app/discover/[organizationId]/page.tsx). 실 org 게이트(canViewOrg)가 실제 로그인 역할을
  // 봐야 하므로 mock 세션의 기본 role로 잘못 판정되지 않게 한다.
  const realSession = await resolveHttpSession()
  const viewerRole: ViewerRole = realSession?.role ?? session.role

  const org = await serverApiClient.getOrganization(orgId)
  if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 })
  // 방향별 가시성(풀페이지 상세와 동일 게이트, 행사 설정에서 읽음) — 볼 수 없는 대상엔 가용성도 없다.
  const settings = await serverApiClient.getEventSettings()
  if (!canViewOrg(viewerRole, org, settings.allowSameRoleDiscovery)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  try {
    // 클라이언트 재조회는 locale을 명시하고, 누락된 이전 호출은 요청 쿠키 locale로 보완한다.
    const locale = resolveLocale(searchParams.get("locale") ?? await getLocale())
    const availability = await serverApiClient.getMeetingAvailability(org, locale)
    return NextResponse.json(availability)
  } catch (err) {
    // http 분기(실 세션)에서 백엔드가 거부/실패하면(예: org가 아직 mock 디렉터리 전용이라 실
    // counterpart_org_id가 아닌 경우 — Discover 기업 디렉터리는 이 슬라이스의 스왑 대상이
    // 아니다) 여기서 502로 깔끔하게 막는다 — 안 잡으면 Next가 스택트레이스와 함께 500을 낸다.
    console.error("[discover/availability] upstream failure", err)
    return NextResponse.json({ error: "upstream_failure" }, { status: 502 })
  }
}
