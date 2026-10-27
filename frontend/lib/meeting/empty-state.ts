// 미팅 0건일 때 역할별 안내·다음행동을 결정하는 순수 모듈 (F-MY-001 D13).
// 참가사·바이어 모두 DV-001(기업 탐색)로 보낸다.
// 라우트만 결정 — 렌더는 meeting-empty-state 컴포넌트가 한다.
//
// 예외: 행사의 참가자 메뉴가 "미팅만"이면(F-NV-001 D15 — 기본값) 기업 탐색이 메뉴에 없다 — 그 행사에서는
// 탐색으로 보내는 버튼을 내지 않고, 탐색을 권하지 않는 중립 안내만 낸다(역할 공통). 위의 "탐색으로
// 보낸다"는 전체 메뉴("full")로 설정한 행사의 동작이다.

import { DEFAULT_PARTICIPANT_MENU, type ParticipantMenu } from "@/lib/event/participant-menu"
import type { ViewerRole } from "@/lib/types"
import type { Translator } from "./meeting-projection"

export interface EmptyCta {
  label: string
  href: string
}

export interface MeetingEmptyState {
  title: string
  description: string
  // 다음 행동 버튼. "미팅만" 행사에서는 없다(갈 곳이 메뉴에 없다).
  primary?: EmptyCta
  secondary?: EmptyCta
}

const DV_001_DISCOVER = "/discover"

// t는 "meeting.emptyState" 네임스페이스(messages/{ko,en}.json) 번역기 — 필수 인자다(한국어 폴백
// 없음, meeting-projection.labelFor 주석 참고). participantMenu를 생략하면 기본값(미팅만)이다.
export function resolveMeetingEmptyState(
  role: ViewerRole,
  t: Translator,
  participantMenu: ParticipantMenu = DEFAULT_PARTICIPANT_MENU,
): MeetingEmptyState {
  const title = t("title")
  if (participantMenu === "meetings_only") {
    return { title, description: t("meetingsOnlyDescription") }
  }
  if (role === "exhibitor") {
    return {
      title,
      description: t("exhibitorDescription"),
      primary: { label: t("exhibitorCta"), href: DV_001_DISCOVER },
    }
  }
  return {
    title,
    description: t("buyerDescription"),
    primary: { label: t("buyerCta"), href: DV_001_DISCOVER },
  }
}
