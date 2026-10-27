import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"

// "/"(HM-001 대시보드)의 도착지 규칙(F-NV-001 D15). 행사의 참가자 메뉴가 "미팅만"(기본)이면 대시보드가
// 메뉴에 없으므로 여기로 온 참가자를 /meetings로 보낸다 — "/"를 도착지로 쓰는 다른 동선(역할 불일치
// 리다이렉트·쿠키 재동기화의 기본 next·승인 알림)이 전부 이 리다이렉트를 거쳐 미팅에 닿는다.
// 전체 메뉴로 설정한 행사는 예전 그대로 대시보드를 그린다.
//
// 값의 원천 선택(실 세션 = /api/me, 목업 = dev 쿠키/기본값)은 실제 헬퍼를 그대로 태우고, 그 아래의
// 입출력(fetchMe·쿠키·api-client)만 대역으로 바꾼다.

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}))

const session = vi.hoisted(() => ({
  mock: { role: "buyer", orgId: "buyer-1", user: { name: "목업바이어" } } as {
    role: string
    orgId: string
    user: { name: string }
  },
  real: null as { role: "buyer" | "exhibitor"; orgId: string | null } | null,
  devMenu: undefined as string | undefined,
  me: null as unknown,
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestSession: async () => session.mock,
  requestParticipantMenuOverride: async () => session.devMenu,
}))
vi.mock("@/lib/auth/http-session", () => ({ resolveHttpSession: async () => session.real }))
vi.mock("@/lib/auth/me-client", () => ({ fetchMe: async () => session.me }))

const api = vi.hoisted(() => ({
  getHomeDashboard: vi.fn(async (viewer: { role: string; orgId: string }, today: string) => ({
    viewerRole: viewer.role,
    viewerOrgId: viewer.orgId,
    meetings: [],
    today,
  })),
  getHomeNotifications: vi.fn(async () => []),
}))
vi.mock("@/lib/api-client/server", () => ({ serverApiClient: api }))

// 셸·카드는 이 테스트의 관심사가 아니다 — 대시보드가 그려졌는지만 표시로 남긴다.
vi.mock("@/components/layout/app-shell", () => ({
  AppShellForRequest: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard">{children}</div>,
}))
vi.mock("@/components/layout/auto-refresh", () => ({ AutoRefresh: () => null }))
vi.mock("@/components/home/meeting-status-card", () => ({ MeetingStatusCard: () => null }))
vi.mock("@/components/home/today-schedule-card", () => ({ TodayScheduleCard: () => null }))
vi.mock("@/components/home/notification-card", () => ({ NotificationCard: () => null }))

import Page from "./page"

function meWithMenu(participant_menu: string | undefined) {
  return {
    organization_id: "org-real",
    organization_name: "실기업",
    member_name: "실담당자",
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

async function visit(): Promise<{ redirectedTo: string | null }> {
  try {
    render(await Page({ searchParams: Promise.resolve({}) }))
    return { redirectedTo: null }
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.to }
    throw error
  }
}

beforeEach(() => {
  session.mock = { role: "buyer", orgId: "buyer-1", user: { name: "목업바이어" } }
  session.real = null
  session.devMenu = undefined
  session.me = null
  api.getHomeDashboard.mockClear()
  api.getHomeNotifications.mockClear()
})

describe("/ — 실 세션", () => {
  it.each(["buyer", "exhibitor"] as const)("%s: 행사가 '미팅만'이면 /meetings로 보낸다(대시보드 데이터를 읽지 않는다)", async (role) => {
    session.real = { role, orgId: "org-real" }
    session.me = meWithMenu("meetings_only")

    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
    expect(api.getHomeDashboard).not.toHaveBeenCalled()
  })

  it.each(["buyer", "exhibitor"] as const)("%s: 행사가 '전체 메뉴'면 예전 그대로 대시보드를 그린다", async (role) => {
    session.real = { role, orgId: "org-real" }
    session.me = meWithMenu("full")

    expect(await visit()).toEqual({ redirectedTo: null })
    expect(screen.getByTestId("dashboard")).toBeInTheDocument()
    expect(api.getHomeDashboard).toHaveBeenCalledOnce()
  })

  it.each([
    ["구 백엔드(응답에 필드 없음)", meWithMenu(undefined)],
    ["/api/me 조회 실패", null],
  ])("%s → 기본값(미팅만)이라 /meetings로 보낸다", async (_label, me) => {
    session.real = { role: "buyer", orgId: "org-real" }
    session.me = me

    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
  })
})

describe("/ — 목업 세션(dev)", () => {
  it("아무 설정도 없으면 기본값(미팅만)이라 /meetings로 보낸다", async () => {
    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
  })

  it("dev 오버라이드 쿠키가 full이면 목업 대시보드를 그린다", async () => {
    session.devMenu = "full"

    expect(await visit()).toEqual({ redirectedTo: null })
    expect(screen.getByTestId("dashboard")).toBeInTheDocument()
  })
})

describe("/ — 운영자", () => {
  it("참가자 메뉴와 무관하게 운영 대시보드로 보낸다(기존 동작)", async () => {
    session.mock = { role: "organizer", orgId: "org-1", user: { name: "운영자" } }
    session.devMenu = "full"

    expect(await visit()).toEqual({ redirectedTo: "/organizer" })
  })
})
