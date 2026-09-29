import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@/lib/test/render-with-intl"
import { OpsDashboardView } from "./dashboard"
import { aggregateOpsMetrics, type OpsMetricsInput } from "@/lib/organizer/ops-metrics"
import { saturationRunStatus } from "@/lib/organizer/saturation-status"
import { MOCK_OPS_METRICS_INPUT, MOCK_SATURATION_RUNS } from "@/lib/organizer/ops-metrics-mock"
import type { OpsDashboard } from "@/lib/api-client/types"

// OP-001 매칭 현황 대시보드의 두 모드(2026-09-17).
//  · event(master) — 기존 화면 그대로(슬롯 사용률·0건 참가사·배정 바로가기).
//  · jurisdiction(sub, 무역관) — 관할 바이어 활동만: 참가사 기준 위젯과 배정(거버넌스) 동선이 없고,
//    관할 바이어가 0명이면 0 격자 대신 안내를 그린다(오류 화면 아님).

// 시간대 차트는 recharts(ResizeObserver) — 이 테스트의 관심사가 아니라 표지만 남긴다.
vi.mock("./ops-hourly-chart", () => ({ OpsHourlyChart: () => <div data-testid="hourly-chart" /> }))

function dashboard(input: OpsMetricsInput, scope?: OpsDashboard["scope"]): OpsDashboard {
  return {
    metrics: aggregateOpsMetrics(input),
    saturation: saturationRunStatus(MOCK_SATURATION_RUNS),
    scope,
  }
}

const SUB_INPUT: OpsMetricsInput = {
  roster: { exhibitorRegistrants: 0, buyerRegistrants: 2 },
  participants: [
    { orgId: "b-1", role: "buyer", approved: true },
    { orgId: "b-2", role: "buyer", approved: false },
  ],
  meetings: [
    {
      id: "m-1",
      exhibitorOrgId: "e-1",
      buyerOrgId: "b-1",
      status: "accepted",
      scheduledStart: "2026-10-20T10:00:00+09:00",
    },
  ],
  reviews: [],
  schedule: {
    operatingStart: "09:00",
    operatingEnd: "18:00",
    slotMinutes: 30,
    slotGapMinutes: 0,
    lunchStart: "00:00",
    lunchEnd: "00:00",
    eventDays: 3,
  },
}

describe("OpsDashboardView — master(행사 전역)", () => {
  it("참가사 기준 위젯과 배정 바로가기가 그대로 있다", () => {
    render(<OpsDashboardView data={dashboard(MOCK_OPS_METRICS_INPUT)} />)
    expect(screen.getByText("슬롯 사용률")).toBeInTheDocument()
    expect(screen.getByText("0건 참가사")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /배정/ })).toHaveAttribute("href", "/organizer/forced-matching")
    expect(screen.getByText("참가사")).toBeInTheDocument()
  })

  it("배정 권한이 없으면(canManageAssignments=false) 배정 바로가기를 그리지 않는다", () => {
    render(<OpsDashboardView data={dashboard(MOCK_OPS_METRICS_INPUT, "event")} canManageAssignments={false} />)
    expect(screen.getByText("0건 참가사")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /배정/ })).not.toBeInTheDocument()
  })
})

describe("OpsDashboardView — sub(관할 바이어 스코프)", () => {
  it("관할 바이어 지표만 그리고 참가사 기준 위젯·배정 동선은 없다", () => {
    render(<OpsDashboardView data={dashboard(SUB_INPUT, "jurisdiction")} canManageAssignments={false} />)

    expect(screen.getByText(/내가 관리하는 바이어의 비즈매칭/)).toBeInTheDocument()
    expect(screen.getByText("전체 비즈매칭")).toBeInTheDocument()
    expect(screen.queryByText("슬롯 사용률")).not.toBeInTheDocument()
    expect(screen.queryByText("0건 참가사")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /배정/ })).not.toBeInTheDocument()

    const scale = screen.getByText("관리 바이어 · 비즈매칭 참가자").closest<HTMLElement>("[data-slot=card]")
    expect(scale).not.toBeNull()
    expect(within(scale!).getByText("바이어")).toBeInTheDocument()
    expect(within(scale!).queryByText("참가사")).not.toBeInTheDocument()
    expect(within(scale!).getByText("/ 2 등록")).toBeInTheDocument()
  })

  it("관할 바이어가 0명인 신규 sub는 오류가 아니라 시작 안내를 본다", () => {
    const empty: OpsMetricsInput = {
      ...SUB_INPUT,
      roster: { exhibitorRegistrants: 0, buyerRegistrants: 0 },
      participants: [],
      meetings: [],
    }
    render(<OpsDashboardView data={dashboard(empty, "jurisdiction")} canManageAssignments={false} />)

    expect(screen.getByText("아직 관리하는 바이어가 없습니다")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "참가기업 관리로" })).toHaveAttribute("href", "/organizer/members")
    expect(screen.queryByText("전체 비즈매칭")).not.toBeInTheDocument()
    expect(screen.queryByTestId("hourly-chart")).not.toBeInTheDocument()
  })
})
