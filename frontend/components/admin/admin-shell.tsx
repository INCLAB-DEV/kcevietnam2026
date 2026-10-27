import { cache } from "react"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Eye, TriangleAlert } from "lucide-react"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AdminSidebar } from "./admin-sidebar"
import { EventSwitcher } from "./event-switcher"
import { HelpButton } from "@/components/help/help-button"
import { adminServerClient } from "@/lib/admin/server"
import { ADMIN_EVENT_COOKIE, resolveSelectedEvent } from "@/lib/admin/events"
import { resolveAdminAccess, type AdminAccess } from "@/lib/admin/guard"
import { devSessionOverrideActive, resolveOrganizerRequestSession } from "@/lib/mock/session-server"
import { OPERATOR_FALLBACK_NAME, operatorPermissionLevel, operatorSidebarUser } from "@/lib/auth/operator-identity"
import { fetchOperatorMe, hasOperatorSession } from "@/lib/auth/operator-me-client"
import type { AdminEvent } from "@/lib/admin/types"

// 슈퍼어드민 콘솔 셸. 서비스 셸(components/layout/app-shell)과 같은 shadcn 프리미티브·토큰을
// 쓰되 별도 컴포넌트다 — 기존 셸/nav를 건드리지 않으면서 관리자 전용 구성(7섹션 + 행사 스위처 +
// 권한 배너)을 담기 위해서다.
//
// 여기서 하는 일:
//  ① 신원·등급 해석 — 실 운영자 세션이면 GET /api/admin/me(백엔드 권위), 아니면 목업 세션(dev).
//     /admin 은 ?as와 무관하게 항상 organizer 역할이고, 목업 모드에서만 ?as=organizer-sub가
//     등급을 sub로 가른다(dev 쿠키는 devCookie() 게이트 뒤 — prod에서는 무시된다).
//  ② 권한 판정 — lib/admin/guard. denied면 여기서 리다이렉트(라우트 가드가 이미 역할을 걸렀으므로
//     실질적으로는 방어선이다).
//  ③ 행사 스코프 해석 — 쿠키 하나를 셸과 페이지가 함께 읽어 헤더와 표가 어긋나지 않게 한다.
//
// ⚠ 등급은 계정 전역이 아니라 **계정×행사**다(ADR-0012) — 그래서 등급 판정은 ③(행사 확정) 뒤에
//   온다. 예전엔 목업 세션이 prod에서도 그대로 살아 permissionLevel이 항상 master로 굳었고,
//   실제로는 sub인 운영자가 master UI를 보고 누른 뒤 백엔드에서 403을 맞았다.
//
// 구조(2026-09-17): 크롬(사이드바·헤더·도움말)은 AdminConsoleLayout — app/admin/layout.tsx가 소유하고,
// 페이지는 AdminShell(제목·읽기전용 배너·본문 틀)만 쓴다. 페이지 읽기가 던져도 같은 세그먼트의
// app/admin/error.tsx가 **본문만** 대체해 사이드바·로그아웃이 남는다(예전엔 페이지가 크롬째 사라져
// sub 운영자가 오류 화면에 갇혔다). 레이아웃·AdminShell·페이지가 같은 요청에서 각각 해석을 부르므로
// resolveAdminContext는 React cache()로 1회만 계산한다.

export interface AdminShellContext {
  access: AdminAccess
  event: AdminEvent
  actorName: string // 대리작성·취소 기록에 남길 운영자 표시명
  // 실세션에서 백엔드가 값을 못 주면 빈 문자열 — AdminSidebar가 빈 줄을 통째로 숨긴다.
  // 가짜 이름으로 채우지 않는다(이 값이 감사기록 actorName과 같은 원천이라 더더욱).
  user: { name: string; affiliation: string; email: string }
  // true면 access.kind==="read-only"는 "확인된 서브어드민"이 아니라 **조회 실패로 인한 최소 권한
  // 폴백**이다(/api/admin/me 실패·행사 배정 없음 등). 최소 권한은 그대로 유지하되(승인 등 master
  // 전용 액션은 계속 숨긴다) 배너로 알린다 — /organizer 콘솔(lib/organizer/console-access)과 같은
  // 구분(2026-09-21).
  permissionUnknown: boolean
}

// 페이지가 셸과 **같은 방식으로** 세션·행사를 해석하도록 공유하는 진입점.
// (셸이 따로, 페이지가 따로 해석하면 divergence가 생긴다 — 한 함수를 둘 다 부른다.)
export const resolveAdminContext = cache(resolveAdminContextUncached)

async function resolveAdminContextUncached(): Promise<
  { ok: true; ctx: AdminShellContext; events: AdminEvent[] } | { ok: false; redirectTo: string }
