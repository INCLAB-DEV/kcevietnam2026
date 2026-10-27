import type { Organization } from "@/lib/types"
import type { MatchResult } from "./types"

// t는 next-intl getTranslations()/useTranslations()가 반환하는 t를 그대로 넘길 수 있는 최소 형태
// (lib/meeting/meeting-projection.ts와 동일 패턴) — 이 모듈은 next-intl 런타임 없이도 테스트한다.
export type Translator = (key: string, values?: Record<string, string | number>) => string

// AI 매칭 점수계산(휴리스틱) — Jaccard 키워드 유사도 + 도입시기 보너스 + 사유 생성.
// ADR-0008: compute/AI는 백엔드 소유. 이 모듈은 ApiClient seam(MockApiClient.getRecommendations)
// 뒤에서만 호출된다(mock.ts에서 동적 import) — 휴리스틱을 브라우저 번들로 노출하지 않으려고.
// 실연동 시 이 계산은 FastAPI 매처로 이관되고, 호출처(seam)는 그대로다.
//
// 범위 밖: 적합도(fit score) 재정의는 미해결 도메인 결정(CONTEXT.md)이라 별도 HITL에서 다룬다.
// 이 모듈은 현 알고리즘을 seam 뒤로 옮기기만 한다(#88, 단순 relocation).
//
// t는 "discover" 네임스페이스 번역기(추천 사유 문장) — 필수 인자다. 한국어 폴백은 두지 않는다:
// 참가자 화면 호출부가 t를 빠뜨리면 EN 화면에 한국어 사유 문장이 그대로 남는다. 한국어 고정 호출부
// (운영자 배정 미리보기)와 단위 테스트는 lib/i18n/ko-translator의 koTranslator("discover")를 넘긴다.
export function computeRecommendations(
  viewer: Organization,
  candidates: Organization[],
  t: Translator
): MatchResult[] {
  return candidates
    .map((candidate) => score(viewer, candidate, t))
    .sort((a, b) => b.aiScore - a.aiScore)
}

function score(viewer: Organization, candidate: Organization, t: Translator): MatchResult {
  const shared = viewer.keywords.filter((kw) => candidate.keywords.includes(kw))
  const union = new Set([...viewer.keywords, ...candidate.keywords]).size
  const overlapScore = union > 0 ? Math.round((shared.length / union) * 80) : 0

  // 도입 시기 보너스: 바이어가 "6개월 내/1년 내"면 +10~20
  const urgencyBonus = getUrgencyBonus(viewer.adoptionTimeline)

  const aiScore = Math.min(100, overlapScore + urgencyBonus)

  const aiReasons = buildReasons(viewer, candidate, shared, t)

  return { org: candidate, aiScore, aiReasons }
}

function getUrgencyBonus(timeline: string | undefined): number {
  if (timeline === "6개월 내") return 20
  if (timeline === "1년 내") return 10
  return 0
}

function buildReasons(
  viewer: Organization,
  candidate: Organization,
  shared: string[],
  t: Translator
): string[] {
  const reasons: string[] = []

  if (shared.length > 0) {
    reasons.push(t("reasons.sharedInterest", { fields: shared.slice(0, 2).join("', '") }))
  }

  if (viewer.budgetRange && candidate.strength) {
    reasons.push(t("reasons.budgetFit", { budget: viewer.budgetRange }))
  }

  if (reasons.length === 0) {
    reasons.push(t("reasons.general"))
  }

  return reasons
}
