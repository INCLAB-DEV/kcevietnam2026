import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { MeetingStatusCard } from "@/components/home/meeting-status-card"
import { TodayScheduleCard } from "@/components/home/today-schedule-card"
import { NotificationCard } from "@/components/home/notification-card"
import { buildHomeDashboardData } from "@/lib/home/home-dashboard-data"
import { latestNotifications } from "@/lib/home/notification"
import { AutoRefresh } from "@/components/layout/auto-refresh"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { participantMenuForSession } from "@/lib/auth/participant-menu-server"
import { participantHomePath } from "@/lib/event/participant-menu"
import { serverApiClient } from "@/lib/api-client/server"
import type { ViewerRole } from "@/lib/types"

export const dynamic = "force-dynamic"

function kstToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
}

// 세션은 쿠키 단일 소스(resolveRequestSession)에서 읽는다. dev 계정 전환은 proxy가 ?as→쿠키로 처리.
// dev 전용 ?empty — 오늘 일정·알림을 빈 상태로 강제(HM-001-03/04 캡처용). prod에선 무시.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ empty?: string }>
}) {
  const { empty } = await searchParams
  const devEmpty = process.env.NODE_ENV !== "production" && empty != null
  const session = await resolveRequestSession()
  const t = await getTranslations("home")

  // 운영사 랜딩은 운영 대시보드(OP-001) 별개 (PRD D6). HM-001은 참가측(바이어/참가사) 전용.
  if (session.role === "organizer") redirect("/organizer")

  // 실 세션이면 그 역할·org를, 아니면 기존 mock/dev 세션(?as=)을 쓴다
  // (app/meetings/page.tsx·app/discover/page.tsx와 동일 패턴, lib/auth/http-session.ts).
  const realSession = await resolveHttpSession()
  // 행사의 참가자 메뉴가 "미팅만"이면(F-NV-001 D15 — 기본값) 대시보드는 메뉴에 없다 — 여기로 온 참가자를
  // 미팅으로 보낸다. "/"를 도착지로 쓰는 다른 동선(역할 불일치 리다이렉트·쿠키 재동기화의 기본 next·승인
  // 알림)은 고치지 않아도 여기를 거쳐 미팅에 닿는다. 이 대시보드는 전체 메뉴("full")로 설정한 행사에서만
  // 그려진다 — 목업 세션으로 보려면 dev 오버라이드 쿠키를 full로 둔다(lib/mock/session.ts DEV_MENU_COOKIE).
  const home = participantHomePath(await participantMenuForSession(realSession))
  if (home !== "/") redirect(home)
  const viewerRole: ViewerRole = realSession?.role ?? session.role
  const viewerOrgId = realSession ? (realSession.orgId ?? session.orgId) : session.orgId
  // 인사말 이름도 실 세션이면 /api/me 신원으로 — 사이드바(app-shell)와 같은 원천(fetchMe는 요청당 1회 캐시).
  const me = realSession ? await fetchMe() : null
  const greetingName = me?.member_name ?? session.user.name

  const today = kstToday()
  const viewer = { role: viewerRole, orgId: viewerOrgId }
  // 읽기는 전부 api-client seam 경유(ADR-0008). 화면은 받은 입력을 순수 투영만 한다.
  const [homeInput, notificationFeed] = await Promise.all([
    serverApiClient.getHomeDashboard(viewer, today),
    serverApiClient.getHomeNotifications(viewer, today),
  ])
  const data = buildHomeDashboardData(homeInput)
  const todaySchedule = devEmpty ? [] : data.todaySchedule
  const notifications = devEmpty ? [] : latestNotifications(notificationFeed)
  // 처리할 일 = 내가 수락해야 하는 받은 요청 + 작성해야 하는 회의록 (보낸 요청은 상대 차례라 제외)
  const todoCount = data.statusRollup.receivedRequests + data.statusRollup.pendingReview

  return (
    <AppShellForRequest>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {/* 상대가 수락·거절해도 홈은 스스로 갱신되지 않는다(폴링·SSE 없음) — 탭 복귀·포커스·
            30초 주기로 이 페이지를 다시 그려 오늘 일정·알림을 서버에서 새로 받는다. */}
        <AutoRefresh />
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("greeting", { name: greetingName })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("summary", { meetingCount: todaySchedule.length, todoCount })}
          </p>
        </header>

        {/* ① 미팅 현황 — 전체 그림(hero) */}
        <MeetingStatusCard rollup={data.statusRollup} />

        {/* ② 오늘 일정 · ④ 알림(할 일) — 액션 중심 2단 */}
        <div className="grid gap-4 md:grid-cols-2">
          <TodayScheduleCard meetings={todaySchedule} />
          <NotificationCard notifications={notifications} />
        </div>
      </div>
    </AppShellForRequest>
  )
}
