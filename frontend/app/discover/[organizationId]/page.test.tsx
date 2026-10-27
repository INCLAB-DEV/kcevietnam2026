import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"
import { MOCK_BUYERS, MOCK_EXHIBITORS } from "@/lib/mock-orgs"

// 기업 상세 풀페이지(/discover/{id})의 "돌아갈 곳"(F-NV-001 D15). 전체 메뉴로 설정한 행사에서는 진입한
// 탐색 탭으로, "미팅만"(기본)에서는 미팅으로 돌아간다 — 그 행사에서 이 화면은 미팅의 "기업 상세 보기"로
// 닿고 기업 탐색은 메뉴에 없다. 뒤로가기 링크와 "열람 불가 → 되돌려 보내기"가 같은 주소를 쓴다.

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))

const request = vi.hoisted(() => ({
  real: null as { role: "buyer" | "exhibitor"; orgId: string | null } | null,
  devMenu: undefined as string | undefined,
  me: null as unknown,
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestSession: async () => ({ role: "buyer", orgId: "buyer-1", user: { name: "목업" } }),
  requestParticipantMenuOverride: async () => request.devMenu,
}))
vi.mock("@/lib/auth/http-session", () => ({ resolveHttpSession: async () => request.real }))
vi.mock("@/lib/auth/me-client", () => ({ fetchMe: async () => request.me }))

const exhibitor = MOCK_EXHIBITORS[0]
const otherBuyer = MOCK_BUYERS[1]
const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  getEventSettings: vi.fn(async () => ({ venueTypes: ["booth"], allowSameRoleDiscovery: false })),
  getViewerOrg: vi.fn(),
  getRecommendations: vi.fn(async () => []),
  getMeetingAvailability: vi.fn(async () => ({})),
}))
vi.mock("@/lib/api-client/server", () => ({ serverApiClient: api }))

vi.mock("@/components/layout/app-shell", () => ({
  AppShellForRequest: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/discover/organization-detail", () => ({
  OrganizationDetail: ({ backHref }: { backHref: string }) => <div data-testid="detail" data-back={backHref} />,
}))

import OrganizationDetailPage from "./page"

function meWithMenu(participant_menu: string) {
  return {
    organization_id: "org-real",
    organization_name: "실기업",
    roles: [
      {
        event_id: "evt-1",
        org_event_role_id: "role-1",
        is_exhibitor: false,
        is_buyer: true,
        buyer_subtype: null,
        application_status: "approved",
        participant_menu,
      },
    ],
  }
}

async function visit(from?: string): Promise<{ redirectedTo: string | null }> {
  try {
    render(
      await OrganizationDetailPage({
        params: Promise.resolve({ organizationId: exhibitor.id }),
        searchParams: Promise.resolve(from ? { from } : {}),
      }),
    )
    return { redirectedTo: null }
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.to }
    throw error
  }
}

beforeEach(() => {
  request.real = { role: "buyer", orgId: "org-real" }
  request.devMenu = undefined
  request.me = meWithMenu("meetings_only")
  api.getOrganization.mockReset()
  api.getOrganization.mockResolvedValue(exhibitor)
  api.getViewerOrg.mockReset()
  api.getViewerOrg.mockResolvedValue(MOCK_BUYERS[0])
})

describe("/discover/{id} — 뒤로가기", () => {
  it.each([undefined, "ai", "bookmarks"])("행사가 '미팅만'이면 진입 탭(from=%s)과 무관하게 미팅으로 돌아간다", async (from) => {
    expect(await visit(from)).toEqual({ redirectedTo: null })
    expect(screen.getByTestId("detail")).toHaveAttribute("data-back", "/meetings")
  })

  it.each([
    [undefined, "/discover?tab=all"],
    ["ai", "/discover?tab=ai"],
    ["bookmarks", "/discover?tab=bookmarks"],
  ])("행사가 '전체 메뉴'면 예전 그대로 진입한 탐색 탭(from=%s)으로 돌아간다", async (from, expected) => {
    request.me = meWithMenu("full")

    expect(await visit(from)).toEqual({ redirectedTo: null })
    expect(screen.getByTestId("detail")).toHaveAttribute("data-back", expected)
  })

  it("목업 세션은 기본값(미팅만) — dev 오버라이드 쿠키가 full이면 탐색으로", async () => {
    request.real = null
    await visit()
    expect(screen.getByTestId("detail")).toHaveAttribute("data-back", "/meetings")
  })

  it("목업 세션 + dev 오버라이드 쿠키 full", async () => {
    request.real = null
    request.devMenu = "full"
    await visit("ai")
    expect(screen.getByTestId("detail")).toHaveAttribute("data-back", "/discover?tab=ai")
  })
})

describe("/discover/{id} — 열람할 수 없는 기업", () => {
  // 같은 역할(바이어→바이어)은 행사 정책상 열람 불가 — 화면을 그리지 않고 "돌아갈 곳"으로 보낸다.
  it("행사가 '미팅만'이면 미팅으로 되돌려 보낸다", async () => {
    api.getOrganization.mockResolvedValue(otherBuyer)

    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
  })

  it("행사가 '전체 메뉴'면 예전 그대로 탐색으로 되돌려 보낸다", async () => {
    request.me = meWithMenu("full")
    api.getOrganization.mockResolvedValue(otherBuyer)

    expect(await visit("ai")).toEqual({ redirectedTo: "/discover?tab=ai" })
  })
})
