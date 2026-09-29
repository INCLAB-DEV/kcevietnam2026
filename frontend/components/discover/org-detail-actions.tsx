"use client"

import { useTranslations } from "next-intl"
import { Bookmark } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useMeetingRequest } from "@/components/meeting/meeting-request-provider"
import type { Organization, ViewerRole } from "@/lib/types"
import type { MeetingAvailability } from "@/lib/meeting/types"

interface OrgDetailActionsProps {
  org: Organization
  viewerRole: ViewerRole
  bookmarked: boolean
  onToggleBookmark: () => void
  // 미팅 신청 모달용 가용성(슬롯·장소·AI 초안). 풀페이지는 서버에서 미리 읽어 내려주고,
  // 모달은 생략 — 그 경우 미팅 신청 호스트가 route handler로 lazy-fetch한다(seam은 server-only).
  availability?: MeetingAvailability
}

// 상세의 하단 액션(관심기업 토글 + 미팅 신청). 미팅 플로우 자체는 이 컴포넌트가 소유하지 않고
// 공유 호스트(MeetingRequestProvider)에 위임한다 — 상세·AI 추천 카드 등 "미팅 신청"을 누르는
// 모든 곳이 같은 모달을 열도록(정의 중복 제거, F-MT-001). 버튼 레이아웃(스티키 바 vs 다이얼로그
// 푸터)만 caller가 flex 컨테이너로 감싼다.
export function OrgDetailActions({
  org,
  viewerRole,
  bookmarked,
  onToggleBookmark,
  availability,
}: OrgDetailActionsProps) {
  const t = useTranslations("discover.card")
  const { open: openMeetingRequest, pendingOrgId } = useMeetingRequest()
  // 이 기업의 가용성을 lazy-fetch 중이면 버튼을 잠가 중복 요청·무동작 체감을 막는다.
  const meetingPending = pendingOrgId === org.id

  return (
    <>
      <Button
        variant="outline"
        className="flex-1"
        aria-pressed={bookmarked}
        onClick={onToggleBookmark}
      >
        <Bookmark data-icon="inline-start" className={cn(bookmarked && "fill-current")} />
        {bookmarked ? t("bookmarkAdded") : t("bookmark")}
      </Button>
      <Button
        className="flex-[2]"
        disabled={meetingPending}
        onClick={() => openMeetingRequest(org, { viewerRole, availability })}
      >
        {meetingPending && <Spinner data-icon="inline-start" />}
        {t("requestMeeting")}
      </Button>
    </>
  )
}
