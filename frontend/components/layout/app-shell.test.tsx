import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"

// 셸(AppShellForRequest)이 참가자 메뉴(F-NV-001 D15)를 구해 내려주는 배선. 값은 서버에서 한 번 구해
//   · 사이드바에는 prop으로(nav 항목·비밀번호 변경 진입점이 갈린다),
//   · 셸 안쪽 조각(미팅 빈 상태 패널·기업 상세 액션·도움말)에는 컨텍스트로
// 같은 값이 간다. "미팅만"이면 nav에 알림 항목이 없으므로 안읽음 수 조회도 건너뛴다.

const request = vi.hoisted(() => ({
  mock: {
    role: "buyer",
    orgId: "buyer-1",
    user: { name: "목업바이어", affiliation: "목업기업", email: "mock@example.com", phone: "010-0000-0000" },
  } as { role: string; orgId: string; user: { name: string; affiliation: string; email: string; phone: string } },
  real: null as { role: "buyer" | "exhibitor"; orgId: string | null } | null,
  devMenu: undefined as string | undefined,
  me: null as unknown,
}))
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestSession: async () => request.mock,
  devSessionOverrideActive: async () => false,
  requestParticipantMenuOverride: async () => request.devMenu,
}))
vi.mock("@/lib/auth/http-session", () => ({ resolveHttpSession: async () => request.real }))
vi.mock("@/lib/auth/me-client", () => ({ fetchMe: async () => request.me }))
vi.mock("@/lib/auth/operator-me-client", () => ({
  hasOperatorSession: async () => false,
  fetchOperatorMe: async () => null,
}))
const notifications = vi.hoisted(() => ({ fetchUnreadNotificationCount: vi.fn(async () => 7) }))
vi.mock("@/lib/home/http-notifications-client", () => notifications)

// 셸이 넘긴 값을 그대로 드러내는 대역 — 사이드바는 prop, 본문 조각은 컨텍스트를 읽는다.
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: (props: { role: string; participantMenu?: string; unreadOverride?: number }) => (
    <div
      data-testid="sidebar"
      data-role={props.role}
      data-menu={props.participantMenu ?? "(none)"}
      data-unread={props.unreadOverride === undefined ? "(none)" : String(props.unreadOverride)}
    />
  ),
}))
vi.mock("@/components/help/help-button", () => ({ HelpButton: () => null }))
vi.mock("@/components/discover/org-detail-modal", () => ({
  OrgDetailProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/meeting/meeting-request-provider", () => ({
  MeetingRequestProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { AppShellForRequest } from "./app-shell"
import { useParticipantMenu } from "./participant-menu-provider"

function ContextProbe() {
  return <div data-testid="context" data-menu={useParticipantMenu()} />
}

function meWithMenu(participant_menu: string | undefined) {
  return {
    organization_id: "org-real",
    organization_name: "실기업",
    roles: [
      {
        event_id: "evt-1",
        org_event_role_id: "role-1",
        is_exhibitor: true,
        is_buyer: true,
        buyer_subtype: null,
        application_status: "approved",
        ...(participant_menu ? { participant_menu } : {}),
      },
    ],
  }
}

async function renderShell(props: Partial<Parameters<typeof AppShellForRequest>[0]> = {}) {
  render(
    await AppShellForRequest({
      ...props,
      children: <ContextProbe />,
    }),
  )
  return {
    sidebar: screen.getByTestId("sidebar"),
    context: screen.getByTestId("context"),
  }
}

beforeEach(() => {
  request.real = null
  request.devMenu = undefined
  request.me = null
  notifications.fetchUnreadNotificationCount.mockClear()
})

describe("AppShellForRequest — 참가자 메뉴", () => {
  it.each(["buyer", "exhibitor"] as const)("실 세션(%s)·행사 '미팅만': 사이드바와 컨텍스트에 같은 값, 안읽음 수는 조회하지 않는다", async (role) => {
    request.real = { role, orgId: "org-real" }
    request.me = meWithMenu("meetings_only")

    const { sidebar, context } = await renderShell()

    expect(sidebar).toHaveAttribute("data-menu", "meetings_only")
    expect(context).toHaveAttribute("data-menu", "meetings_only")
    expect(notifications.fetchUnreadNotificationCount).not.toHaveBeenCalled()
    expect(sidebar).toHaveAttribute("data-unread", "(none)")
  })

  it("실 세션·행사 '전체 메뉴': 전체 메뉴로 내려가고 안읽음 수를 예전처럼 조회한다", async () => {
    request.real = { role: "buyer", orgId: "org-real" }
    request.me = meWithMenu("full")

    const { sidebar, context } = await renderShell()

    expect(sidebar).toHaveAttribute("data-menu", "full")
    expect(context).toHaveAttribute("data-menu", "full")
    expect(notifications.fetchUnreadNotificationCount).toHaveBeenCalledOnce()
    expect(sidebar).toHaveAttribute("data-unread", "7")
  })

  it.each([
    ["구 백엔드(응답에 필드 없음)", meWithMenu(undefined)],
    ["/api/me 조회 실패", null],
  ])("실 세션·%s → 기본값(미팅만)", async (_label, me) => {
    request.real = { role: "exhibitor", orgId: "org-real" }
    request.me = me

    const { sidebar, context } = await renderShell()

    expect(sidebar).toHaveAttribute("data-menu", "meetings_only")
    expect(context).toHaveAttribute("data-menu", "meetings_only")
  })

  it("목업 세션: 기본값(미팅만)", async () => {
    const { sidebar, context } = await renderShell()

    expect(sidebar).toHaveAttribute("data-menu", "meetings_only")
    expect(context).toHaveAttribute("data-menu", "meetings_only")
    expect(notifications.fetchUnreadNotificationCount).not.toHaveBeenCalled()
  })

  it("목업 세션 + dev 오버라이드 쿠키 full: 전체 메뉴", async () => {
    request.devMenu = "full"

    const { sidebar, context } = await renderShell()

    expect(sidebar).toHaveAttribute("data-menu", "full")
    expect(context).toHaveAttribute("data-menu", "full")
  })

  it("페이지가 목업 세션을 명시해 넘긴 셸은 실 세션 쿠키가 있어도 행사 설정을 읽지 않는다(기존 판정 그대로)", async () => {
    request.real = { role: "buyer", orgId: "org-real" }
    request.me = meWithMenu("full")

    const { sidebar } = await renderShell({ session: request.mock as never })

    // session을 넘긴 셸은 실 세션 대상이 아니다 — 목업 갈래(dev 쿠키/기본값)를 탄다.
    expect(sidebar).toHaveAttribute("data-menu", "meetings_only")
  })
})
