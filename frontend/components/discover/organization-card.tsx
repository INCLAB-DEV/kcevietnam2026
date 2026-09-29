"use client"

import { useTranslations } from "next-intl"
import { Bookmark, MapPin, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { boothLabel, BUYER_TYPE_LABELS } from "@/lib/types"
import type { Organization, ViewerRole } from "@/lib/types"

interface OrganizationCardProps {
  org: Organization
  viewerRole: ViewerRole
  score?: number // AI 매칭 적합도(%). 있으면 매칭률 표시.
  bookmarked?: boolean
  onBookmark?: () => void
  onClick?: () => void
}

export function OrganizationCard({
  org,
  viewerRole,
  score,
  bookmarked = false,
  onBookmark,
  onClick,
}: OrganizationCardProps) {
  const t = useTranslations("discover.card")
  const isExhibitor = org.role === "exhibitor"

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {/* 헤더 — 회사정보/바이어정보 그룹 + 매칭률 + 북마크 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-base font-bold text-muted-foreground">
            {org.name.slice(0, 1)}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{org.name}</span>
              {!isExhibitor && org.buyerType && (
                <Badge variant="secondary" className="shrink-0 font-normal">
                  {BUYER_TYPE_LABELS[org.buyerType]}
                </Badge>
              )}
            </div>
            {isExhibitor && org.booth && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="size-3 shrink-0" />
                {boothLabel(org.booth)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {score !== undefined && (
            <Badge variant="outline" className="gap-1 font-medium tabular-nums">
              <Sparkles className="size-3" />
              {t("matchScore", { score })}
            </Badge>
          )}
          {onBookmark && (
            <button
              type="button"
              aria-label={bookmarked ? t("bookmarkRemoveAria") : t("bookmarkAddAria")}
              aria-pressed={bookmarked}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onBookmark()
              }}
            >
              <Bookmark className={cn("size-5", bookmarked && "fill-current text-foreground")} />
            </button>
          )}
        </div>
      </div>

      {/* 강점(참가사) / 기업소개(바이어) */}
      {isExhibitor
        ? org.strength && (
            <p className="text-sm leading-relaxed text-muted-foreground">{org.strength}</p>
          )
        : org.description && (
            <p className="text-sm leading-relaxed text-muted-foreground">{org.description}</p>
          )}

      {/* 상품정보(참가사 전시제품) / 관심정보(바이어 관심분야 + 예산·도입시기) */}
      {isExhibitor ? (
        org.exhibits &&
        org.exhibits.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {org.exhibits.map((item) => (
              <Badge key={item} variant="secondary" className="font-normal">
                {item}
              </Badge>
            ))}
          </div>
        )
      ) : (
        <>
          {org.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {org.keywords.map((kw) => (
                <Badge key={kw} variant="secondary" className="font-normal">
                  {kw}
                </Badge>
              ))}
            </div>
          )}
          {(org.budgetRange || org.adoptionTimeline) && (
            <span className="text-xs text-muted-foreground">
              {[org.budgetRange, org.adoptionTimeline].filter(Boolean).join(" · ")}
            </span>
          )}
        </>
      )}
    </div>
  )
}
