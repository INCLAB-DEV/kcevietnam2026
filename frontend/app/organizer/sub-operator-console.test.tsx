import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { render, screen } from "@/lib/test/render-with-intl"
import { OperatorHttpError, OPERATOR_FORBIDDEN_DIGEST } from "@/lib/auth/operator-errors"
import { aggregateOpsMetrics } from "@/lib/organizer/ops-metrics"
import { saturationRunStatus } from "@/lib/organizer/saturation-status"
import { MOCK_OPS_METRICS_INPUT } from "@/lib/organizer/ops-metrics-mock"
import type { AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import type { MemberRow } from "@/lib/organizer/members"

// 서브 운영자(sub, 무역관) 착지·이동 경로의 회귀 테스트(2026-09-17). 결함: sub가 로그인하면 /organizer가
// master 전용 API 403으로 서버 오류 화면이 되고(사이드바·로그아웃 없음), nav의 배정·관리자 콘솔 링크도
// 같은 오류 화면으로 이끌었다. 여기서는 **페이지 서버 컴포넌트**가 sub에게 오류를 던지지 않고 콘솔 안의
// 안내·조회 전용 화면을 그리는지 고정한다(크롬·nav 필터는 app-sidebar/nav 테스트가 지킨다).

const access = vi.hoisted(() => ({
  resolveOrganizerConsoleAccess: vi.fn(),
}))
vi.mock("@/lib/organizer/console-access", () => access)

const api = vi.hoisted(() => ({
  getOpsDashboard: vi.fn(),
  getAssignmentSchedule: vi.fn(),
  getOrganizationSchedule: vi.fn(),
  getMember: vi.fn(),
}))
vi.mock("@/lib/api-client/server", () => ({ serverApiClient: api }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/organizer",
}))
vi.mock("@/components/organizer/ops-hourly-chart", () => ({ OpsHourlyChart: () => null }))
vi.mock("@/components/organizer/assignment-hub", () => ({
  AssignmentHub: () => <div data-testid="assignment-hub" />,
}))
vi.mock("@/components/organizer/member-detail", () => ({
  MemberDetail: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="member-detail" data-readonly={String(!!readOnly)} />
  ),
}))

const SUB = { realSession: true, permissionLevel: "sub", session: { role: "organizer" } }
const MASTER = { realSession: true, permissionLevel: "master", session: { role: "organizer" } }

const SCHEDULE: AssignmentScheduleData = {
  timezone: "Asia/Seoul",
  exhibitors: [{ id: "ex-1", name: "참가사1", role: "exhibitor", keywords: [] }],
  buyers: [{ id: "by-1", name: "관할바이어", role: "buyer", keywords: [] }],
  dates: [{ id: "2026-10-20", label: "10/20", weekday: "화" }],
  settings: { startTime: "09:00", endTime: "10:00", slotMinutes: 30, slotGapMinutes: 0, lunchStart: "00:00", lunchEnd: "00:00", minSlots: 10, maxMeetingMinutes: 90 },
  slotTimes: ["09:00", "09:30"],
  meetings: [],
  recsByOrgId: {},
  applicationOrder: {},
  unavailableByOrgId: {},
  contactsByOrgId: {},
}

const BUYER_ROW = {
  id: "by-1",
  name: "관할바이어",
  tab: "buyer",
  applicationStatus: "approved",
} as MemberRow

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("/organizer 매칭 현황 — sub 착지 화면", () => {
  it("master 전용 거절(403)이 와도 던지지 않고 콘솔 안에서 권한 안내를 그린다", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getOpsDashboard.mockRejectedValue(new OperatorHttpError(403, "organizer ops-metrics read failed (403)"))
    const { default: OrganizerPage } = await import("./page")

    render(await OrganizerPage())

    expect(screen.getByText("매칭 현황을 불러올 권한이 없습니다")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "참가기업 관리로" })).toHaveAttribute("href", "/organizer/members")
  })

  it("관할 스코프 응답이면 조회 화면을 그리되 배정(거버넌스) 동선은 없다", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getOpsDashboard.mockResolvedValue({
      metrics: aggregateOpsMetrics({
        ...MOCK_OPS_METRICS_INPUT,
        participants: [{ orgId: "by-1", role: "buyer", approved: true }],
        roster: { exhibitorRegistrants: 0, buyerRegistrants: 1 },
      }),
      saturation: saturationRunStatus([]),
      scope: "jurisdiction",
    })
    const { default: OrganizerPage } = await import("./page")

    render(await OrganizerPage())

    expect(screen.getByText("매칭 현황 대시보드")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /배정/ })).not.toBeInTheDocument()
    expect(screen.queryByText("0건 참가사")).not.toBeInTheDocument()
  })

  it("권한 거절이 아닌 실패(500)는 삼키지 않고 error.tsx(레이아웃 안)로 올린다", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getOpsDashboard.mockRejectedValue(new OperatorHttpError(500, "boom"))
    const { default: OrganizerPage } = await import("./page")

    await expect(OrganizerPage()).rejects.toThrow("boom")
  })

  it("master는 기존 화면 그대로 — 배정 바로가기 포함", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(MASTER)
    api.getOpsDashboard.mockResolvedValue({
      metrics: aggregateOpsMetrics(MOCK_OPS_METRICS_INPUT),
      saturation: saturationRunStatus([]),
      scope: "event",
    })
    const { default: OrganizerPage } = await import("./page")

    render(await OrganizerPage())

    expect(screen.getByRole("link", { name: /배정/ })).toHaveAttribute("href", "/organizer/forced-matching")
    expect(screen.getByText("슬롯 사용률")).toBeInTheDocument()
  })
})

