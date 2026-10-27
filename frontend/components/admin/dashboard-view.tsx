import { ChevronRight } from "lucide-react"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { adminNavItemsFor } from "./admin-nav"
import type { AdminDashboard, AdminEvent, VenueType } from "@/lib/admin/types"
import { VENUE_TYPE_LABELS } from "@/lib/admin/types"
import type { AdminEventSettings } from "@/lib/admin/types"

// 대시보드 — 선택된 행사의 요약. 조회 전용이며 숫자는 서버 집계(buildAdminDashboard)를 그리기만 한다.
// 운영자 콘솔의 OpsDashboardView와 같은 카드 문법(KPI 카드 + 보조 카드)을 따라 시각적으로 붙인다.

function KpiCard({
  label,
  value,
  sub,
  href,
  alert,
}: {
  label: string
  value: number | string
  sub?: string
  href?: string
  alert?: boolean
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-0">
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle
          className={cn(
            "text-3xl font-semibold tabular-nums tracking-tight",
            alert && "text-status-pending",
          )}
        >
          {typeof value === "number" ? value.toLocaleString("ko-KR") : value}
        </CardTitle>
        {href ? (
          <CardAction>
            <a
              href={href}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "-mr-2 h-6 gap-0.5 px-1.5 text-xs",
              )}
            >
              관리 <ChevronRight className="size-3" />
            </a>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {sub ? <p className="text-xs tabular-nums text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  )
}

export function AdminDashboardView({
  data,
  event,
  settings,
  canWrite,
}: {
  data: AdminDashboard
  event: AdminEvent
  settings: AdminEventSettings | null
  // 거버넌스 쓰기 권한(master) — 없으면(sub) master 전용 화면(미팅 배정·운영자 관리) 바로가기를
  // 감춘다. 사이드바(admin-sidebar.tsx)와 같은 adminNavItemsFor 판정을 그대로 쓴다(2026-09-17,
  // sub가 대시보드 본문 카드로 들어가 403을 맞던 결함 수정).
  canWrite: boolean
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="기업 수"
          value={data.org_total}
          sub={`참가사 ${data.exhibitor_count} · 바이어 ${data.buyer_count}`}
          href="/admin/organizations"
        />
        <KpiCard
          label="미신청 기업"
          value={data.unsubmitted_count}
          sub={
            data.unsubmitted_count > 0
              ? "신청서 대리작성 대상"
              : "전 기업 신청서 제출 완료"
          }
          alert={data.unsubmitted_count > 0}
          href="/admin/organizations"
        />
        <KpiCard
          label="미팅 수"
          value={data.meeting_total}
          sub={`예정 ${data.meeting_scheduled}건`}
          href="/admin/meetings"
        />
        <KpiCard
          label="알림 발송 수"
          value={data.notification_sent}
          sub="인앱 · 이메일 합계"
          href="/admin/notifications"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>행사 개요</CardTitle>
            <CardDescription>현재 관리 중인 행사와 적용된 정책</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex gap-3">
              <span className="w-24 shrink-0 text-muted-foreground">행사명</span>
              <span className="min-w-0">
                <span className="font-medium">{event.name}</span>
                <span className="block text-xs text-muted-foreground">{event.name_en}</span>
              </span>
            </div>
            <div className="flex gap-3">
              <span className="w-24 shrink-0 text-muted-foreground">장소</span>
              <span className="min-w-0">{event.venue_name}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-24 shrink-0 text-muted-foreground">전시 기간</span>
              <span className="tabular-nums">
                {event.exhibition_start} ~ {event.exhibition_end}
              </span>
            </div>
            {/* 신청기간은 **행사** 리소스 필드다(정책이 아니라 일정) — 백엔드 계약과 같은 자리에서 읽는다. */}
            <div className="flex gap-3">
              <span className="w-24 shrink-0 text-muted-foreground">신청기간</span>
              <span className="tabular-nums">
                {event.application_start} ~ {event.application_end}
              </span>
            </div>
            {settings && (
              <>
                <div className="flex gap-3">
                  <span className="w-24 shrink-0 text-muted-foreground">미팅 단위</span>
                  <span className="tabular-nums">{settings.slot_minutes}분</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-24 shrink-0 text-muted-foreground">미팅 장소</span>
                  <span className="flex flex-wrap gap-1">
                    {settings.enabled_venue_types.map((v: VenueType) => (
                      <Badge key={v} variant="outline">
                        {VENUE_TYPE_LABELS[v]}
                      </Badge>
                    ))}
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="w-24 shrink-0 text-muted-foreground">동일역할 열람</span>
                  <span>{settings.allow_same_role_discovery ? "허용" : "차단"}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>최근 활동</CardTitle>
            <CardDescription>이 행사에서 최근에 일어난 관리 작업</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recent_activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">아직 기록된 활동이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.recent_activity.map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 border-l-2 pl-3 text-sm">
                    <span className="min-w-0 break-words">{a.summary}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {a.at.slice(0, 16).replace("T", " ")} · {a.actor}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>관리 섹션</CardTitle>
          <CardDescription>슈퍼어드민이 조회·수정할 수 있는 영역</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {adminNavItemsFor(canWrite)
            .filter((i) => i.href !== "/admin")
            .map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
            >
              <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </span>
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
