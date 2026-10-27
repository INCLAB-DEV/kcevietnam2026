"use client"

import { useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ActionStripView } from "@/lib/meeting/action-strip"

// MY-001 상단 액션 스트립(F-MY-001 D15~D17). "내 미팅"의 1차 기대는 일정(타임라인)이라,
// 상단은 숫자판이 아니라 "나를 기다리는 액션"만 얹는 슬림 스트립으로 둔다.
//  - 건수 있는 항목만, 둘 다 0이면 렌더 안 함(평소엔 깔끔한 일정).
//  - 받은 미팅요청만 alert 액센트(상대가 나를 기다리는 유일한 건).
//  - 탭 → onJump(대상 미팅 id): 타임라인에서 그 미팅으로 점프(수락/거부·회의록은 패널 한 곳).
export function MeetingActionStrip({
  view,
  onJump,
}: {
  view: ActionStripView
  onJump: (meetingId: string) => void
}) {
  const t = useTranslations("meeting.actionStrip")
  const rows = [
    {
      key: "received",
      label: t("receivedLabel"),
      count: view.receivedRequests,
      context: t("receivedContext"),
      cta: t("receivedCta"),
      targetId: view.earliestReceivedId,
      alert: true,
    },
    {
      key: "review",
      label: t("reviewLabel"),
      count: view.pendingReview,
      context: t("reviewContext"),
      cta: t("reviewCta"),
      targetId: view.earliestReviewId,
      alert: false,
    },
  ].filter(
    (r): r is typeof r & { targetId: string } => r.count > 0 && !!r.targetId
  )

  if (rows.length === 0) return null

  return (
    <div data-tour="meeting-actions" className="mb-4 flex flex-col gap-2">
      {rows.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onJump(r.targetId)}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            r.alert
              ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
              : "hover:bg-accent/60"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              r.alert ? "bg-destructive" : "bg-muted-foreground/40"
            )}
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* 라벨·건수는 한 줄에 묶어 두고, 자리가 모자라면 부가 설명이 통째로 다음 줄로 내려간다.
                en 문구는 국문보다 길어 375px에서 한 줄에 다 안 들어간다 — 예전 배치에서는 라벨이 두 줄로 꺾이고
                설명이 "They'…"처럼 뜻을 잃을 만큼 잘렸다. 한 줄에 다 들어가는 경우(국문 등)는 그대로 한 줄이다. */}
            <span
              className={cn(
                "shrink-0 text-sm font-semibold whitespace-nowrap",
                r.alert && "text-destructive"
              )}
            >
              {r.label}
            </span>
            <span
              className={cn(
                "shrink-0 text-sm font-bold tabular-nums",
                r.alert && "text-destructive"
              )}
            >
              {t("countSuffix", { count: r.count })}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {r.context}
            </span>
          </span>
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-xs font-medium",
              r.alert ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {r.cta}
            <ChevronRight className="size-3.5" />
          </span>
        </button>
      ))}
    </div>
  )
}
