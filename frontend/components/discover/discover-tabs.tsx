"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SwipeDeck } from "./swipe-deck"
import { OrgList } from "./org-list"
import { useOrgDetail } from "./org-detail-modal"
import { useMeetingRequest } from "@/components/meeting/meeting-request-provider"
import { toast } from "sonner"
import { sessionApiClient } from "@/lib/api-client/session"
import type { MatchResult } from "@/lib/api-client"
import { useBookmarks } from "@/lib/discover/bookmark-store"
import { clearFeedback, getFeedbackAnswer, recordFeedback } from "@/lib/discover/feedback-store"
import type { Organization, ViewerRole } from "@/lib/types"

type TabKey = "ai" | "all" | "bookmarks"

const VALID_TABS: readonly TabKey[] = ["ai", "all", "bookmarks"]

function normalizeTab(value: string | null): TabKey {
  const tab = VALID_TABS.includes(value as TabKey) ? (value as TabKey) : null
  return tab ?? "ai"
}

interface DiscoverTabsProps {
  viewerRole: ViewerRole
  orgs: Organization[]
  viewerOrg?: Organization
  // 상대 역할 후보를 랭킹한 AI 추천(점수+사유). 점수계산은 seam 뒤(MockApiClient)에서 끝났고
  // 여기선 렌더링만 한다(ADR-0008, #88). 미로그인/뷰어 부재 시 빈 목록.
  recommendations?: MatchResult[]
}

