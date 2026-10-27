import { cookies } from "next/headers"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar, type SidebarUser } from "@/components/app-sidebar"
import { HelpButton } from "@/components/help/help-button"
import { OrgDetailProvider } from "@/components/discover/org-detail-modal"
import { MeetingRequestProvider } from "@/components/meeting/meeting-request-provider"
import { devSessionOverrideActive, resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchUnreadNotificationCount } from "@/lib/home/http-notifications-client"
import { fetchMe } from "@/lib/auth/me-client"
import { resolveSidebarUser } from "@/lib/auth/sidebar-user"
import { fetchOperatorMe, hasOperatorSession } from "@/lib/auth/operator-me-client"
import { operatorSidebarUser } from "@/lib/auth/operator-identity"
import { LOCALE_COOKIE_NAME, resolveLocale } from "@/lib/i18n/config"
import { participantMenuForSession } from "@/lib/auth/participant-menu-server"
import { DEFAULT_PARTICIPANT_MENU, type ParticipantMenu } from "@/lib/event/participant-menu"
import type { MockSession, PermissionLevel } from "@/lib/mock/session"
import { ParticipantMenuProvider } from "./participant-menu-provider"
import type { UserRole } from "./nav"

interface AppShellProps {
  role: UserRole
  user: SidebarUser
  orgId?: string // 있으면 nav 알림 항목에 org 안읽음 배지 노출 (NT-001)
  // 실 세션의 실 unread_count(P1-3). 있으면 클라 mock 스토어(useUnreadCount) 대신 이 값을 배지로
  // 쓴다 — 없음(undefined)이면 기존 mock 스토어 구독(하위 호환).
  unreadCount?: number
  defaultOpen: boolean
  breadcrumb?: React.ReactNode // 상세 페이지의 위치·복귀 동선(예: 미팅 / 미팅 회의록). 없으면 헤더는 토글만.
  permissionLevel?: PermissionLevel // 운영자 등급 — nav의 master 전용 항목 노출(AppSidebar 참고)
  // 이 행사의 참가자 메뉴(F-NV-001 D15) — "미팅만"이면 참가사·바이어 nav가 미팅 한 항목이 된다.
  // 생략하면 기본값(DEFAULT_PARTICIPANT_MENU = 미팅만). 운영자 셸에는 이 값을 읽는 조각이 없다
  // (운영자 nav는 역할·권한등급으로만 갈린다).
  participantMenu?: ParticipantMenu
  children: React.ReactNode
}

// 표현(presentational) 셸 — 세션/쿠키를 모른다. 입력(role/user/orgId/defaultOpen)만 받아 렌더.
// auth/세션 해석은 AppShellForRequest가 담당 → 나중에 진짜 (app)/layout으로 옮겨도 이 컴포넌트는 그대로 재사용.
export function AppShell({
  role,
  user,
  orgId,
  unreadCount,
  defaultOpen,
  breadcrumb,
  permissionLevel,
  participantMenu = DEFAULT_PARTICIPANT_MENU,
  children,
}: AppShellProps) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      {/* 참가자 메뉴를 셸 안쪽 전체에 내려준다 — 사이드바는 prop으로, 그보다 깊은 조각(미팅 빈 상태
          패널·기업 상세 액션·도움말)은 useParticipantMenu()로 같은 값을 읽는다. */}
      <ParticipantMenuProvider value={participantMenu}>
        <AppSidebar
          role={role}
          user={user}
          orgId={orgId}
          unreadOverride={unreadCount}
          permissionLevel={permissionLevel}
          participantMenu={participantMenu}
        />
        {/* min-w-0: flex 자식이 콘텐츠 min-content 아래로 줄어들 수 있게 해 가로 오버플로우 방지 */}
        <SidebarInset className="min-w-0">
          {/* 모바일 전용 상단바: 오프캔버스 sheet를 여는 트리거.
              데스크톱은 사이드바 헤더의 토글을 쓰므로 상단바를 숨긴다(md:hidden). */}
          <header className="flex h-12 items-center border-b px-4 md:hidden">
            <SidebarTrigger className="-ml-1" />
            {breadcrumb ? (
              <>
                <Separator orientation="vertical" className="mx-2 h-4" />
                {breadcrumb}
              </>
            ) : null}
          </header>
          {/* 상세(DV-002)·미팅 신청(F-MT-001) 모달 호스트 — 어느 페이지든 useOrgDetail()/
              useMeetingRequest()로 같은 모달을 연다. 미팅 호스트가 상위(상세 모달 안 액션바도 접근). */}
          <main className="min-w-0 flex-1 p-4">
            <MeetingRequestProvider>
              <OrgDetailProvider>{children}</OrgDetailProvider>
            </MeetingRequestProvider>
          </main>
        </SidebarInset>
        {/* 상시 도움말(?) — 현재 화면·역할에 맞는 가이드 패널을 여는 우하단 FAB(F-HELP).
            SidebarProvider 래퍼(transform 없음) 안이라 position:fixed가 뷰포트 기준으로 뜬다. */}
        <HelpButton role={role} />
      </ParticipantMenuProvider>
    </SidebarProvider>
  )
}

