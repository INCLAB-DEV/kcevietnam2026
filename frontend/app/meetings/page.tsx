import { redirect } from "next/navigation"
import { getLocale, getTranslations } from "next-intl/server"
import { resolveLocale } from "@/lib/i18n/config"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { MeetingTimeline } from "@/components/meeting/meeting-timeline"
import { MeetingEmptyStateView } from "@/components/meeting/meeting-empty-state"
import { buildTimeline } from "@/lib/meeting/timeline"
import { resolveActionStrip, type ActionStripView } from "@/lib/meeting/action-strip"
import { buildMeetingPanels, resolvePanelInitial } from "@/lib/meeting/meeting-panel"
import { resolveMeetingEmptyState } from "@/lib/meeting/empty-state"
import { MOCK_CONTACTS } from "@/lib/meeting/my-meetings-mock"
import { ALL_MOCK_ORGS } from "@/lib/mock-orgs"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import type { PanelMember } from "@/lib/meeting/meeting-panel"
import type { ViewerRole } from "@/lib/types"

export const dynamic = "force-dynamic"

// 현재 시각(KST) — 타임라인의 "지금" 마커용. force-dynamic이라 요청 시점에 평가된다.
// 데모/검증용 오버라이드: ?now=2026-09-17T11:00 (KST). 페이지가 전부 mock + 표시용 투영이라
// 쓰기·보안 영향 없음. 형식이 안 맞으면 무시하고 실제 현재 시각을 쓴다.
function kstNow(override?: string): { date: string; time: string } {
  if (override) {
    const m = override.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
    if (m) return { date: m[1], time: m[2] }
  }
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

// MY-001 — 참가사·바이어 전원 공용 단일 라우트(F-MY-001 D1), 화면 안에서 역할별 뷰로 분기.
// 데이터 조회/액션은 전부 FastAPI 경유(ADR-0008) — 백엔드 #33 이전엔 api-client seam의 mock으로 렌더.
// 세션은 쿠키 단일 소스에서 읽는다(dev 전환은 proxy가 ?as→쿠키로 처리).
// 미인증 접근은 route-guard가 /login으로 차단한다(인증 참가자 전용).
export default async function MeetingsPage({
  searchParams,
}: {
  // meeting=<id>: 알림 인박스 딥링크(lib/home/notification.ts) — 그 미팅을 선택한 상태로 연다.
  searchParams: Promise<{ now?: string; meeting?: string }>
}) {
  const { now: nowOverride, meeting: focusMeetingId } = await searchParams

  const session = await resolveRequestSession()
  // 운영사는 전체 미팅을 OP-* 대시보드에서 관리한다(PRD 접근 권한 표) — 운영 대시보드로.
  // (real 세션은 ROLE_COOKIE가 buyer/exhibitor만 실어 organizer가 될 수 없다 — 이 체크는 항상
  // mock/dev 세션 기준으로 충분하다.)
  if (session.role === "organizer") redirect("/organizer")

  // 실 세션(NEXT_PUBLIC_AUTH_CLIENT==="http" + 로그인 BFF가 심은 세션·역할 쿠키)이면 그 역할·org를,
  // 아니면 기존 mock/dev 세션(?as=)을 쓴다 — 도메인 중립 헬퍼로 승격됐다(lib/auth/http-session.ts, P1-1).
  const realSession = await resolveHttpSession()
  const viewerRole: ViewerRole = realSession?.role ?? session.role
  const isRealSession = realSession !== null
  // real 세션의 org id는 로그인 BFF가 /api/me 부트스트랩으로 심은 org 쿠키에서 온다(P1-1) —
  // 예전엔 "/me" 류 엔드포인트가 없어 미팅 목록에서 역산(deriveViewerOrgId)했지만 더 이상 필요 없다.
  const viewerOrgId = isRealSession ? (realSession.orgId ?? session.orgId) : session.orgId
  const viewer = { role: viewerRole, orgId: viewerOrgId }
  const now = kstNow(nowOverride)
  const locale = resolveLocale(await getLocale())
  const [t, tShort, tMeeting, tPage, tDiscover] = await Promise.all([
    getTranslations("meeting.status"),
    getTranslations("meeting.shortStatus"),
    getTranslations("meeting"),
    getTranslations("meeting.page"),
    getTranslations("discover"),
  ])
  const HEADER = { title: tPage("title"), subtitle: tPage("subtitle") }
  // 미팅·행사일·viewer 조직·상대 기업 디렉터리는 api-client seam에서 읽는다(ADR-0008 / #33).
  // getOrganizations·getViewerOrg는 이제 real 세션이면 실 Discover 디렉터리다(P1-2) — 예전엔 mock
  // 전용이라 이름만 아는 스텁(counterpartStubOrgs)을 만들었지만 더 이상 필요 없다.
  const [meetings, eventDates, viewerOrg, orgs] = await Promise.all([
    serverApiClient.getMyMeetings(viewer),
    serverApiClient.getEventDates(),
    serverApiClient.getViewerOrg(viewerRole),
    isRealSession ? serverApiClient.getOrganizations(viewerRole) : Promise.resolve(ALL_MOCK_ORGS),
  ])
  // real 세션의 참석자(담당자) 상세는 아직 없다(백엔드에 해당 조회 엔드포인트가 없다) — 있는 것만
  // 그리고 나머지는 정직하게 비운다(fabricated 정보 노출 금지, admin/http-client.ts와 같은 원칙).
  const viewerMember: PanelMember | null = isRealSession
    ? null
    : { side: "us", name: session.user.name, title: session.user.affiliation }
  const contacts = isRealSession ? {} : MOCK_CONTACTS

  const projection = buildTimeline({
    viewerRole,
    viewerOrgId,
    meetings,
    eventDates,
    now,
    locale,
    t,
    tShort,
  })
  // 우측 패널: 상대 기업·매칭근거·참석자. real 세션은 실 Discover 디렉터리(orgs)에서 상대를 찾아
  // 부스·전시제품 등 상세가 채워진다 — 참석자(담당자)만 위 주석과 같은 이유로 비어 보인다.
  const panels = buildMeetingPanels({
    viewerRole,
    viewerOrgId,
    viewerOrg,
    viewerMember,
    meetings,
    orgs,
    contacts,
    now,
    t: tMeeting,
    discoverT: tDiscover,
  })
  const initial = resolvePanelInitial({
    meetings,
    viewerRole,
    viewerOrgId,
    eventDates,
    now,
  })
  // 상단 액션 스트립(D18 단일 소스): 홈과 동일한 rollup에서 받은 미팅요청·회의록만 추린다.
  const actionStrip = resolveActionStrip({
    meetings,
    viewerRole,
    viewerOrgId,
    now,
  })

  const emptyState = resolveMeetingEmptyState(viewerRole, await getTranslations("meeting.emptyState"))

  // 알림 딥링크(?meeting=)로 지목된 미팅을 명시적 선택으로 승격한다. panels는 이미 viewerOrgId로
  // 걸러진 "내 미팅"만 담고 있으므로(lib/meeting/meeting-panel.ts), 여기 없는 id는 조용히 무시한다
  // — 남의 미팅 id를 넣어봐야 존재 여부가 드러나지 않고 평소 화면(다음 예정 미팅)으로 떨어진다.
  const selectedMeetingId = focusMeetingId && panels[focusMeetingId] ? focusMeetingId : null

  return (
    <AppShellForRequest>
      <MeetingsContent
        header={HEADER}
        projection={projection}
        panels={panels}
        initialSelectedId={selectedMeetingId}
        defaultMeetingId={initial.defaultMeetingId}
        panelEmptyState={initial.emptyState}
        actionStrip={actionStrip}
        emptyState={emptyState}
      />
    </AppShellForRequest>
  )
}

function MeetingsContent({
  header,
  projection,
  panels,
  initialSelectedId = null,
  defaultMeetingId,
  panelEmptyState,
  actionStrip,
  emptyState,
}: {
  header: { title: string; subtitle: string }
  projection?: ReturnType<typeof buildTimeline>
  panels?: ReturnType<typeof buildMeetingPanels>
  initialSelectedId?: string | null
  defaultMeetingId?: string | null
  panelEmptyState?: ReturnType<typeof resolvePanelInitial>["emptyState"]
  actionStrip?: ActionStripView | null
  emptyState: ReturnType<typeof resolveMeetingEmptyState>
}) {
  const hasMeetings = (projection?.totalMeetings ?? 0) > 0
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{header.title}</h1>
        <p className="text-sm text-muted-foreground">{header.subtitle}</p>
      </header>
      {hasMeetings && projection ? (
        <MeetingTimeline
          days={projection.days}
          panels={panels ?? {}}
          initialSelectedId={initialSelectedId}
          defaultMeetingId={defaultMeetingId ?? null}
          emptyState={panelEmptyState ?? null}
          actionStrip={actionStrip ?? null}
        />
      ) : (
        <MeetingEmptyStateView state={emptyState} />
      )}
    </div>
  )
}
