"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { HourBucket } from "@/lib/organizer/ops-metrics"

// 시간대별 미팅 분포 — shadcn "Bar Chart - Interactive" 패턴.
// 헤더의 지표 토글(완료/예정/노쇼 + 합계)을 누르면 그 시리즈의 시간대별 막대로 전환된다.
// fill 은 모노크롬 chart 램프(--chart-*). 상태분포 카드 음영과 동일 매핑(완료=5·예정=2·노쇼=3).
const chartConfig = {
  count: { label: "건수" },
  completed: { label: "완료", color: "var(--chart-5)" },
  scheduled: { label: "예정", color: "var(--chart-2)" },
  noshow: { label: "노쇼", color: "var(--chart-3)" },
} satisfies ChartConfig

type SeriesKey = "completed" | "scheduled" | "noshow"
const SERIES: SeriesKey[] = ["completed", "scheduled", "noshow"]

// 헤더 토글 스와치는 ChartContainer(=data-chart 스코프) 밖이라 shadcn ChartStyle이 주입하는
// --color-* 가 안 잡힌다(투명 렌더). 전역 --chart-* 값을 직접 참조한다(차트 fill 과 동일 매핑).
const SWATCH: Record<SeriesKey, string> = {
  completed: "var(--chart-5)",
  scheduled: "var(--chart-2)",
  noshow: "var(--chart-3)",
}

export function OpsHourlyChart({ hourly }: { hourly: HourBucket[] }) {
  const [active, setActive] = React.useState<SeriesKey>("completed")

  const data = hourly.map((b) => ({
    hour: b.hour,
    completed: b.completed,
    scheduled: b.scheduled,
    noshow: b.noshow,
  }))

  const total = React.useMemo(
    () => ({
      completed: hourly.reduce((a, b) => a + b.completed, 0),
      scheduled: hourly.reduce((a, b) => a + b.scheduled, 0),
      noshow: hourly.reduce((a, b) => a + b.noshow, 0),
    }),
    [hourly]
  )

  return (
    <Card className="py-0" data-tour="ops-hourly">
      <CardHeader className="flex flex-col items-stretch border-b p-0! sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1 px-6 pt-4 pb-3 sm:py-5!">
          <CardTitle>시간대별 미팅 분포</CardTitle>
          <CardDescription>
            운영 부하·혼잡 시간대 — 지표를 눌러 전환
          </CardDescription>
        </div>
        <div className="flex">
          {SERIES.map((key) => (
            <button
              key={key}
              type="button"
              data-active={active === key}
              onClick={() => setActive(key)}
              className="relative z-30 flex flex-1 flex-col justify-center gap-1 border-t px-5 py-3 text-left even:border-l data-[active=true]:bg-muted/50 sm:border-t-0 sm:border-l sm:px-6 sm:py-4"
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="size-2 rounded-[2px]"
                  style={{ backgroundColor: SWATCH[key] }}
                  aria-hidden
                />
                {chartConfig[key].label}
              </span>
              <span className="text-lg leading-none font-bold tabular-nums sm:text-2xl">
                {total[key].toLocaleString("ko-KR")}
              </span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[240px] w-full"
        >
          <BarChart
            accessibilityLayer
            data={data}
            margin={{ left: 12, right: 12 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="hour"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => `${v}시`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  className="w-[140px]"
                  labelFormatter={(v) => `${v}시`}
                />
              }
            />
            <Bar dataKey={active} fill={`var(--color-${active})`} radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
