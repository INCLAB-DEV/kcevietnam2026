"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item"
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel"
import { RecommendationCard } from "./recommendation-card"
import { useFeedbackAnswers } from "@/lib/discover/feedback-store"
import type { MatchResult } from "@/lib/api-client"
import type { ViewerRole } from "@/lib/types"

// 거절 사유 키 — #14 추천 학습/성과보고용 신호. 백엔드 스펙 확정 전까지 프론트 단일 소스.
// 라벨은 t("swipeDeck.reason*")로 조립(로케일별 문구, 값 자체는 UI 표시용 텍스트라 로케일을 그대로 싣는다).
const DECLINE_REASON_KEYS = [
  "reasonExisting",
  "reasonFieldMismatch",
  "reasonTimingMismatch",
  "reasonOther",
] as const

interface SwipeDeckProps {
  results: MatchResult[]
  viewerRole: ViewerRole
  bookmarkedIds?: Set<string>
  onBookmark?: (orgId: string) => void
  onDetail?: (orgId: string) => void
  onMeeting?: (orgId: string) => void
  onFeedback?: (orgId: string, appropriate: boolean, reason?: string) => void
}

export function SwipeDeck({
  results,
  viewerRole,
  bookmarkedIds,
  onBookmark,
  onDetail,
  onMeeting,
  onFeedback,
}: SwipeDeckProps) {
  const t = useTranslations("discover.swipeDeck")
  const [api, setApi] = useState<CarouselApi>()
  const [current, setCurrent] = useState(0)
  const [reasonOpen, setReasonOpen] = useState(false)
  // 이미 응답한 기업 — localStorage에 영속(lib/discover/feedback-store)돼 탭 이동·재마운트
  // 후에도 다시 묻지 않는다(QA #E: "예 눌러도 다른 곳 갔다 오면 계속 나옴" 수정).
  const { isRated, record: recordFeedback } = useFeedbackAnswers()

  useEffect(() => {
    if (!api) return
    const onSelect = () => {
      setCurrent(api.selectedScrollSnap())
      setReasonOpen(false)
    }
    onSelect()
    api.on("select", onSelect)
    api.on("reInit", onSelect)
    return () => {
      api.off("select", onSelect)
      api.off("reInit", onSelect)
    }
  }, [api])

  // 제외/복원으로 슬라이드 수가 바뀌면 embla 재초기화
  useEffect(() => {
    api?.reInit()
  }, [api, results.length])

  if (results.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const safeIndex = Math.min(current, results.length - 1)
  const currentOrg = results[safeIndex].org
  const rated = isRated(currentOrg.id)

  const handleYes = () => {
    onFeedback?.(currentOrg.id, true)
    setReasonOpen(false)
    // 적절한 추천은 덱에 남기되 평가 영역만 숨긴다(영속 — 재방문해도 다시 안 뜬다).
    recordFeedback(currentOrg.id, "appropriate")
  }
  const selectReason = (reasonKey: (typeof DECLINE_REASON_KEYS)[number]) => {
    onFeedback?.(currentOrg.id, false, t(reasonKey))
    setReasonOpen(false)
    // 부적절 응답의 영속(feedback-store)은 부모(discover-tabs.handleFeedback)가 제외 처리와
    // 함께 담당한다 — 여기선 즉시 목록 제거(results prop 변경)만 기다린다.
  }

  return (
    <div className="flex flex-col gap-4" data-tour="discover-card">
      <Carousel setApi={setApi} className="w-full">
        <CarouselContent className="ml-0">
          {results.map((result) => (
            // 모바일은 풀폭, sm+부터 슬라이드 좌우 패딩(px-14)으로 카드를 좁혀 화살표가 들어갈 거터를 만든다
            <CarouselItem key={result.org.id} className="px-0 sm:px-14">
              {/* p-1: 카드 ring(테두리)이 캐러셀 overflow-hidden 경계에서 잘리지 않도록 여백 확보. 높이는 sm+에서만 고정 */}
              <div className="p-1 sm:min-h-[420px]">
                <RecommendationCard
                  result={result}
                  viewerRole={viewerRole}
                  bookmarked={bookmarkedIds?.has(result.org.id)}
                  onBookmark={() => onBookmark?.(result.org.id)}
                  onDetail={() => onDetail?.(result.org.id)}
                  onMeeting={() => onMeeting?.(result.org.id)}
                />
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        {/* 화살표는 뷰포트 안쪽(left-2/right-2)에 둬서 화면 밖으로 안 잘림. 슬라이드 px-14 거터 위라 카드도 안 가림. 모바일은 스와이프 */}
        <CarouselPrevious
          aria-label={t("prevAria")}
          className="left-2 hidden sm:flex"
        />
        <CarouselNext
          aria-label={t("nextAria")}
          className="right-2 hidden sm:flex"
        />
      </Carousel>

      {/* 피드백 — 카드(캐러셀) 바로 아래 밀착, muted. 추천 적절성(예/아니오) + 거절 사유를 캡처(#14).
          '예'로 평가했거나 사유 선택(제외) 후에는 노출하지 않는다. */}
      {!rated &&
        (!reasonOpen ? (
          <Item
            variant="muted"
            size="sm"
            className="flex-col items-stretch sm:flex-row sm:items-center"
            data-tour="discover-feedback"
          >
            <ItemContent>
              <ItemTitle>{t("feedbackPrompt")}</ItemTitle>
            </ItemContent>
            <ItemActions className="w-full sm:w-auto">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={handleYes}
              >
                <ThumbsUp data-icon="inline-start" />
                {t("yes")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={() => setReasonOpen(true)}
              >
                <ThumbsDown data-icon="inline-start" />
                {t("no")}
              </Button>
            </ItemActions>
          </Item>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{t("reasonHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {DECLINE_REASON_KEYS.map((reasonKey) => (
                <Button
                  key={reasonKey}
                  variant="outline"
                  size="sm"
                  onClick={() => selectReason(reasonKey)}
                >
                  {t(reasonKey)}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setReasonOpen(false)}
            >
              {t("back")}
            </Button>
          </div>
        ))}
    </div>
  )
}
