import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { DiscoverTabs } from "@/components/discover/discover-tabs"
import { serverApiClient } from "@/lib/api-client/server"
import type { MatchResult } from "@/lib/api-client"
import { counterpartOrgs } from "@/lib/discover/visibility"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import type { Organization, ViewerRole } from "@/lib/types"

export const dynamic = "force-dynamic"

// 세션은 쿠키 단일 소스에서 읽는다(dev 전환은 proxy가 ?as→쿠키로 처리).
// 미인증 접근은 route-guard가 /login으로 차단한다(인증 참가자 전용).
export default async function DiscoverPage() {
  const session = await resolveRequestSession()
  // 운영사는 탐색 대상이 아니다(참가자 전용) — 운영 대시보드로.
  if (session.role === "organizer") redirect("/organizer")

  // 실 세션(로그인 BFF가 심은 쿠키)이면 그 역할을, 아니면 기존 mock/dev 세션(?as=)을 쓴다
  // (app/meetings/page.tsx와 같은 패턴, lib/auth/http-session.ts).
  const realSession = await resolveHttpSession()
  const viewerRole: ViewerRole = realSession?.role ?? session.role
  // 기업 디렉터리는 api-client seam에서 방향별 가시성이 이미 적용된 채로 온다(ADR-0008,
  // lib/discover/visibility.ts + 행사 설정) — 화면 계층에서 다시 걸러낼 필요가 없다(우회 경로 차단).
  const orgs = await serverApiClient.getOrganizations(viewerRole)
  const viewerOrg = await serverApiClient.getViewerOrg(viewerRole)
  // AI 추천 후보는 행사 설정과 무관하게 항상 "상대 역할만"(완전 대칭, 매칭 고유 규칙) — counterpartOrgs로 별도 좁힌다.
  const recommendations = await serverApiClient.getRecommendations(
    viewerOrg,
    counterpartOrgs(viewerRole, orgs),
  )
  const tPage = await getTranslations("discover.page")
  return (
    <AppShellForRequest>
      <DiscoverContent
        viewerRole={viewerRole}
        orgs={orgs}
        viewerOrg={viewerOrg}
        recommendations={recommendations}
        header={{
          title: tPage("title"),
          subtitle: tPage("subtitle"),
        }}
      />
    </AppShellForRequest>
  )
}

function DiscoverContent({
  viewerRole,
  orgs,
  viewerOrg,
  recommendations,
  header,
}: {
  viewerRole: ViewerRole
  orgs: Organization[]
  viewerOrg?: Organization
  recommendations?: MatchResult[]
  header: { title: string; subtitle: string }
}) {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{header.title}</h1>
        <p className="text-sm text-muted-foreground">{header.subtitle}</p>
      </header>
      <Suspense>
        <DiscoverTabs
          viewerRole={viewerRole}
          orgs={orgs}
          viewerOrg={viewerOrg}
          recommendations={recommendations}
        />
      </Suspense>
    </div>
  )
}