describe("/organizer/forced-matching — 배정은 master 전용", () => {
  it("sub가 URL로 직접 와도 master 전용 그리드를 부르지 않고 권한 안내를 그린다", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    const { default: ForcedMatchingPage } = await import("./forced-matching/page")

    render(await ForcedMatchingPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByText("매칭 배정은 슈퍼 운영자 전용입니다")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "매칭 현황으로" })).toHaveAttribute("href", "/organizer")
    expect(api.getAssignmentSchedule).not.toHaveBeenCalled()
    expect(screen.queryByTestId("assignment-hub")).not.toBeInTheDocument()
  })

  it("master는 배정 허브를 그대로 본다", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(MASTER)
    api.getAssignmentSchedule.mockResolvedValue(SCHEDULE)
    const { default: ForcedMatchingPage } = await import("./forced-matching/page")

    render(await ForcedMatchingPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByTestId("assignment-hub")).toBeInTheDocument()
  })
})

describe("/organizer/members/[id] 기업 디테일 — sub는 관할 조회 전용", () => {
  const params = (id: string) => ({ params: Promise.resolve({ organizationId: id }), searchParams: Promise.resolve({}) })

  it("다른 운영자의 바이어(403)는 오류 화면이 아니라 '열람 권한 없음' 안내", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getMember.mockResolvedValue(null)
    api.getOrganizationSchedule.mockResolvedValue({ status: "forbidden" })
    const { default: DetailPage } = await import("./members/[organizationId]/page")

    render(await DetailPage(params("other-subs-buyer")))

    expect(screen.getByText("이 기업을 열람할 권한이 없습니다")).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: /목록으로/ })[0]).toHaveAttribute("href", "/organizer/members")
    expect(api.getOrganizationSchedule).toHaveBeenCalledWith("other-subs-buyer")
    expect(api.getAssignmentSchedule).not.toHaveBeenCalled()
  })

  it("없는 기업(404)은 '찾을 수 없음' 안내", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getMember.mockResolvedValue(null)
    api.getOrganizationSchedule.mockResolvedValue({ status: "not_found" })
    const { default: DetailPage } = await import("./members/[organizationId]/page")

    render(await DetailPage(params("missing")))

    expect(screen.getByText("해당 기업을 찾을 수 없습니다")).toBeInTheDocument()
  })

  it("관할 기업은 조회 전용(readOnly)으로 상세를 연다 — 배정 액션 없음", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(SUB)
    api.getMember.mockResolvedValue(BUYER_ROW)
    api.getOrganizationSchedule.mockResolvedValue({ status: "ok", data: SCHEDULE })
    const { default: DetailPage } = await import("./members/[organizationId]/page")

    render(await DetailPage(params("by-1")))

    expect(screen.getByRole("heading", { name: "관할바이어" })).toBeInTheDocument()
    expect(screen.getByTestId("member-detail")).toHaveAttribute("data-readonly", "true")
  })

  it("master는 행사 전역 그리드로 배정 가능한 상세를 연다(기존 동작)", async () => {
    access.resolveOrganizerConsoleAccess.mockResolvedValue(MASTER)
    api.getMember.mockResolvedValue(BUYER_ROW)
    api.getAssignmentSchedule.mockResolvedValue(SCHEDULE)
    const { default: DetailPage } = await import("./members/[organizationId]/page")

    render(await DetailPage(params("by-1")))

    expect(screen.getByTestId("member-detail")).toHaveAttribute("data-readonly", "false")
    expect(api.getOrganizationSchedule).not.toHaveBeenCalled()
  })
})

describe("app/organizer/error.tsx — 콘솔 안의 안전망", () => {
  it("403(digest)은 권한 안내 — 재시도 대신 안전한 착지점을 준다", async () => {
    const { default: OrganizerError } = await import("./error")
    const retry = vi.fn()
    const error = Object.assign(new Error("hidden in production"), { digest: OPERATOR_FORBIDDEN_DIGEST })
    vi.spyOn(console, "error").mockImplementation(() => {})

    render(<OrganizerError error={error} unstable_retry={retry} />)

    expect(screen.getByText("이 화면을 볼 권한이 없습니다")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "매칭 현황으로" })).toHaveAttribute("href", "/organizer")
    expect(screen.queryByText("hidden in production")).not.toBeInTheDocument()
  })

  it("그 외 실패는 재시도를 제공하고 원문 메시지는 내보내지 않는다", async () => {
    const { default: OrganizerError } = await import("./error")
    const retry = vi.fn()
    vi.spyOn(console, "error").mockImplementation(() => {})

    render(<OrganizerError error={Object.assign(new Error("internal path /api/admin/x"), { digest: "123" })} unstable_retry={retry} />)

    expect(screen.getByText("화면을 불러오지 못했습니다")).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "다시 시도" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.queryByText(/internal path/)).not.toBeInTheDocument()
  })
})
