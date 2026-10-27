"use client"

import { useLocale, useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"

// HM-001 블록 ② 오늘 미팅 일정. 시간순(상위에서 정렬됨) 상대 기업·시간·장소. 항목 → MY-001(/meetings).
interface TodayScheduleCardProps {
  meetings: MeetingRecord[]
}

function kstTime(scheduledAt: string, locale: string): string {
  return new Date(scheduledAt).toLocaleTimeString(locale === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function TodayScheduleCard({ meetings }: TodayScheduleCardProps) {
  const t = useTranslations("home.todaySchedule")
  const locale = useLocale()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardAction>
          <a href="/meetings" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("viewAll")}
            <ChevronRight className="size-3.5" />
          </a>
        </CardAction>
      </CardHeader>
      <CardContent>
        {meetings.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="-mx-2 divide-y divide-border">
            {meetings.map((m) => (
              <li key={m.id}>
                <a
                  href="/meetings"
                  className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent/70"
                >
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {kstTime(m.scheduledAt, locale)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{m.counterpartName}</span>
                    <span className="truncate text-xs text-muted-foreground">{m.venue}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