// 요청 단위 셸 래퍼 — 쿠키에서 세션·접힘상태를 읽어 dumb AppShell에 주입한다.
// 페이지는 <AppShellForRequest>{본문}</AppShellForRequest>만 쓰면 nav/세션이 자동 연결된다(props 반복 X).
// session override: organizer처럼 ?as와 무관하게 고정 세션이어야 하는 라우트에 명시적으로 넘긴다.
// breadcrumb: 상세 페이지가 헤더 복귀 동선을 끼울 때 넘긴다(예: 미팅 회의록).
// permissionLevel: 운영자 셸(app/organizer/layout.tsx)이 이 행사의 등급을 넘긴다 — nav의 master 전용 항목.
export async function AppShellForRequest({
  session,
  breadcrumb,
  permissionLevel,
  children,
}: {
  session?: MockSession
  breadcrumb?: React.ReactNode
  permissionLevel?: PermissionLevel
  children: React.ReactNode
}) {
  const resolved = session ?? (await resolveRequestSession())
  const jar = await cookies()
  const defaultOpen = jar.get("sidebar_state")?.value !== "false"
  // 실 unread_count(P1-3) — 호출부가 명시적으로 session(mock 고정 세션: organizer·profile 등)을
  // 넘긴 라우트는 아직 실 세션 대상이 아니라 건너뛴다(참가자 실 화면과 동일 판정 기준,
  // lib/auth/http-session.ts). 백엔드 미가동 등 실패는 조용히 무시 — 배지 없이 기존처럼 렌더.
  const realSession = session ? null : await resolveHttpSession()
  // 참가자 메뉴(F-NV-001 D15) — 실 세션이면 행사 설정(/api/me), 목업 세션이면 dev 오버라이드 쿠키나
  // 기본값(미팅만). "미팅만"이면 nav에 알림 항목이 없어 배지를 그릴 자리도 없으므로 안읽음 수 조회를
  // 건너뛴다(요청 1회 절약).
  const participantMenu = await participantMenuForSession(realSession)
  const unreadCount =
    realSession && participantMenu !== "meetings_only"
      ? await fetchUnreadNotificationCount().catch(() => undefined)
      : undefined
  // 실 세션 신원(사이드바) — /api/me로 조회, 실패·필드 미제공은 resolveSidebarUser가 null로
  // 안전 폴백한다(해당 줄만 숨김, mock 세션의 다른 인물 정보로 대체하지 않는다). mock 세션은
  // 기존 그대로 resolved.user를 쓴다(mock 모드 보존 원칙).
  //
  // 운영자는 갈래가 하나 더 있다. /organizer/* 는 셸에 고정 organizer 세션을 넘기므로(위 session
  // override) 위 realSession은 항상 null이고, 예전엔 그래서 **prod에서도** 목업 인물("정세훈 /
  // 2026 베트남 K-콘텐츠 엑스포 사무국")이 그대로 사이드바에 찍혔다. 운영자 신원의 원천은
  // 참가자용 /api/me가 아니라 /api/admin/me다(운영자는 org 소속 참가 주체가 아니라 organizers
  // 계정 — lib/auth/operator-me-client.ts 참고). 실 운영자 세션이면 목업으로 되돌아가지 않는다:
  // 조회가 실패해도 빈 신원(줄 숨김)이지 가짜 이름이 아니다.
  const locale = resolveLocale(jar.get(LOCALE_COOKIE_NAME)?.value)
  // dev 스위처가 명시적으로 켜져 있으면 목업이 이긴다(proxy.ts의 우선순위 규칙과 동일) —
  // prod에서는 devSessionOverrideActive()가 항상 false라 실 세션만 남는다.
  const realOperator =
    resolved.role === "organizer" && !(await devSessionOverrideActive()) && (await hasOperatorSession())
  const user: SidebarUser = realOperator
    ? operatorSidebarUser(await fetchOperatorMe())
    : realSession
      ? resolveSidebarUser(await fetchMe(), locale)
      : resolved.user
  return (
    <AppShell
      role={resolved.role}
      user={user}
      orgId={resolved.orgId}
      unreadCount={unreadCount}
      defaultOpen={defaultOpen}
      breadcrumb={breadcrumb}
      permissionLevel={permissionLevel}
      participantMenu={participantMenu}
    >
      {children}
    </AppShell>
  )
}
