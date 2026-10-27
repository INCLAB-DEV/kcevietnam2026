import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"
import { MOCK_ACCOUNTS, MOCK_ORGANIZER_SUB } from "@/lib/mock/session"
import type { OperatorMe } from "@/lib/auth/operator-identity"
import { isOrganizerPermissionUnknown, resolveOrganizerPermission } from "@/lib/organizer/console-access"

// 참가기업 관리의 권한등급 해석(2026-09-17 정정).
//  ① 실세션에서 /api/admin/me 조회가 실패하면 예전엔 master UI(심사·참가사 탭)를 그렸다 → 최소 권한(sub).
//  ② 등급은 콘솔 데이터가 보는 행사(GET /api/admin/events 첫 행사)의 등급이어야 한다 — 예전엔 /me의
//     첫 배정(가장 오래된 행사)을 읽어, 다른 행사의 master 등급이 이 행사 화면에 새어 들어올 수 있었다.
// 페이지는 실제 console-access를 거치고, 그 아래 신원·세션·행사 해석만 목업으로 바꾼다.

const me = vi.hoisted(() => ({ value: null as OperatorMe | null }))
const devOverride = vi.hoisted(() => ({ value: false }))
const mockSession = vi.hoisted(() => ({ value: null as unknown }))

vi.mock("@/lib/auth/operator-me-client", () => ({
  hasOperatorSession: async () => true,
  fetchOperatorMe: async () => me.value,
}))
vi.mock("@/lib/mock/session-server", () => ({
  devSessionOverrideActive: async () => devOverride.value,
  resolveOrganizerRequestSession: async () => mockSession.value,
}))
vi.mock("@/lib/organizer/http-members-client", () => ({
  resolveOrganizerToken: async () => "session-token",
}))
vi.mock("@/lib/organizer/backend-proxy", () => ({
  resolveEventId: async () => ({ ok: true, value: "evt-current" }),
}))
vi.mock("@/lib/api-client/server", () => ({
  serverApiClient: {
    getMembers: async () => [],
    getMemberProfiles: async () => ({}),
  },
}))
vi.mock("@/components/organizer/members-table", () => ({
  MembersTable: ({ permissionLevel, realSession }: { permissionLevel: string; realSession: boolean }) => (
    <div data-testid="members-table" data-permission={permissionLevel} data-real={String(realSession)} />
  ),
}))

function operatorMe(events: OperatorMe["events"]): OperatorMe {
  return { member_id: "m-1", organizer_id: "o-1", name: "운영자", email: null, phone: null, affiliation: null, events }
}

beforeEach(() => {
  me.value = null
  devOverride.value = false
  mockSession.value = MOCK_ACCOUNTS.organizer
})

describe("OrganizerMembersPage — 권한등급 폴백", () => {
  it("실세션인데 /me 조회가 실패하면 master가 아니라 최소 권한(sub) UI", async () => {
    me.value = null
    const { default: MembersPage } = await import("./page")

    render(await MembersPage())

    expect(screen.getByTestId("members-table")).toHaveAttribute("data-permission", "sub")
    expect(screen.getByTestId("members-table")).toHaveAttribute("data-real", "true")
    expect(screen.getByText("내가 관리하는 바이어를 등록·관리합니다.")).toBeInTheDocument()
  })

  it("콘솔 행사의 master면 master UI(기존 동작)", async () => {
    me.value = operatorMe([{ event_id: "evt-current", permission_level: "master" }])
    const { default: MembersPage } = await import("./page")

    render(await MembersPage())

    expect(screen.getByTestId("members-table")).toHaveAttribute("data-permission", "master")
    expect(screen.getByText("명단을 조회·정정하고, 비즈매칭 신청서를 승인 심사합니다.")).toBeInTheDocument()
  })

  it("다른(오래된) 행사의 master 등급이 이 행사 화면으로 새지 않는다", async () => {
    me.value = operatorMe([
      { event_id: "evt-old", permission_level: "master" },
      { event_id: "evt-current", permission_level: "sub" },
    ])
    const { default: MembersPage } = await import("./page")

    render(await MembersPage())

    expect(screen.getByTestId("members-table")).toHaveAttribute("data-permission", "sub")
  })

  it("dev 목업 sub 스위처는 그대로 sub(목업 관할 필터 포함)", async () => {
    devOverride.value = true
    mockSession.value = MOCK_ORGANIZER_SUB
    const { default: MembersPage } = await import("./page")

    render(await MembersPage())

    expect(screen.getByTestId("members-table")).toHaveAttribute("data-permission", "sub")
    expect(screen.getByTestId("members-table")).toHaveAttribute("data-real", "false")
  })
})

describe("resolveOrganizerPermission — 순수 판정", () => {
  it("목업은 스위처 등급, 없으면 master(기존 dev 기본)", () => {
    expect(resolveOrganizerPermission({ realSession: false, me: null, eventId: null, mockLevel: "sub" })).toBe("sub")
    expect(resolveOrganizerPermission({ realSession: false, me: null, eventId: null })).toBe("master")
  })

  it("실세션은 콘솔 행사의 등급 — 행사를 모르거나 배정이 없으면 sub", () => {
    const m = operatorMe([{ event_id: "evt-a", permission_level: "master" }])
    expect(resolveOrganizerPermission({ realSession: true, me: m, eventId: "evt-a" })).toBe("master")
    expect(resolveOrganizerPermission({ realSession: true, me: m, eventId: "evt-b" })).toBe("sub")
    expect(resolveOrganizerPermission({ realSession: true, me: m, eventId: null })).toBe("sub")
    expect(resolveOrganizerPermission({ realSession: true, me: null, eventId: "evt-a" })).toBe("sub")
  })
})

describe("isOrganizerPermissionUnknown — '확인된 sub' vs '조회 실패로 sub 폴백' 구분(2026-09-21)", () => {
  it("목업은 항상 확인된 값(unknown 아님)", () => {
    expect(isOrganizerPermissionUnknown({ realSession: false, me: null, eventId: null })).toBe(false)
  })

  it("실세션인데 콘솔 행사를 못 구했으면 unknown", () => {
    expect(isOrganizerPermissionUnknown({ realSession: true, me: null, eventId: null })).toBe(true)
  })

  it("실세션인데 /me 조회가 실패했으면(신원 없음) unknown", () => {
    expect(isOrganizerPermissionUnknown({ realSession: true, me: null, eventId: "evt-a" })).toBe(true)
  })

  it("실세션이고 그 행사에 배정이 없으면(다른 행사만 있음) unknown", () => {
    const m = operatorMe([{ event_id: "evt-old", permission_level: "master" }])
    expect(isOrganizerPermissionUnknown({ realSession: true, me: m, eventId: "evt-current" })).toBe(true)
  })

  it("실세션이고 그 행사의 등급(master·sub 무관)을 확인했으면 unknown 아님", () => {
    const m = operatorMe([{ event_id: "evt-a", permission_level: "sub" }])
    expect(isOrganizerPermissionUnknown({ realSession: true, me: m, eventId: "evt-a" })).toBe(false)
  })
})
