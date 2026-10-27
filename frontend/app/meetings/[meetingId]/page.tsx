import { notFound, redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppShellForRequest } from "@/components/layout/app-shell"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { ReviewFlow } from "@/components/review/review-flow"
import { MeetingDetailPanel } from "@/components/meeting/meeting-detail-panel"
import { buildMeetingPanels } from "@/lib/meeting/meeting-panel"
import { shouldShowReviewFlow } from "@/lib/meeting/review-gate"
import { resolveMockSession, toGuardSession } from "@/lib/mock/session"
import { MOCK_BUYERS, MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMeetingById } from "@/lib/meeting/http-meetings-client"
import { fetchDiscoverOrganization } from "@/lib/discover/http-discover-client"

export const dynamic = "force-dynamic"

// KST "지금" — buildMeetingPanels의 만료(수락 전 시간 지남) 판정용. app/meetings/page.tsx의
// kstNow와 동일 원칙(Asia/Seoul 하드코딩은 알려진 보류 사항 — 이번 범위에서 고치지 않는다).
function kstNow(): { date: string; time: string } {
  const d = new Date()
  return {
    date: d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }),
    time: d.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  }
}

// MY-002 미팅 리뷰 — 참가사·바이어 공용 단일 라우트(F-MY-002).
// 본인이 참석한 미팅의 본인측 리뷰만 작성·열람. 운영사는 OP-* 대시보드(여기서 작성 안 함).
// 실 세션(로그인 BFF가 심은 세션·역할 쿠키)이면 FastAPI에서 미팅·상대 기업을 실 조회하고,
// 회의록 자체(ReviewFlow)도 BFF(/api/reviews) 경유 실 백엔드로 배선한다. 아니면 기존 mock 그대로
// (mock 모드 보존 원칙). dev 계정 전환: /meetings/{id}?as=buyer|exhibitor.
//
// ⚠ H-04: 이 라우트는 원래 MY-002(회의록) 전용으로 만들어졌지만, 홈/미팅목록 알림이 확정 전
// 미팅에도 이 경로로 딥링크한다(구 라우팅 버그의 잔재). 미팅이 아직 확정(accepted)되지 않았으면
// 회의록 폼이 아니라 미팅 상세(상대 기업·일시·장소·신청 메시지·상태)를 보여준다 — accepted 이상
// (accepted·completed)이면 기존 ReviewFlow로 들어간다(2026-09-14 제품 결정: 행사 전이라도 확정
// 미팅이면 회의록·녹음 업로드를 자유롭게 — shouldShowReviewFlow 참고).
export default async function MeetingReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ meetingId: string }>
  searchParams: Promise<{ as?: string }>
}) {
  const { meetingId } = await params
  const { as } = await searchParams
  const guard = toGuardSession(as)

  if (!guard.authenticated) redirect("/meetings")
  const session = resolveMockSession(as)
  // real 세션의 role은 mock 기본값(buyer)이 아니라 로그인 BFF가 심은 역할 쿠키를 따른다
  // (app/meetings/page.tsx와 동일 원칙 — 안 그러면 실 exhibitor 세션이 이 guard를 mock 기준(buyer)
  // 으로 통과해 organizer 여부를 못 가린다. real 세션은 buyer/exhibitor만 존재해 이 체크가
  // organizer를 걸러낼 일은 없지만, 아래 counterpartOrg 분기가 role을 정확히 봐야 한다).
  const realSession = await resolveHttpSession()
  const viewerRole = realSession?.role ?? session.role
  if (viewerRole === "organizer") redirect("/organizer")

  let counterpartOrg: string
  let viewerOrgId = session.orgId

  if (realSession) {
    const meeting = await fetchMeetingById(meetingId)
    if (!meeting) notFound()
    const orgId = realSession.orgId ?? session.orgId
    // 참석자 본인이 아니면(백엔드가 이미 403으로 걸렀겠지만, org 쿠키가 비어 mock orgId로 폴백된
    // 극단 케이스 방어) 상대 미팅 정보를 노출하지 않는다 — 404로 뭉갠다(존재 비노출 원칙).
    if (orgId !== meeting.buyerOrgId && orgId !== meeting.exhibitorOrgId) notFound()
    viewerOrgId = orgId
    const counterpartOrgId = orgId === meeting.buyerOrgId ? meeting.exhibitorOrgId : meeting.buyerOrgId
    const counterpart = await fetchDiscoverOrganization(counterpartOrgId)
    counterpartOrg = counterpart?.name ?? meeting.counterpartName

    if (!shouldShowReviewFlow(meeting.status)) {
      // 회의록 폼 대신 미팅 상세 — MY-001 우측 패널과 같은 투영(buildMeetingPanels)·같은 카드
      // (MeetingDetailPanel)를 재사용한다(새 화면을 따로 설계하지 않는다).
      const meetingsHref = as ? `/meetings?as=${as}` : "/meetings"
      const [tPage, tMeeting, tCommon] = await Promise.all([
        getTranslations("meeting.page"),
        getTranslations("meeting"),
        getTranslations("common"),
      ])
      const breadcrumb = (
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href={meetingsHref}>{tPage("breadcrumbMeetings")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{tPage("breadcrumbDetail")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )
      // 상대 기업이 Discover 목록에 없어도(승인 전 바이어 — Discover는 approved만 내려준다) 404로
      // 뭉개지 않는다: orgs를 비워 넘기면 buildMeetingPanels가 미팅 레코드의 counterpartName으로
      // 같은 카드를 만든다(기업 상세 링크만 숨김). 2026-10-26 발주사 피드백: 승인 전 바이어와의
      // 미팅에서 회의록 작성 진입 불가. (미팅 자체의 존재·당사자 여부는 위에서 이미 걸렀다.)
      const panels = buildMeetingPanels({
        viewerRole,
        viewerOrgId,
        viewerOrg: null, // AI 매칭 점수는 이 상세에서 다루지 않는다(MY-001 패널 전용 정보)
        viewerMember: null,
        meetings: [meeting],
        orgs: counterpart ? [counterpart] : [],
        contacts: {},
        now: kstNow(),
        t: tMeeting,
        buyerTypeLabel: (type) => tCommon(`buyerType.${type}`),
      })
      const view = panels[meetingId]
      if (!view) notFound()
      return (
        <AppShellForRequest breadcrumb={breadcrumb}>
          <div className="mx-auto w-full max-w-2xl">
            <MeetingDetailPanel view={view} />
          </div>
        </AppShellForRequest>
      )
    }
  } else {
    // 상대 기업명은 데모용 고정값(mock 전용, 목업 디렉터리의 첫 참가사·첫 바이어) — 실 세션은 위에서
    // 백엔드 미팅·기업 조회로 채운다.
    counterpartOrg = (session.role === "buyer" ? MOCK_EXHIBITORS[0] : MOCK_BUYERS[0]).name
  }

  // 상세→목록 복귀 동선. dev 역할 전환(?as=)을 링크에 보존해 미팅 목록도 같은 시점으로 돌아간다.
  const meetingsHref = as ? `/meetings?as=${as}` : "/meetings"
  const tPage = await getTranslations("meeting.page")
  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href={meetingsHref}>{tPage("breadcrumbMeetings")}</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{tPage("breadcrumbReview")}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )

  return (
    <AppShellForRequest session={realSession ? undefined : session} breadcrumb={breadcrumb}>
      <ReviewFlow
        meetingId={meetingId}
        counterpartOrg={counterpartOrg}
        orgId={viewerOrgId}
        realSession={!!realSession}
      />
    </AppShellForRequest>
  )
}
