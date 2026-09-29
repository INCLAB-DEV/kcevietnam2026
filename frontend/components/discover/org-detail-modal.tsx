"use client"

import { createContext, useContext, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { OrgDetailBody, type DetailMatch } from "./org-detail-body"
import { OrgDetailActions } from "./org-detail-actions"
import { useOrgBookmark } from "@/lib/discover/use-org-bookmark"
import { BUYER_TYPE_LABELS } from "@/lib/types"
import type { Organization, ViewerRole } from "@/lib/types"
import type { BookmarkSource } from "@/lib/discover/bookmark-store"

export interface OpenOrgDetailOptions {
  viewerRole: ViewerRole
  // 매칭 맥락(AI 추천 탭·미팅) 진입 시의 적합도·이유. 없으면 배너 미노출(F-DV-001 D6).
  match?: DetailMatch
  // 담은 출처: AI 추천 경유면 "ai", 그 외면 "all"(F-DV-001 D12).
  bookmarkSource?: BookmarkSource
}

interface OrgDetailContextValue {
  open: (org: Organization, options: OpenOrgDetailOptions) => void
  close: () => void
  // provider가 실제로 마운트돼 있는가 — 소비자가 "모달로 연다 vs 풀페이지 폴백"을 분기하는 데 쓴다.
  // false면 open()이 no-op이므로 소비자는 preventDefault 하지 말고 링크(detailHref)로 흘려보내야 한다.
  enabled: boolean
}

// provider 밖에서 호출돼도 앱이 죽지 않게 no-op 기본값을 둔다(격리 렌더·테스트 안전).
// 실제 열림은 OrgDetailProvider가 값을 주입할 때만 동작한다(enabled=true).
const OrgDetailContext = createContext<OrgDetailContextValue>({
  open: () => {},
  close: () => {},
  enabled: false,
})

export function useOrgDetail() {
  return useContext(OrgDetailContext)
}

interface OrgDetailState {
  org: Organization
  options: OpenOrgDetailOptions
}

// 기업 상세(DV-002)를 모달로 띄우는 단일 호스트. app-shell에 1회 마운트되면
// 어느 페이지(기업 탐색·내 미팅 등)든 useOrgDetail().open(org, ...)로 같은 상세를 연다.
// 상세 본문은 공통 OrgDetailBody, 하단 액션은 풀페이지와 공유하는 OrgDetailActions.
export function OrgDetailProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OrgDetailState | null>(null)

  const value = useMemo<OrgDetailContextValue>(
    () => ({
      open: (org, options) => setState({ org, options }),
      close: () => setState(null),
      enabled: true,
    }),
    []
  )

  return (
    <OrgDetailContext.Provider value={value}>
      {children}
      <Dialog open={state !== null} onOpenChange={(o) => !o && setState(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          {/* radix가 닫힐 때 언마운트 → 열 때마다 상태(북마크 구독·미팅 플로우)가 새로 마운트된다. */}
          {state && <OrgDetailModalContent org={state.org} options={state.options} />}
        </DialogContent>
      </Dialog>
    </OrgDetailContext.Provider>
  )
}

function OrgDetailModalContent({ org, options }: OrgDetailState) {
  const t = useTranslations("discover")
  const { viewerRole, match, bookmarkSource } = options
  const { bookmarked, toggleBookmark } = useOrgBookmark(org, bookmarkSource ?? "all")
  const buyerLabel = org.role === "buyer" && org.buyerType ? BUYER_TYPE_LABELS[org.buyerType] : null

  return (
    <div className="flex max-h-[inherit] flex-col">
      {/* 헤더 — 기업명만. 닫기(X)는 DialogContent가 제공. 관심기업 토글은 하단 액션바에 있다. */}
      <DialogHeader className="border-b pr-12">
        <DialogTitle className="truncate">{org.name}</DialogTitle>
        {buyerLabel && (
          <DialogDescription className="mt-0.5">{t("detail.buyerSuffix", { type: buyerLabel })}</DialogDescription>
        )}
      </DialogHeader>

      {/* 본문(스크롤) — 필드는 공통 OrgDetailBody 한 곳에서만 정의 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <OrgDetailBody org={org} match={match} />
      </div>

      {/* 하단 액션 — 풀페이지와 동일한 OrgDetailActions 재사용(availability는 lazy-fetch) */}
      <DialogFooter className="border-t">
        <OrgDetailActions
          org={org}
          viewerRole={viewerRole}
          bookmarked={bookmarked}
          onToggleBookmark={toggleBookmark}
        />
      </DialogFooter>
    </div>
  )
}
