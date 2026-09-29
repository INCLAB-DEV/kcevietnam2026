import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronRight, Users } from "lucide-react"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { OpsMetrics, StatusBreakdown } from "@/lib/organizer/ops-metrics"
import type { OpsDashboard } from "@/lib/api-client/types"
import { OpsHourlyChart } from "./ops-hourly-chart"

// OP-001 매칭 현황 대시보드 (F-OP-001 / 이슈 #53) — 운영사 로그인 랜딩, 읽기 전용.
// 모든 숫자는 서버 집계 결과(getOpsDashboard)를 그리기만 한다(ADR-0008). 액션은 여기서 안 하고
// 행동 필요 지점만 가리켜 OP-005/002/003 으로 보낸다.
//
// 디자인(F-MY-001 D2 near-mono): 면은 모노크롬, 상태색은 슬림 액센트에만.
//   · 차트/분포 음영 = 모노크롬 chart 램프(--chart-*). 공통 매핑: 완료=5(진함)·예정=2·노쇼=1(옅음)·취소=3.
//   · 시맨틱 색(status-*)은 "액션 필요"에만 — 0건 참가사>0, 포화배정 Draft 검토대기 = status-pending(적).
//     노쇼는 액션이 아니라 결과 속성이므로 모노로 둔다(적색 아님).
const TONE = {
  scheduled: "bg-chart-2",
  completed: "bg-chart-5",
  noshow: "bg-chart-3",
  cancelled: "bg-chart-1",
} as const

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

// 슬림 진행 미터(면 모노). alert=액션 필요 시 status-pending(적).
function Meter({
  value,
  max,
  alert,
}: {
  value: number
  max: number
  alert?: boolean
}) {
  const ratio = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          alert ? "bg-status-pending" : "bg-foreground"
        )}
        style={{ width: `${ratio}%` }}
        aria-hidden
      />
    </div>
  )
}

// 화면 모드 두 갈래(응답 scope, ADR-0012):
//  · event(master) — 행사 전역. 기존 화면 그대로.
//  · jurisdiction(sub, 무역관) — 자기가 관리하는 바이어의 매칭 활동만. 참가사 모집단이 없으므로 참가사
//    기준 위젯(슬롯 사용률·0건 참가사, 등록자 카드의 참가사 줄)은 숨긴다 — 0으로 채워 두면 "배정 재실행
//    필요" 같은 master 행동을 sub에게 권하게 된다. 관할 바이어가 아직 없으면 0 격자 대신 안내를 그린다.
// canManageAssignments: 배정(거버넌스, master 전용) 화면으로 가는 바로가기 노출 여부.
export function OpsDashboardView({
  data,
  canManageAssignments = true,
}: {
  data: OpsDashboard
  canManageAssignments?: boolean
}) {
  const { metrics } = data
  const jurisdiction = data.scope === "jurisdiction"
  const noBuyers = jurisdiction && metrics.roster.buyer === 0 && metrics.totalMeetings === 0
  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">
          매칭 현황 대시보드
        </h1>
        <p className="text-sm text-muted-foreground">
          {jurisdiction
            ? "내가 관리하는 바이어의 비즈매칭·미팅 현황. 조회 전용 — 바이어 등록·신청서는 참가기업 관리에서."
            : "2026 베트남 K-콘텐츠 엑스포 전체 비즈매칭·미팅 현황. 조회 전용 — 배정·정정은 각 관리 화면에서."}
        </p>
      </header>

      {noBuyers ? (
        <NoManagedBuyers />
      ) : (
        <>
          <KpiRow
            metrics={metrics}
            jurisdiction={jurisdiction}
            canManageAssignments={canManageAssignments}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            <ScaleCard metrics={metrics} jurisdiction={jurisdiction} />
            <StatusCard status={metrics.status} total={metrics.totalMeetings} />
          </div>

          <OpsHourlyChart hourly={metrics.hourly} />
        </>
      )}
    </div>
  )
}

