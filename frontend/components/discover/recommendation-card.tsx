"use client"

import { useTranslations } from "next-intl"
import { Bookmark, MapPin } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { HelpHint } from "@/components/help/help-hint"
import { cn } from "@/lib/utils"
import { boothLabel } from "@/lib/types"
import type { MatchResult } from "@/lib/api-client"
import type { ViewerRole } from "@/lib/types"

interface RecommendationCardProps {
  result: MatchResult
  viewerRole: ViewerRole
  bookmarked?: boolean
  onBookmark?: () => void
  onDetail?: () => void
  onMeeting?: () => void
}

export function RecommendationCard({
  result,
  bookmarked = false,
  onBookmark,
  onDetail,
  onMeeting,
}: RecommendationCardProps) {
  const t = useTranslations("discover.card")
  const th = useTranslations("help.hints")
  const { org, aiScore, aiReasons } = result
  const supporting = org.strength ?? org.budgetRange

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-2 sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            {org.booth && (
              <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <MapPin className="size-3" />
                {boothLabel(org.booth)}
              </span>
            )}
            <h2 className="text-xl leading-tight font-bold tracking-tight break-words sm:text-2xl">
              {org.name}
            </h2>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <span className="text-2xl font-bold tabular-nums sm:text-3xl">
              {aiScore}%
            </span>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("aiMatch")}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4 overflow-y-auto">
        <div className="rounded-lg border bg-muted/40 p-3 sm:p-4">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("aiReasonTitle")}
          </p>
          {aiReasons.map((reason, i) => (
            <p
              key={i}
              className="text-[15px] leading-relaxed text-foreground/90"
            >
              {reason}
            </p>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {org.keywords.map((kw) => (
            <Badge key={kw} variant="secondary" className="font-normal">
              {kw}
            </Badge>
          ))}
        </div>

        {supporting && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {supporting}
          </p>
        )}
      </CardContent>

      <CardFooter className="flex-col gap-2 border-t">
        <Button
          variant="outline"
          className={cn(
            "w-full",
            bookmarked && "border-foreground text-foreground"
          )}
          onClick={onBookmark}
        >
          <Bookmark
            data-icon="inline-start"
            className={cn(bookmarked && "fill-current")}
          />
          {bookmarked ? t("bookmarkSaved") : t("bookmark")}
        </Button>
        <div className="flex w-full gap-2">
          <Button variant="outline" className="flex-1" onClick={onDetail}>
            {t("viewDetail")}
          </Button>
          <HelpHint hint={th("discoverRequest")} side="top">
            <Button
              className="flex-1"
              onClick={onMeeting}
              data-tour="discover-request"
            >
              {t("requestMeeting")}
            </Button>
          </HelpHint>
        </div>
      </CardFooter>
    </Card>
  )
}
