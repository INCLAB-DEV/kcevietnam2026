import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_PARTICIPANT_MENU } from "@/lib/event/participant-menu"

// 지금 요청에 적용할 참가자 메뉴(F-NV-001 D15)의 원천 선택:
//   실 세션  → 행사 설정(GET /api/me). dev 오버라이드 쿠키는 보지 않는다.
//   목업 세션 → dev 오버라이드 쿠키, 없으면 기본값.
// 어느 갈래든 값을 알 수 없으면 기본값(미팅만) 하나로 떨어진다.

const me = vi.hoisted(() => ({ fetchMe: vi.fn() }))
vi.mock("@/lib/auth/me-client", () => ({ fetchMe: me.fetchMe }))

const dev = vi.hoisted(() => ({ requestParticipantMenuOverride: vi.fn() }))
vi.mock("@/lib/mock/session-server", () => ({
  requestParticipantMenuOverride: dev.requestParticipantMenuOverride,
}))

import { participantMenuForSession } from "./participant-menu-server"

const BUYER = { role: "buyer", orgId: "org-1" } as const
const EXHIBITOR = { role: "exhibitor", orgId: "org-2" } as const

function meWith(participant_menu: string | null | undefined) {
  return {
    organization_id: "org-1",
    organization_name: "기업",
    roles: [
      {
        event_id: "evt-1",
        org_event_role_id: "role-1",
        is_exhibitor: true,
        is_buyer: true,
        buyer_subtype: null,
        application_status: "approved",
        ...(participant_menu === undefined ? {} : { participant_menu }),
      },
    ],
  }
}

beforeEach(() => {
  me.fetchMe.mockReset()
  dev.requestParticipantMenuOverride.mockReset()
  dev.requestParticipantMenuOverride.mockResolvedValue(undefined)
})

describe("participantMenuForSession — 실 세션", () => {
  it.each([BUYER, EXHIBITOR])("행사 설정이 전체 메뉴면 full ($role)", async (session) => {
    me.fetchMe.mockResolvedValue(meWith("full"))
    await expect(participantMenuForSession(session)).resolves.toBe("full")
  })

  it("행사 설정이 미팅만이면 meetings_only", async () => {
    me.fetchMe.mockResolvedValue(meWith("meetings_only"))
    await expect(participantMenuForSession(BUYER)).resolves.toBe("meetings_only")
  })

  it.each([
    ["/api/me 조회 실패(null)", null],
    ["구 백엔드 — 필드 없음", meWith(undefined)],
    ["필드가 null", meWith(null)],
    ["모르는 값", meWith("everything")],
    ["역할 행이 없음", { organization_id: "org-1", organization_name: "기업", roles: [] }],
  ])("%s → 기본값(미팅만)", async (_label, response) => {
    me.fetchMe.mockResolvedValue(response)
    await expect(participantMenuForSession(BUYER)).resolves.toBe(DEFAULT_PARTICIPANT_MENU)
    expect(DEFAULT_PARTICIPANT_MENU).toBe("meetings_only")
  })

  it("dev 오버라이드 쿠키는 실 세션에 적용하지 않는다 — 행사 설정이 권위다", async () => {
    dev.requestParticipantMenuOverride.mockResolvedValue("full")
    me.fetchMe.mockResolvedValue(meWith("meetings_only"))

    await expect(participantMenuForSession(BUYER)).resolves.toBe("meetings_only")
    expect(dev.requestParticipantMenuOverride).not.toHaveBeenCalled()
  })
})

describe("participantMenuForSession — 목업 세션(실 세션 없음)", () => {
  it("아무것도 없으면 기본값(미팅만)이고 /api/me를 부르지 않는다", async () => {
    await expect(participantMenuForSession(null)).resolves.toBe(DEFAULT_PARTICIPANT_MENU)
    expect(me.fetchMe).not.toHaveBeenCalled()
  })

  it("dev 오버라이드 쿠키가 full이면 전체 메뉴 — 메뉴 5개를 전제하는 dev 화면은 이렇게 명시한다", async () => {
    dev.requestParticipantMenuOverride.mockResolvedValue("full")
    await expect(participantMenuForSession(null)).resolves.toBe("full")
  })

  it("dev 오버라이드 쿠키가 meetings_only면 그대로", async () => {
    dev.requestParticipantMenuOverride.mockResolvedValue("meetings_only")
    await expect(participantMenuForSession(null)).resolves.toBe("meetings_only")
  })

  it("쿠키 값이 어휘 밖이면 기본값이다", async () => {
    dev.requestParticipantMenuOverride.mockResolvedValue("5-menus")
    await expect(participantMenuForSession(null)).resolves.toBe(DEFAULT_PARTICIPANT_MENU)
  })
})
