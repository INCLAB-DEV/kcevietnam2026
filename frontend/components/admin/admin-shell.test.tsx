import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"
import type { OperatorMe } from "@/lib/auth/operator-identity"
import type { AdminEvent } from "@/lib/admin/types"

// /admin 콘솔의 "권한 조회 실패" 배너(2026-09-21) — /organizer 콘솔의 회귀(3dba2d2, console-access.ts)와
// 같은 문제를 여기서도 막는다: 실세션인데 /api/admin/me 조회가 실패하면 resolveAdminAccess가 이미
// 최소 권한(read-only)으로 떨어뜨리지만(default-deny), 그게 "확인된 서브어드민"인지 "조회 실패"인지
// 화면이 구분하지 않으면 실 슈퍼관리자가 승인 등 master 전용 버튼이 왜 없는지 모른 채 방치된다.

const EVENT: AdminEvent = {
  id: "evt-current",
  name: "2026 K-콘텐츠 엑스포",
  venue_name: "",
  exhibition_start: "2026-10-20",
  exhibition_end: "2026-10-22",
  application_start: "",
  application_end: "",
  timezone: "Asia/Seoul",
}

const me = vi.hoisted(() => ({ value: null as OperatorMe | null }))
const devOverride = vi.hoisted(() => ({ value: false }))
const cookieJar = vi.hoisted(() => ({ value: new Map<string, string>() }))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.value.has(name) ? { value: cookieJar.value.get(name) } : undefined),
  }),
}))
vi.mock("@/lib/auth/operator-me-client", () => ({
  hasOperatorSession: async () => true,
  fetchOperatorMe: async () => me.value,
}))
vi.mock("@/lib/mock/session-server", () => ({
  devSessionOverrideActive: async () => devOverride.value,
  resolveOrganizerRequestSession: async () => ({
    role: "organizer",
    permissionLevel: "master",
    user: { name: "목업", affiliation: "", email: "", phone: "" },
    tradeOffice: "",
  }),
}))
vi.mock("@/lib/admin/server", () => ({
  adminServerClient: { getEvents: async () => [EVENT] },
}))

function operatorMe(events: OperatorMe["events"]): OperatorMe {
  return { member_id: "m-1", organizer_id: "o-1", name: "운영자", email: null, phone: null, affiliation: null, events }
}

beforeEach(() => {
  me.value = null
  devOverride.value = false
  cookieJar.value = new Map()
})

describe("AdminShell — 권한 조회 실패 배너", () => {
  it("/api/admin/me 조회가 실패(빈 신원)하면 최소 권한이면서 '권한 정보를 확인하지 못했습니다' 배너를 보여준다", async () => {
    me.value = null
    const { AdminShell } = await import("./admin-shell")

    render(await AdminShell({ title: "기업 관리", children: <div data-testid="body" /> }))

    expect(screen.getByText("권한 정보를 확인하지 못했습니다")).toBeInTheDocument()
    // master 전용 액션이 실제로 숨는지는 각 콘솔(예: organizations-console)이 access.canWrite로
    // 가른다 — 여기선 배너와 함께 읽기 전용도 같이 뜨는지만 확인한다(둘 다 같은 default-deny 결과).
    expect(screen.getByText("읽기 전용 모드")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("확인된 서브어드민(그 행사에 sub로 배정됨)은 배너 없이 읽기 전용 안내만 본다", async () => {
    me.value = operatorMe([{ event_id: "evt-current", permission_level: "sub" }])
    const { AdminShell } = await import("./admin-shell")

    render(await AdminShell({ title: "기업 관리", children: <div /> }))

    expect(screen.queryByText("권한 정보를 확인하지 못했습니다")).not.toBeInTheDocument()
    expect(screen.getByText("읽기 전용 모드")).toBeInTheDocument()
  })

  it("확인된 마스터는 배너도 읽기 전용 안내도 없다", async () => {
    me.value = operatorMe([{ event_id: "evt-current", permission_level: "master" }])
    const { AdminShell } = await import("./admin-shell")

    render(await AdminShell({ title: "기업 관리", children: <div /> }))

    expect(screen.queryByText("권한 정보를 확인하지 못했습니다")).not.toBeInTheDocument()
    expect(screen.queryByText("읽기 전용 모드")).not.toBeInTheDocument()
  })
})
