"use client"

import { useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import type { MeetingStatusRollup } from "@/lib/home/meeting-status-rollup"

// HM-001 블록 ① 미팅 현황 요약. 상태별 건수 카드 → MY-001(/meetings),
// 회의록 작성 대기 → MY-002(/meetings/review).
interface MeetingStatusCardProps {
  rollup: MeetingStatusRollup
}

interface Stat {
  label: string
  value: number
  href: string
}

// 회의록 작성은 "상태"가 아니라 완료·노쇼의 후속 액션이라 현황에 두지 않고
// 알림(할 일)에서 "회의록 작성"으로 다룬다(중복 방지).
// 노쇼는 completed의 결과 속성(ADR-0010)이라 completed에 이미 포함 — 별도 합산 불필요.
export function MeetingStatusCard({ rollup }: MeetingStatusCardProps) {
  const t = useTranslations("home.meetingStatus")
  const stats: Stat[] = [
    { label: t("upcoming"), value: rollup.upcoming, href: "/meetings" },
    { label: t("sentRequests"), value: rollup.sentRequests, href: "/meetings" },
    { label: t("receivedRequests"), value: rollup.receivedRequests, href: "/meetings" },
    { label: t("completed"), value: rollup.completed, href: "/meetings" },
  ]
  // #3 잔여분: 홈 카드 4칸 합과 미팅 화면 블록 수가 달라 보이는 이유를 설명하는 보조 문구.
  // 취소·거절은 카드에 별도 타일을 두지 않으므로(의도된 설계), 있을 때만 작게 안내한다.
  const excludedCount = rollup.cancelled + rollup.rejected

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
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {stats.map((s) => (
            <a
              key={s.label}
              href={s.href}
              className="flex flex-col gap-1 rounded-lg p-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent/70"
            >
              <span className="text-3xl font-bold tabular-nums leading-none">{s.value}</span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </a>
          ))}
        </div>
        {excludedCount > 0 && (
          <p className="mt-1 px-3 text-xs text-muted-foreground">
            {t("excludedNote", { count: excludedCount })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
