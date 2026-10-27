"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useBookmarks, type BookmarkSource } from "./bookmark-store"
import type { Organization } from "@/lib/types"

// 관심기업 담기/해제 + 토스트를 한곳으로 모은 훅. 상세를 여는 헤더 아이콘·하단 액션바가
// 이 한 함수를 공유해 어디를 눌러도 동일하게 토글된다. 토스트는 setState 업데이터 밖에서
// 호출한다 — StrictMode의 업데이터 이중 실행에도 토스트가 1회만 뜨도록(회귀 방지).
export function useOrgBookmark(org: Organization, source: BookmarkSource = "all") {
  const t = useTranslations("discover.bookmarkToast")
  const { isBookmarked, toggle } = useBookmarks()
  const bookmarked = isBookmarked(org.id)

  function toggleBookmark() {
    const willBookmark = !bookmarked
    toggle(org.id, source)
    toast(willBookmark ? t("added", { org: org.name }) : t("removed", { org: org.name }))
  }

  return { bookmarked, toggleBookmark }
}