export function DiscoverTabs({
  viewerRole,
  orgs,
  viewerOrg,
  recommendations: baseRecommendations = [],
}: DiscoverTabsProps) {
  const t = useTranslations("discover")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { open: openOrgDetail } = useOrgDetail()
  const { open: openMeetingRequest } = useMeetingRequest()
  const activeTab = normalizeTab(searchParams.get("tab"))

  // 관심기업은 탭·상세(별도 라우트)가 공유하는 스토어로 유지(F-DV-001 D12, 이슈 #13).
  const { bookmarkedIds, toggle: toggleBookmark } = useBookmarks()
  // "부적절" 피드백으로 제외된 기업 — 초기값은 localStorage에 영속된 과거 응답에서 복원한다
  // (lib/discover/feedback-store, QA #E: 재방문 시 이미 답한 기업이 다시 노출되던 문제 수정).
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const r of baseRecommendations) {
      if (getFeedbackAnswer(r.org.id) === "inappropriate") initial.add(r.org.id)
    }
    return initial
  })

  // dev ?as 세션을 유지하며 현재 경로 쿼리를 만든다(탭 전환·상세 진입 공용).
  function withSession(entries: Record<string, string>): string {
    const params = new URLSearchParams()
    const as = searchParams.get("as")
    if (as) params.set("as", as)
    for (const [k, v] of Object.entries(entries)) params.set(k, v)
    return params.toString()
  }

  // 카드 클릭 → 상세(DV-002)를 공유 모달로 연다(app-shell의 OrgDetailProvider).
  // AI 추천 경유(from=ai)면 적합도·이유를 함께 넘겨 배너를 띄운다(F-DV-001 D6). 딥링크(공유·
  // 새로고침)는 /discover/:id 풀페이지가 그대로 받는다.
  function selectOrg(orgId: string, from: TabKey) {
    const rec =
      from === "ai"
        ? baseRecommendations.find((r) => r.org.id === orgId)
        : undefined
    const org = rec?.org ?? orgs.find((o) => o.id === orgId)
    if (!org) return
    const match = rec
      ? { score: rec.aiScore, reasons: rec.aiReasons }
      : undefined
    openOrgDetail(org, {
      viewerRole,
      match,
      bookmarkSource: from === "ai" ? "ai" : "all",
    })
  }

  // 카드의 "미팅 신청" → 공유 미팅 신청 모달(F-MT-001). 상세를 거치지 않고 카드에서 바로 연다.
  function requestMeeting(orgId: string) {
    const org =
      baseRecommendations.find((r) => r.org.id === orgId)?.org ??
      orgs.find((o) => o.id === orgId)
    if (!org) return
    openMeetingRequest(org, { viewerRole })
  }

  // AI 추천은 seam에서 받은 랭킹(완전 대칭, 상대 역할만)을 그대로 쓴다 — 부적절 피드백만 클라에서 제외.
  const recommendations = baseRecommendations.filter(
    (r) => !excludedIds.has(r.org.id)
  )

  // orgs는 이미 서버(api-client seam)에서 방향별 가시성이 적용된 목록이다(lib/discover/visibility.ts
  // + 행사 설정) — 전체 기업·관심기업 탭 모두 이 한 목록만 보므로 여기서 다시 거를 필요가 없다.
  const bookmarkedOrgs = orgs.filter((o) => bookmarkedIds.has(o.id))
  // orgId→aiScore: 적합도순 정렬·배지용. 적합도는 상대(매칭 대상)에 대해서만 존재.
  const scoreByOrgId = new Map(
    baseRecommendations.map((r) => [r.org.id, r.aiScore])
  )

  function excludeOrg(orgId: string) {
    setExcludedIds((prev) => new Set(prev).add(orgId))
  }
  function restoreOrg(orgId: string) {
    setExcludedIds((prev) => {
      const next = new Set(prev)
      next.delete(orgId)
      return next
    })
    // 영속된 "부적절" 응답도 함께 지운다 — 안 지우면 다음 방문에서 다시 제외된 채로 복원돼
    // "실행 취소"가 무의미해진다.
    clearFeedback(orgId)
  }

  function handleFeedback(
    targetOrgId: string,
    appropriate: boolean,
    reason?: string
  ) {
    void sessionApiClient.recordRecommendationFeedback({
      viewerOrgId: viewerOrg?.id,
      targetOrgId,
      appropriate,
      reason,
    })
    const org = baseRecommendations.find((r) => r.org.id === targetOrgId)?.org
    const orgName = org?.name ?? t("feedback.defaultOrgName")

    if (appropriate) {
      // 적절 피드백 → 목록 유지, 토스트로만 안내
      toast(t("feedback.appropriate", { org: orgName }))
      return
    }

    // 부적절 피드백 → AI 추천기업에서 제외하고, 실행 취소 가능한 토스트로 안내.
    // 영속(feedback-store)도 여기서 기록 — 재방문 시 다시 노출되지 않게 한다(QA #E).
    excludeOrg(targetOrgId)
    recordFeedback(targetOrgId, "inappropriate")
    toast(t("feedback.excluded", { org: orgName }), {
      description: reason,
      action: {
        label: t("feedback.undo"),
        onClick: () => restoreOrg(targetOrgId),
      },
    })
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(tab) =>
        router.push(`${pathname}?${withSession({ tab })}`)
      }
      className="w-full"
    >
      <TabsList
        variant="line"
        className="w-full justify-start"
        data-tour="discover-tabs"
      >
        <TabsTrigger value="ai">{t("tabs.ai")}</TabsTrigger>
        <TabsTrigger value="all">{t("tabs.all")}</TabsTrigger>
        <TabsTrigger value="bookmarks">{t("tabs.bookmarks")}</TabsTrigger>
      </TabsList>

      <TabsContent value="ai" className="pt-2">
        <SwipeDeck
          results={recommendations}
          viewerRole={viewerRole}
          bookmarkedIds={bookmarkedIds}
          onBookmark={(id) => toggleBookmark(id, "ai")}
          onDetail={(id) => selectOrg(id, "ai")}
          onMeeting={(id) => requestMeeting(id)}
          onFeedback={handleFeedback}
        />
      </TabsContent>

      <TabsContent value="all" className="flex flex-col gap-3 pt-2">
        <OrgList
          orgs={orgs}
          viewerRole={viewerRole}
          bookmarkedIds={bookmarkedIds}
          onBookmark={(id) => toggleBookmark(id, "all")}
          onSelect={(id) => selectOrg(id, "all")}
          scores={scoreByOrgId}
        />
      </TabsContent>

      <TabsContent value="bookmarks" className="pt-2">
        <OrgList
          orgs={bookmarkedOrgs}
          viewerRole={viewerRole}
          showFilters={false}
          emptyLabel={t("list.emptyBookmarks")}
          bookmarkedIds={bookmarkedIds}
          onBookmark={(id) => toggleBookmark(id, "all")}
          onSelect={(id) => selectOrg(id, "bookmarks")}
          scores={scoreByOrgId}
        />
      </TabsContent>
    </Tabs>
  )
}
