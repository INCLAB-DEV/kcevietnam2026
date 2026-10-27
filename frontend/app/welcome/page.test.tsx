import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"
import { REFRESHED_COOKIE, STATUS_COOKIE } from "@/lib/auth/session-cookie"

// /welcome(HM-002)의 입장 동선 — 승인된 참가자를 본 서비스로 보낼 때의 도착 화면(F-NV-001 D15).
// 행사의 참가자 메뉴가 "미팅만"(기본)이면 미팅(/meetings), 전체 메뉴면 홈(/)이다. 도착 화면을 쓰는 곳이
// 셋이라 셋이 같은 값을 쓰는지 고정한다:
//   ① 쿠키가 이미 approved → 곧장 리다이렉트
//   ② 쿠키가 아직 옛 상태   → 쿠키 재동기화 라우트의 next
//   ③ 재동기화도 실패(마커)  → 안내 카드의 입장 버튼(degrade)
// 루프 방지 규칙(FE ADR-0002) 자체는 건드리지 않았다 — 어디로 보내는지만 갈린다.

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
  getLocale: async () => "ko",
}))

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  mock: { role: "buyer", orgId: "buyer-1", applicationStatus: "approved", user: { name: "목업", affiliation: "", email: "", phone: "" } } as {
    role: string
    orgId: string
    applicationStatus?: string
    user: { name: string; affiliation: string; email: string; phone: string }
  },
  real: null as { role: "buyer" | "exhibitor"; orgId: string | null } | null,
  devMenu: undefined as string | undefined,
  me: null as unknown,
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestSession: async () => request.mock,
  requestPeriodOverride: async () => undefined,
  requestParticipantMenuOverride: async () => request.devMenu,
}))
vi.mock("@/lib/auth/http-session", () => ({ resolveHttpSession: async () => request.real }))
vi.mock("@/lib/auth/me-client", () => ({ fetchMe: async () => request.me }))

// 카드 주변 조각은 관심사가 아니다. 도움말 버튼만 받은 참가자 메뉴를 표시로 남긴다(셸 밖 화면이라 prop으로 받는다).
vi.mock("@/components/auth/event-brand-panel", () => ({ EventBrandPanel: () => null }))
vi.mock("@/components/auth/logout-button", () => ({ LogoutButton: () => null }))
vi.mock("@/components/welcome/application-actions", () => ({ ApplicationActions: () => null }))
vi.mock("@/components/help/help-button", () => ({
  HelpButton: ({ participantMenu }: { participantMenu?: string }) => (
    <div data-testid="help" data-menu={participantMenu ?? "(none)"} />
  ),
}))

function approvedMe(participant_menu: string | undefined) {
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

// 신청기간 env(BM_APPLICATION_*)는 페이지 모듈이 로드될 때 읽힌다 — 기간을 바꿔 보려면 env를 바꾼 뒤
// 모듈을 다시 불러야 한다. periodClosed: 신청기간이 끝난 상태(카드 푸터가 신청서 액션 대신 입장 버튼을 그린다).
async function visit({ periodClosed = false } = {}): Promise<{ redirectedTo: string | null }> {
  vi.resetModules()
  if (periodClosed) {
    vi.stubEnv("BM_APPLICATION_OPENS_AT", "2000-01-01")
    vi.stubEnv("BM_APPLICATION_CLOSES_AT", "2000-01-02")
  }
  const { default: WelcomePage } = await import("./page")
  try {
    render(await WelcomePage({ searchParams: Promise.resolve({}) }))
    return { redirectedTo: null }
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.to }
    throw error
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  request.cookies.clear()
  request.mock = { role: "buyer", orgId: "buyer-1", applicationStatus: "approved", user: { name: "목업", affiliation: "", email: "", phone: "" } }
  request.real = null
  request.devMenu = undefined
  request.me = null
})

const CASES = [
  ["미팅만", "meetings_only", "/meetings"],
  ["전체 메뉴", "full", "/"],
] as const

describe.each(CASES)("/welcome — 승인된 실 세션, 행사 설정 '%s'", (_label, menu, home) => {
  beforeEach(() => {
    request.real = { role: "exhibitor", orgId: "org-real" }
    request.me = approvedMe(menu)
  })

  it(`① 쿠키가 approved면 곧장 ${home}(으)로 보낸다`, async () => {
    request.cookies.set(STATUS_COOKIE, "approved")

    expect(await visit()).toEqual({ redirectedTo: home })
  })

  it("② 쿠키가 옛 상태면 재동기화 라우트를 거치고, next가 같은 도착 화면이다", async () => {
    request.cookies.set(STATUS_COOKIE, "submitted")

    expect(await visit()).toEqual({ redirectedTo: `/api/auth/refresh?next=${home}` })
  })

  it("③ 재동기화가 이미 실패했으면(마커) 리다이렉트하지 않고, 입장 버튼이 같은 도착 화면을 가리킨다", async () => {
    request.cookies.set(STATUS_COOKIE, "submitted")
    request.cookies.set(REFRESHED_COOKIE, "1")

    expect(await visit({ periodClosed: true })).toEqual({ redirectedTo: null })
    // 번역기 대역이 키를 그대로 돌려주므로 버튼 이름은 메시지 키다.
    expect(screen.getByRole("link", { name: "enterService.cta" })).toHaveAttribute("href", home)
  })

  it("도움말에는 같은 메뉴 값이 넘어간다 — 셸 밖 화면이라 prop으로 받는다", async () => {
    request.cookies.set(STATUS_COOKIE, "submitted")
    request.cookies.set(REFRESHED_COOKIE, "1")

    await visit()

    expect(screen.getByTestId("help")).toHaveAttribute("data-menu", menu)
  })
})

describe("/welcome — 값을 알 수 없을 때", () => {
  it("구 백엔드(응답에 필드 없음)는 기본값(미팅만) — /meetings로 보낸다", async () => {
    request.real = { role: "buyer", orgId: "org-real" }
    request.me = approvedMe(undefined)
    request.cookies.set(STATUS_COOKIE, "approved")

    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
  })

  it("목업 세션(dev)은 기본값(미팅만) — /meetings로 보낸다", async () => {
    request.cookies.set(STATUS_COOKIE, "approved")

    expect(await visit()).toEqual({ redirectedTo: "/meetings" })
  })

  it("목업 세션에 dev 오버라이드 쿠키가 full이면 홈(/)으로 보낸다", async () => {
    request.devMenu = "full"
    request.cookies.set(STATUS_COOKIE, "approved")

    expect(await visit()).toEqual({ redirectedTo: "/" })
  })
})

describe("/welcome — 아직 승인 전", () => {
  it("입장 동선을 타지 않는다(참가자 메뉴와 무관 — 기존 동작)", async () => {
    request.real = { role: "buyer", orgId: "org-real" }
    request.me = {
      ...approvedMe("meetings_only"),
      roles: [{ ...approvedMe("meetings_only").roles[0], application_status: "submitted" }],
    }
    request.cookies.set(STATUS_COOKIE, "submitted")

    expect(await visit()).toEqual({ redirectedTo: null })
  })
})