// sub의 빈 상태 — 관할 바이어 0명(신규 무역관 계정). 오류가 아니라 "아직 시작 전"이다.
function NoManagedBuyers() {
  return (
    <Empty className="border" data-testid="ops-no-managed-buyers">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users />
        </EmptyMedia>
        <EmptyTitle className="text-base">아직 관리하는 바이어가 없습니다</EmptyTitle>
        <EmptyDescription>
          참가기업 관리에서 바이어를 등록하거나 명단을 업로드하면 이곳에 매칭 현황이 표시됩니다.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" asChild>
          <Link href="/organizer/members">참가기업 관리로</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

// ── KPI 섹션 카드 행 ──────────────────────────────────────────────────────────
function KpiRow({
  metrics,
  jurisdiction,
  canManageAssignments,
}: {
  metrics: OpsMetrics
  jurisdiction: boolean
  canManageAssignments: boolean
}) {
  const {
    totalMeetings,
    completedMeetings,
    noshow,
    review,
    slots,
    zeroMeetingExhibitors,
  } = metrics
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-4 md:grid-cols-3",
        jurisdiction ? "xl:grid-cols-4" : "xl:grid-cols-6"
      )}
      data-tour="ops-metrics"
    >
      <KpiCard
        label="전체 비즈매칭"
        value={totalMeetings}
        sub={`예정 ${metrics.status.scheduled} · 완료 ${completedMeetings}`}
      />
      <KpiCard
        label="완료 미팅"
        value={completedMeetings}
        sub={`노쇼 ${noshow.count}건 제외`}
      />
      <KpiCard
        label="노쇼율"
        value={pct(noshow.rate)}
        sub={`노쇼 ${noshow.count} / 완료 ${completedMeetings + noshow.count}`}
        meter={{ value: noshow.count, max: completedMeetings + noshow.count }}
      />
      <KpiCard
        label="후기 작성률"
        value={pct(review.rate)}
        sub={`${review.submitted} / ${review.expected}건`}
        meter={{ value: review.submitted, max: review.expected }}
      />
      {/* 참가사 기준 지표 — 행사 전역(master)에서만 정의된다(sub 관할엔 참가사 모집단이 없다). */}
      {!jurisdiction && (
        <>
          <KpiCard
            label="슬롯 사용률"
            value={pct(slots.rate)}
            sub={`${slots.assigned} / ${slots.total}칸`}
            meter={{ value: slots.assigned, max: slots.total }}
          />
          <KpiCard
            tourId="ops-zero"
            label="0건 참가사"
            value={zeroMeetingExhibitors}
            sub={zeroMeetingExhibitors > 0 ? "배정 재실행 필요" : "최저선 충족"}
            alert={zeroMeetingExhibitors > 0}
            action={
              // 배정(일괄·강제)은 master 전용 거버넌스 — 권한 없는 계정에 403 화면으로 가는 길을 두지 않는다.
              canManageAssignments ? (
                <a
                  href="/organizer/forced-matching"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "-mr-2 h-6 gap-0.5 px-1.5 text-xs"
                  )}
                >
                  배정 <ChevronRight className="size-3" />
                </a>
              ) : undefined
            }
          />
        </>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  sub,
  meter,
  alert,
  action,
  tourId,
}: {
  label: string
  value: number | string
  sub?: string
  meter?: { value: number; max: number }
  alert?: boolean
  action?: ReactNode
  // 가이드 투어 앵커(data-tour) — 특정 지표 카드를 투어가 가리킬 때만 부여(그 외엔 미부여, 침습 최소).
  tourId?: string
}) {
  return (
    <Card className="gap-3 py-4" data-tour={tourId}>
      <CardHeader className="gap-0">
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle
          className={cn(
            "text-3xl font-semibold tracking-tight tabular-nums",
            alert && "text-status-pending"
          )}
        >
          {typeof value === "number" ? value.toLocaleString("ko-KR") : value}
        </CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {meter ? <Meter value={meter.value} max={meter.max} /> : null}
        {sub ? (
          <p className="text-xs text-muted-foreground tabular-nums">{sub}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

// ── 등록자 vs 참가자(참여율) ──────────────────────────────────────────────────
// sub 관할 모드는 바이어 줄만 — "등록"은 관리 중인 바이어 수(승인 무관), "참가자"는 그중 승인 완료.
function ScaleCard({ metrics, jurisdiction }: { metrics: OpsMetrics; jurisdiction: boolean }) {
  const rows = [
    ...(jurisdiction
      ? []
      : [
          {
            label: "참가사",
            approved: metrics.participants.exhibitor,
            total: metrics.roster.exhibitor,
          },
        ]),
    {
      label: "바이어",
      approved: metrics.participants.buyer,
      total: metrics.roster.buyer,
    },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {jurisdiction ? "관리 바이어 · 비즈매칭 참가자" : "등록자 · 비즈매칭 참가자"}
        </CardTitle>
        <CardDescription>
          {jurisdiction
            ? "내가 관리하는 바이어 대비 승인 완료(실제 참여) 규모"
            : "명단 적재 대비 승인 완료(실제 참여) 규모"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {rows.map((r) => {
          const rate = r.total > 0 ? r.approved / r.total : 0
          return (
            <div key={r.label} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  참여율 {pct(rate)}
                </span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl leading-none font-semibold tabular-nums">
                  {r.approved}
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  / {r.total.toLocaleString("ko-KR")} 등록
                </span>
              </div>
              <Meter value={r.approved} max={r.total} />
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ── 미팅 상태 분포(예정·완료·취소·노쇼) ──────────────────────────────────────
function StatusCard({
  status,
  total,
}: {
  status: StatusBreakdown
  total: number
}) {
  const all =
    status.scheduled + status.completed + status.noshow + status.cancelled
  const segments = [
    {
      key: "scheduled",
      label: "예정",
      value: status.scheduled,
      tone: TONE.scheduled,
    },
    {
      key: "completed",
      label: "완료",
      value: status.completed,
      tone: TONE.completed,
    },
    { key: "noshow", label: "노쇼", value: status.noshow, tone: TONE.noshow },
    {
      key: "cancelled",
      label: "취소",
      value: status.cancelled,
      tone: TONE.cancelled,
    },
  ] as const

  return (
    <Card data-tour="ops-status">
      <CardHeader>
        <CardTitle>미팅 상태 분포</CardTitle>
        <CardDescription>
          활성 비즈매칭 {total.toLocaleString("ko-KR")}건 · 취소{" "}
          {status.cancelled}건
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted ring-1 ring-foreground/5">
          {segments.map((s) =>
            s.value > 0 && all > 0 ? (
              <div
                key={s.key}
                className={s.tone}
                style={{ width: `${(s.value / all) * 100}%` }}
                aria-hidden
              />
            ) : null
          )}
        </div>
        <ul className="flex flex-col gap-2.5">
          {segments.map((s) => (
            <li
              key={s.key}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2.5 rounded-[3px] ring-1 ring-foreground/10",
                    s.tone
                  )}
                  aria-hidden
                />
                <span className="text-muted-foreground">{s.label}</span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="font-semibold tabular-nums">{s.value}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {all > 0 ? pct(s.value / all) : "0%"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