> {
  const jar = await cookies()
  const mockSession = await resolveOrganizerRequestSession()
  // 실 운영자 세션이면 목업으로 되돌아가지 않는다 — 조회 실패는 "빈 신원"이지 다른 사람 이름이 아니다.
  // dev 스위처가 명시적으로 켜져 있으면 목업이 이긴다(proxy.ts와 같은 우선순위) — prod에선 항상 false.
  const realOperator = !(await devSessionOverrideActive()) && (await hasOperatorSession())
  const me = realOperator ? await fetchOperatorMe() : null

  const events = await adminServerClient.getEvents()
  const event = resolveSelectedEvent(events, jar.get(ADMIN_EVENT_COOKIE)?.value)
  // 행사가 하나도 없으면 콘솔이 성립하지 않는다 — 행사 관리로 보내 먼저 만들게 한다.
  if (!event) return { ok: false, redirectTo: "/organizer" }

  // 실세션인데 등급을 모르면(백엔드 조회 실패·그 행사에 배정 없음) undefined를 그대로 넘긴다 —
  // resolveAdminAccess가 default-deny로 서브어드민 취급한다(읽기는 되고 거버넌스 쓰기만 잠긴다).
  const permissionLevel = realOperator
    ? operatorPermissionLevel(me, event.id)
    : mockSession.permissionLevel
  const access = resolveAdminAccess({ role: mockSession.role, permissionLevel })
  if (access.kind === "denied") return { ok: false, redirectTo: access.redirectTo }
  // "확인된 서브어드민"과 "조회 실패로 최소 권한에 떨어짐"을 구분 — 목업은 항상 확인된 값.
  const permissionUnknown = realOperator && permissionLevel === undefined

  const identity = realOperator ? operatorSidebarUser(me) : mockSession.user
  // 감사기록(대리작성·미팅취소)에 박히는 이름 — 실세션에서 이름을 못 받았으면 사람 이름을
  // 지어내는 대신 역할명("운영자")을 쓴다. 목업 인물명이 DB에 남던 결함의 자리다.
  const actorName = realOperator ? (me?.name ?? OPERATOR_FALLBACK_NAME) : mockSession.user.name

  return {
    ok: true,
    ctx: {
      access,
      event,
      actorName,
      user: {
        name: identity.name ?? OPERATOR_FALLBACK_NAME,
        affiliation: identity.affiliation ?? "",
        email: identity.email ?? "",
      },
      permissionUnknown,
    },
    events,
  }
}

// 콘솔 크롬 — app/admin/layout.tsx 전용. 사이드바(nav·행사 스위처·신원·로그아웃)·헤더·도움말을 그리고
// 본문 자리(main)에 페이지(또는 error.tsx)를 받는다.
export async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)

  const { ctx, events } = resolved
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false"
  const readOnly = ctx.access.kind === "read-only"

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AdminSidebar
        user={ctx.user}
        events={events}
        selectedEvent={ctx.event}
        readOnly={readOnly}
      />
      {/* min-w-0: flex 자식이 콘텐츠 min-content 아래로 줄어들 수 있게 해 가로 오버플로우 방지 */}
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mx-1 h-4" />
          {/* 접힌 사이드바에서도 행사를 바꿀 수 있도록 헤더에도 스위처를 둔다(md 이상에서 노출). */}
          <div className="hidden min-w-0 max-w-xs md:block">
            <EventSwitcher events={events} selected={ctx.event} />
          </div>
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {ctx.event.exhibition_start} ~ {ctx.event.exhibition_end}
          </span>
        </header>

        <main className="min-w-0 flex-1 p-4">{children}</main>
      </SidebarInset>
      {/* 상시 도움말(?) — 슈퍼어드민 콘솔은 운영자 surface이므로 organizer 역할 도움말을 띄운다(F-HELP). */}
      <HelpButton role="organizer" />
    </SidebarProvider>
  )
}

// 페이지 본문 틀 — 제목·설명·우상단 액션·읽기 전용 배너. 크롬은 레이아웃(AdminConsoleLayout)이 이미 그렸다.
export async function AdminShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode // 화면 우상단 액션(내보내기·등록 등)
  children: React.ReactNode
}) {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)

  const { ctx } = resolved
  const readOnly = ctx.access.kind === "read-only"

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </header>
        {/* 읽기 전용 계정에는 쓰기 액션 자체를 렌더하지 않는다(숨김 + 서버 재검증). */}
        {!readOnly && actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {/* 권한 조회 실패로 최소 권한에 떨어진 경우 — "확인된 서브어드민"의 안내(아래)와 다른 배너다.
          실 슈퍼관리자가 이유도 모른 채 승인 등 master 전용 액션이 사라진 걸 보지 않게 한다. */}
      {ctx.permissionUnknown && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>권한 정보를 확인하지 못했습니다</AlertTitle>
          <AlertDescription>
            일부 기능이 숨겨질 수 있어요. 새로고침하거나 다시 로그인해 주세요.
          </AlertDescription>
        </Alert>
      )}

      {readOnly && ctx.access.kind === "read-only" && (
        <Alert>
          <Eye />
          <AlertTitle>읽기 전용 모드</AlertTitle>
          <AlertDescription>{ctx.access.notice}</AlertDescription>
        </Alert>
      )}

      {children}
    </div>
  )
}
