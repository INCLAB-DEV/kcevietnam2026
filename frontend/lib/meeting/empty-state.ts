// 미팅 0건일 때 역할별 안내·다음행동을 결정하는 순수 모듈 (F-MY-001 D13).
// 참가사·바이어 모두 DV-001(기업 탐색)로 보낸다.
// 라우트만 결정 — 렌더는 meeting-empty-state 컴포넌트가 한다.

import type { ViewerRole } from "@/lib/types"
import type { Translator } from "./meeting-projection"

export interface EmptyCta {
  label: string
  href: string
}

export interface MeetingEmptyState {
  title: string
  description: string
  primary: EmptyCta
  secondary?: EmptyCta
}

const DV_001_DISCOVER = "/discover"

// t 미주입 호출부(단위 테스트 등 i18n 범위 밖) 보존용 한국어 폴백 — messages/ko.json의
// meeting.emptyState와 동일 문구를 유지한다(값이 바뀌면 양쪽 다 갱신).
const FALLBACK_KO: Record<string, string> = {
  title: "아직 잡힌 미팅이 없어요",
  exhibitorDescription: "AI가 추천한 바이어를 확인하고 먼저 미팅을 제안해보세요.",
  exhibitorCta: "AI 추천 바이어 확인",
  buyerDescription: "관심 있는 참가 기업을 탐색하고 미팅을 신청해보세요.",
  buyerCta: "관심 기업 탐색",
}
const defaultT: Translator = (key) => FALLBACK_KO[key] ?? key

// t는 "meeting.emptyState" 네임스페이스(messages/{ko,en}.json) — 미주입 시 한국어 폴백.
export function resolveMeetingEmptyState(role: ViewerRole, t: Translator = defaultT): MeetingEmptyState {
  const title = t("title")
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
