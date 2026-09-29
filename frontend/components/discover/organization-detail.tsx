"use client"

import { useTranslations } from "next-intl"
import { ArrowLeft, Bookmark } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { OrgDetailBody, type DetailMatch } from "./org-detail-body"
import { OrgDetailActions } from "./org-detail-actions"
import { useOrgBookmark } from "@/lib/discover/use-org-bookmark"
import type { BookmarkSource } from "@/lib/discover/bookmark-store"
import type { Organization, ViewerRole } from "@/lib/types"
import type { MeetingAvailability } from "@/lib/meeting/types"

// 상세를 여는 화면들이 공유하는 적합도 타입 — 단일 소스는 org-detail-body.
export type { DetailMatch }

interface OrganizationDetailProps {
  org: Organization
  viewerRole: ViewerRole
  match?: DetailMatch
  backHref: string
  // 이 상세로 진입한 경로의 출처 — AI 추천 탭 경유면 "ai", 그 외면 "all"(F-DV-001 D12).
  bookmarkSource?: BookmarkSource
  // 미팅 신청 모달용 가용성(슬롯·장소·AI 초안) — 서버에서 api-client로 읽어 내려준다.
  availability?: MeetingAvailability
}

// DV-002 풀페이지 — 딥링크(공유·새로고침) 폴백. 카드 클릭 등 앱 내 진입은
// 공유 모달(OrgDetailProvider)로 열고, 이 페이지와 모달은 같은 OrgDetailBody·OrgDetailActions를
// 재사용한다(본문·액션 정의는 한 곳뿐).
export function OrganizationDetail({
  org,
  viewerRole,
  match,
  backHref,
  bookmarkSource = "all",
  availability,
}: OrganizationDetailProps) {
  const t = useTranslations("discover")
  // 탭과 동일 스토어를 구독 — 전체 기업 탭 등에서 담은 기업은 여기서도 채워진 상태로 보인다.
  const { bookmarked, toggleBookmark } = useOrgBookmark(org, bookmarkSource)

  return (
    <div className="mx-auto flex min-h-[calc(100svh-5rem)] w-full min-w-0 max-w-2xl flex-col">
      {/* 헤더 — 뒤로가기 + 기업명 + 북마크 */}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-1 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" aria-label={t("detail.backAria")} asChild>
          <a href={backHref}>
            <ArrowLeft />
          </a>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">{org.name}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={bookmarked ? t("card.bookmarkRemoveAria") : t("card.bookmarkAddAria")}
          aria-pressed={bookmarked}
          onClick={toggleBookmark}
        >
          <Bookmark className={cn(bookmarked && "fill-current text-foreground")} />
        </Button>
      </header>

      <div className="px-1 py-6">
        <OrgDetailBody org={org} match={match} />
      </div>

      {/* 하단 액션 바 — sticky로 콘텐츠 컬럼 안에 고정해 좌측 nav(사이드바)를 덮지 않게 한다 */}
      <div className="sticky bottom-0 z-20 mt-auto border-t bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <OrgDetailActions
            org={org}
            viewerRole={viewerRole}
            bookmarked={bookmarked}
            onToggleBookmark={toggleBookmark}
            availability={availability}
          />
        </div>
      </div>
    </div>
  )
}
