export type OrgRole = "exhibitor" | "buyer"
export type ViewerRole = "buyer" | "exhibitor"

// 바이어 하위유형 (organization_event_roles.buyer_subtype). 표시 라벨은 여기 두지 않는다 —
// 참가자 화면은 messages의 common.buyerType.{code}, 운영자 콘솔(한국어 고정)은
// lib/organizer/participant-labels.ts의 BUYER_TYPE_LABELS를 쓴다.
export type BuyerType = "hosted" | "pre_registered" | "on_site"

// 전시장 부스 계층 (CONTEXT.md "전시장 부스 계층"): Hall Number / Hall 이름(관) / Booth code.
// 백엔드는 halls·booths 정규화. 프론트는 표시용으로 계층을 함께 들고 다닌다.
export interface Booth {
  hallNo: string // 홀 번호(정렬·식별), 예 "1" / "A"
  hallName: string // 홀 이름, 예 "제1전시관"
  code: string // 부스 코드, 예 "b-12"
}

// 부스 표시값은 {Hall 이름} {Booth code} 파생 (평문 저장 아님)
export function boothLabel(booth?: Booth): string | undefined {
  return booth ? `${booth.hallName} ${booth.code}` : undefined
}

export interface Organization {
  id: string
  name: string
  role: OrgRole
  keywords: string[]
  // exhibitor fields
  booth?: Booth // 부스 위치 (booth_id → halls/booths)
  strength?: string // 강점/차별점 (exhibitor_profiles.strength)
  exhibits?: string[] // 전시 제품 (exhibitor_profiles.exhibits[])
  achievements?: string[] // 주요 실적 (exhibitor_profiles.achievements[]) — 상세 전용
  // 카테고리(content_category, 3종·셀러 전용·단일선택) — Hall 필터를 대체하는 회사 분류축
  // (exhibitor_profiles.content_category, kct001tax01). 바이어 카드에서는 항상 undefined.
  contentCategory?: string
  // buyer fields
  buyerType?: BuyerType // 바이어 유형 (organization_event_roles.buyer_subtype)
  description?: string // 기업 소개 (organizations.description)
  budgetRange?: string // 예산 범위 (buyer_profiles.budget_range)
  adoptionTimeline?: string // 도입 시기 (buyer_profiles.adoption_timeline)
  // 공통 기업 정보 (organizations) — 상세 전용. 카드엔 없는 정보 밀도(F-DV-001 D5)
  founded?: string // 설립연도
  employees?: string // 직원 규모
}
