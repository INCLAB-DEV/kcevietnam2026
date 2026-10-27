"use client"

import { useLocale, useTranslations } from "next-intl"
import { ChevronRight, Calendar, CalendarX, CheckCircle2, Clock, FileCheck2, PenLine, type LucideIcon } from "lucide-react"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { notificationHref, type Notification, type NotificationType } from "@/lib/home/notification"

// HM-001 블록 ④ 알림(할 일). 그룹핑 없이 최신 알림을 리스트로 노출한다(상위에서 최신순·5개로 추림).
// 각 알림 → 딥링크(F-NT-001: /meetings/:meetingId). 타입은 아이콘으로 구분. 전체 알림 → /notifications.
interface NotificationCardProps {
  notifications: Notification[]
}

// 미팅 계열(신청·수락·취소)은 달력으로 통일, 거절은 취소와 같은 계열이라 달력X로 구분,
// 리마인더는 시계, 회의록 작성 안내는 펜, 정리 완료는 문서+체크.
const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  meeting_requested: Calendar,
  meeting_accepted: Calendar,
  meeting_cancelled: Calendar,
  meeting_rejected: CalendarX,
  meeting_reminder: Clock,
  review_prompt: PenLine,
  review_ready: FileCheck2,
  application_approved: CheckCircle2,
}

function kstDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function NotificationCard({ notifications }: NotificationCardProps) {
  const t = useTranslations("home.notifications")
  const locale = useLocale()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardAction>
          <a href="/notifications" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("viewAll")}
            <ChevronRight className="size-3.5" />
          </a>
        </CardAction>
      </CardHeader>
      <CardContent>
        {notifications.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="-mx-2 divide-y divide-border">
            {notifications.map((n) => {
              const Icon = TYPE_ICON[n.type]
              return (
                <li key={n.id}>
                  <a
                    href={notificationHref(n)}
                    className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent/70"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm">{n.message}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {kstDateTime(n.createdAt, locale)}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
