import type { Organization } from "@/lib/types"
import type { MatchResult } from "./types"

// t는 next-intl getTranslations()/useTranslations()가 반환하는 t를 그대로 넘길 수 있는 최소 형태
// (lib/meeting/meeting-projection.ts와 동일 패턴) — 이 모듈은 next-intl 런타임 없이도 테스트한다.
export type Translator = (key: string, values?: Record<string, string | number>) => string

// t 미주입 호출부(organizer 배정 미리보기·단위 테스트 등 i18n 범위 밖) 보존용 한국어 폴백 —
// messages/{ko,en}.json의 discover.reasons와 동일 문구를 유지한다(값이 바뀌면 양쪽 다 갱신).
const DEFAULT_REASON_T: Translator = (key, values) => {
  if (key === "reasons.sharedInterest") return `귀사의 관심 분야 '${values?.fields ?? ""}' 와(과) 사업분야가 일치합니다`
  if (key === "reasons.budgetFit") return `예산 범위(${values?.budget ?? ""})에 적합한 솔루션을 보유하고 있습니다`
  if (key === "reasons.general") return "귀사의 관심 분야와 연관된 콘텐츠 전문 기업입니다"
  return key
}

// AI 매칭 점수계산(휴리스틱) — Jaccard 키워드 유사도 + 도입시기 보너스 + 사유 생성.
// ADR-0008: compute/AI는 백엔드 소유. 이 모듈은 ApiClient seam(MockApiClient.getRecommendations)
// 뒤에서만 호출된다(mock.ts에서 동적 import) — 휴리스틱을 브라우저 번들로 노출하지 않으려고.
// 실연동 시 이 계산은 FastAPI 매처로 이관되고, 호출처(seam)는 그대로다.
//
// 범위 밖: 적합도(fit score) 재정의는 미해결 도메인 결정(CONTEXT.md)이라 별도 HITL에서 다룬다.
// 이 모듈은 현 알고리즘을 seam 뒤로 옮기기만 한다(#88, 단순 relocation).
//
// t는 "discover" 네임스페이스 번역기 — 미주입 시 한국어 폴백(참가자 화면이 아닌 organizer
// 배정 미리보기 등 로케일 없는 호출부 보존, 2026-09-13 EN 전환 잔존 정리).
export function computeRecommendations(
  viewer: Organization,
  candidates: Organization[],
  t: Translator = DEFAULT_REASON_T
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
