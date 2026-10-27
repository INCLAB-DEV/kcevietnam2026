import type { Organization } from "@/lib/types"
import { contentCategoryOptionsFor, type FieldLocale } from "@/lib/bm/fields"

// t는 next-intl getTranslations()/useTranslations()가 반환하는 t를 그대로 넘길 수 있는 최소 형태
// (lib/notifications/inbox.ts와 동일 패턴) — 이 모듈은 next-intl 런타임 없이도 테스트한다.
export type Translator = (key: string, values?: Record<string, string | number>) => string

/**
 * 전체 기업 탭의 비(非)키워드 탐색 패싯.
 *
 * 키워드 칩 필터 대신 데이터가 확정된 구조적 속성으로 거른다.
 * 역할/데이터에 따라 노출되는 패싯이 달라진다 (data-driven):
 *  - 참가사 목록 → 카테고리(content_category, 3종) — 물리적 Hall 위치 필터를 대체(kct001tax01).
 *    Hall/부스 자체는 여전히 존재하고 정렬(전시장 위치순)에 쓰이지만, 필터축은 이제 회사 분류(카테고리)다.
 *  - 바이어 목록 → 도입 시기 · 예산 범위
 *  - 공통       → 매칭율(적합도) 구간 · 관심기업 담음 여부
 */

// 패싯 선택지 한 줄 — value는 필터 매칭 키(코드·원문), label은 화면 표시값(로케일 반영).
// 둘을 나눈 이유: 카테고리처럼 코드로 저장된 값은 로케일마다 라벨이 달라지므로, 라벨을 매칭 키로
// 쓰면(예전 구현) 언어를 바꾸는 순간 선택 상태와 목록이 어긋난다.
export interface FacetOption {
  value: string
  label: string
}

// 도입 시기 표시 순서. 자유 텍스트라 숫자 정렬("6개월"<"1년")이 안 맞아 명시한다.
// ⚠ 이 값들은 화면 문구가 아니라 **목업 픽스처(lib/mock-orgs.ts)의 데이터 값**과 맞추는 키다.
// 실연동 탐색 API는 도입 시기를 내려주지 않아(http-discover-client.ts) 실 세션에선 이 패싯 자체가
// 그려지지 않는다.
export const TIMELINE_ORDER = ["6개월 내", "1년 내", "2년 내", "미정"]

// 매칭율(적합도) 임계 프리셋. value=0 은 t("facets.matchRateAll")(필터 해제) — 나머지는 숫자+%
// 표기라 로케일 무관, 그대로 둔다. 호출부(org-list.tsx)가 discover 네임스페이스 t를 주입한다.
export function scoreThresholds(t: Translator): { value: number; label: string }[] {
  return [
    { value: 0, label: t("facets.matchRateAll") },
    { value: 60, label: "60%+" },
    { value: 70, label: "70%+" },
    { value: 80, label: "80%+" },
  ]
}

// 중복 제거 + 정렬. order가 있으면 그 순서로, 없으면 선행 숫자 기준 오름차순(예산 등).
function uniqueSorted(values: (string | undefined)[], order?: string[]): string[] {
  const set = new Set<string>()
  for (const v of values) if (v) set.add(v)
  const arr = [...set]
  if (order) return arr.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return arr.sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
}

// 카테고리 패싯 옵션 — 목록에 있는 코드만, 폼 노출 순서로(가나다 아님 — contentCategoryOptionsFor가
// 폼 순서를 그대로 준다). 매칭은 코드(value)로, 표시는 로케일 라벨(label)로 한다.
export function categoryOptions(orgs: Organization[], locale: FieldLocale): FacetOption[] {
  const present = new Set(orgs.map((o) => o.contentCategory).filter((c): c is string => !!c))
  return contentCategoryOptionsFor(locale)
    .filter((option) => present.has(option.code))
    .map((option) => ({ value: option.code, label: option.label }))
}

// 자유 텍스트 값(도입 시기·예산)은 값 자체가 표시 문구다 — value와 label이 같다.
function asFacetOptions(values: string[]): FacetOption[] {
  return values.map((value) => ({ value, label: value }))
}

export function timelineOptions(orgs: Organization[]): FacetOption[] {
  return asFacetOptions(
    uniqueSorted(
      orgs.map((o) => o.adoptionTimeline),
      TIMELINE_ORDER,
    ),
  )
}
export function budgetOptions(orgs: Organization[]): FacetOption[] {
  return asFacetOptions(uniqueSorted(orgs.map((o) => o.budgetRange)))
}
