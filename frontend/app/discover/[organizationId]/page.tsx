import { notFound, redirect } from "next/navigation"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { OrganizationDetail, type DetailMatch } from "@/components/discover/organization-detail"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { participantMenuForSession } from "@/lib/auth/participant-menu-server"
import { canViewOrg, counterpartRole } from "@/lib/discover/visibility"
import type { Organization, ViewerRole } from "@/lib/types"

export const dynamic = "force-dynamic"

// 돌아갈 /discover 경로 — 진입 탭을 유지. dev 세션은 쿠키라 URL에 ?as를 싣지 않는다.
function discoverHref(from: string | undefined): string {
  const tab = from === "ai" || from === "bookmarks" ? from : "all"
  return `/discover?tab=${tab}`
}

// AI 추천 탭(from=ai)에서 진입했고 상대(매칭 대상)일 때만 적합도 배너를 보여준다.
// 점수계산은 seam 뒤(MockApiClient.getRecommendations)에서 끝낸다(ADR-0008) — 여기선 결과만 투영.
async function resolveMatch(
  from: string | undefined,
  viewerRole: ViewerRole,
  viewerOrg: Organization | undefined,
  org: Organization
): Promise<DetailMatch | undefined> {
  if (from !== "ai" || !viewerOrg) return undefined
  if (org.role !== counterpartRole(viewerRole)) return undefined
  const [result] = await serverApiClient.getRecommendations(viewerOrg, [org])
  if (!result) return undefined
  return { score: result.aiScore, reasons: result.aiReasons }
}

export default async function OrganizationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const { organizationId } = await params
  const { from } = await searchParams

  const org = await serverApiClient.getOrganization(organizationId)
  if (!org) notFound()

  // 담은 출처: AI 추천 탭 경유 진입이면 "ai", 그 외(전체 기업·관심기업)는 "all"(F-DV-001 D12).
  const bookmarkSource = from === "ai" ? "ai" : "all"

  // 미인증 접근은 route-guard가 /login으로 차단한다(인증 참가자 전용).
  const session = await resolveRequestSession()
  if (session.role === "organizer") redirect("/organizer")

  // 실 세션이면 그 역할을, 아니면 기존 mock/dev 세션(?as=)을 쓴다(app/discover/page.tsx와 동일 패턴).
  const realSession = await resolveHttpSession()
  const viewerRole: ViewerRole = realSession?.role ?? session.role
  // 돌아갈 곳 — 전체 메뉴로 설정한 행사에서는 진입한 탐색 탭이다. 행사의 참가자 메뉴가 "미팅만"이면
  // (기본, F-NV-001 D15) 기업 탐색이 메뉴에 없고 이 화면은 미팅의 "기업 상세 보기"로 닿으므로, 뒤로가기도
  // 미팅으로 돌아간다.
  const participantMenu = await participantMenuForSession(realSession)
  const backHref = participantMenu === "meetings_only" ? "/meetings" : discoverHref(from)
  // 행사 설정(같은 역할 상호열람 허용 여부)을 데이터 접근 계층에서 읽어 게이트에 반영한다.
  const settings = await serverApiClient.getEventSettings()
  if (!canViewOrg(viewerRole, org, settings.allowSameRoleDiscovery)) redirect(backHref)

  const viewerOrg = await serverApiClient.getViewerOrg(viewerRole)
  const match = await resolveMatch(from, viewerRole, viewerOrg, org)
  // 미팅 신청 모달이 쓸 가용성(슬롯·장소·AI 초안)을 서버에서 미리 읽어 클라 모달로 내려준다.
  // 백엔드가 거부하는 엣지 케이스(예: 상대가 같은 행사 소속이 아닌 경우 등)엔 페이지 전체가 죽는
  // 대신 notFound로 안전하게 접는다(lazy-fetch 경로의 app/api/discover/availability/route.ts와 같은 원칙).
  let availability
  try {
    availability = await serverApiClient.getMeetingAvailability(org)
  } catch (err) {
    console.error("[discover/[organizationId]] availability upstream failure", err)
    notFound()
  }

  return (
    <AppShellForRequest>
      <OrganizationDetail
        org={org}
        viewerRole={viewerRole}
        match={match}
        backHref={backHref}
        bookmarkSource={bookmarkSource}
        availability={availability}
      />
    </AppShellForRequest>
  )
}
