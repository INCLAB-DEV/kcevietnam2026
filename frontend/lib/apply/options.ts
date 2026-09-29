// 폼 셀렉트/멀티선택 옵션 — code(backend 식별자) ↔ label(표시) 단일 소스.
// 코드값은 docs/db/bm-profile-fields.md §1 및 backend Literal과 1:1. 기본(ko) 배열은 하위 호환
// 유지용 — 참가자(바이어) 화면은 아래 `*ForLocale` 게터로 로케일에 맞는 배열을 골라 쓴다(이슈 #7).
// 영문 라벨: BUSINESS_FIELDS_EN은 backend keywords 마스터(demo_seed.py DEMO_BUSINESS_FIELDS,
// migrations/kct001tax01)의 label_en과 동치 유지(discover가 이미 그 값을 쓴다) — 새로 창작하지 않는다.
// 나머지(구분·연매출·예산 등)는 backend에 영문 마스터가 없어 이 파일에서 신규 번역했다.

import type {
  AcquisitionChannel,
  AdoptionTimeline,
  AnnualSalesBuyer,
  BudgetRange,
  BusinessFieldCode,
  BusinessPerfKorea,
  EmployeeRange,
  Lang,
  OrgTypeCode,
  ParticipationRoute,
  TravelersKorea,
} from "./types"

export interface Option<T extends string> {
  code: T
  label: string
}

export type OptLocale = "ko" | "en"

function forLocale<T extends string>(
  ko: Option<T>[],
  en: Option<T>[],
  locale: OptLocale,
): Option<T>[] {
  return locale === "en" ? en : ko
}

// 사업분야 8종 — 바이어 관심분야 = 셀러 전시품목(business_field). K-콘텐츠 택소노미(kct001tax01)가
// 옛 방산 13분야(defense_field)를 대체. 값은 lib/bm/fields.ts의 BUSINESS_FIELD_LABELS와 동치 유지.
export const BUSINESS_FIELDS: Option<BusinessFieldCode>[] = [
  { code: "game_production", label: "게임 제작" },
  { code: "animation_distribution", label: "애니메이션 유통 및 배급" },
  { code: "content_production", label: "콘텐츠 제작" },
  { code: "music_platform", label: "음악 플랫폼" },
  { code: "newtech_content", label: "신기술융합콘텐츠" },
  { code: "character_licensor", label: "캐릭터 라이센서" },
  { code: "webtoon_production", label: "만화웹툰 제작" },
  { code: "music_production", label: "음악 제작" },
]

// backend keywords 마스터(label_en)와 동치 — demo_seed.py DEMO_BUSINESS_FIELDS / migrations/kct001tax01.
export const BUSINESS_FIELDS_EN: Option<BusinessFieldCode>[] = [
  { code: "game_production", label: "Game Production" },
  { code: "animation_distribution", label: "Animation Distribution" },
  { code: "content_production", label: "Content Production" },
  { code: "music_platform", label: "Music Platform" },
  { code: "newtech_content", label: "New-Tech Convergence Content" },
  { code: "character_licensor", label: "Character Licensor" },
  { code: "webtoon_production", label: "Comics & Webtoon Production" },
  { code: "music_production", label: "Music Production" },
]

export function businessFieldOptionsFor(locale: OptLocale): Option<BusinessFieldCode>[] {
  return forLocale(BUSINESS_FIELDS, BUSINESS_FIELDS_EN, locale)
}

// 참가자 구분 8종 (org_type) — 코드는 backend Literal 고정, 라벨만 K-콘텐츠 어휘로 정리했다
// (옛 DX Korea 방산 전시 라벨 대체, 2026-09-10. lib/bm/fields.ts ORG_TYPE_LABELS와 동치 유지).
// 이 배열은 "표시용 전체 목록"이다 — labelOf가 미매칭 코드를 그대로 노출하므로 방산 전용
// private_defense도 라벨을 남겨 과거 데이터가 코드로 보이지 않게 한다.
export const ORG_TYPES: Option<OrgTypeCode>[] = [
  { code: "private_commercial", label: "민간기업(제작·유통)" },
  { code: "media", label: "방송·미디어" },
  { code: "exhibition_agent", label: "전시·에이전시" },
  { code: "association", label: "협회 및 단체" },
  { code: "government", label: "정부 및 공공기관" },
  { code: "local_gov", label: "지자체 및 기관" },
  { code: "other", label: "기타" },
  { code: "private_defense", label: "민간기업(기타)" }, // 레거시 — 선택지에는 없다(표시 전용)
]

// 폼에서 고를 수 있는 구분 — 방산 전용 코드는 제외한다(표시용은 위 ORG_TYPES).
export const ORG_TYPE_CHOICES: Option<OrgTypeCode>[] = ORG_TYPES.filter(
  (option) => option.code !== "private_defense",
)

export const ORG_TYPES_EN: Option<OrgTypeCode>[] = [
  { code: "private_commercial", label: "Private Company (Production/Distribution)" },
  { code: "media", label: "Broadcasting/Media" },
  { code: "exhibition_agent", label: "Exhibition/Agency" },
  { code: "association", label: "Association/Organization" },
  { code: "government", label: "Government/Public Institution" },
  { code: "local_gov", label: "Local Government/Institution" },
  { code: "other", label: "Other" },
  { code: "private_defense", label: "Private Company (Other)" }, // 레거시 — 선택지에는 없다(표시 전용)
]

export const ORG_TYPE_CHOICES_EN: Option<OrgTypeCode>[] = ORG_TYPES_EN.filter(
  (option) => option.code !== "private_defense",
)

export function orgTypeChoicesFor(locale: OptLocale): Option<OrgTypeCode>[] {
  return forLocale(ORG_TYPE_CHOICES, ORG_TYPE_CHOICES_EN, locale)
}

export function orgTypesFor(locale: OptLocale): Option<OrgTypeCode>[] {
  return forLocale(ORG_TYPES, ORG_TYPES_EN, locale)
}

// 상담 가능 언어 — PPT 슬라이드6 확정(REQ-06A): 영어·베트남어 2종만(2026 베트남 K-콘텐츠 엑스포).
export const LANGUAGES: Option<Lang>[] = [
  { code: "en", label: "English" },
  { code: "vi", label: "베트남어" },
]

export const LANGUAGES_EN: Option<Lang>[] = [
  { code: "en", label: "English" },
  { code: "vi", label: "Vietnamese" },
]

export function languageOptionsFor(locale: OptLocale): Option<Lang>[] {
  return forLocale(LANGUAGES, LANGUAGES_EN, locale)
}

export const ANNUAL_SALES_BUYER: Option<AnnualSalesBuyer>[] = [
  { code: "usd_lt_500k", label: "USD 500,000 미만" },
  { code: "usd_500k_1m", label: "USD 500,000 ~ 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000" },
  { code: "usd_gt_5m", label: "USD 5,000,000 초과" },
]

export const ANNUAL_SALES_BUYER_EN: Option<AnnualSalesBuyer>[] = [
  { code: "usd_lt_500k", label: "Under USD 500,000" },
  { code: "usd_500k_1m", label: "USD 500,000 - 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 - 5,000,000" },
  { code: "usd_gt_5m", label: "Over USD 5,000,000" },
]

export function annualSalesBuyerOptionsFor(locale: OptLocale): Option<AnnualSalesBuyer>[] {
  return forLocale(ANNUAL_SALES_BUYER, ANNUAL_SALES_BUYER_EN, locale)
}

// 지출 가능 예산(구매 예산, USD) — 신규. 구간은 잠정(HITL: 주최사 확인).
// 괄호 원화 환산은 USD 1 ≈ ₩1,400 가정(표시용 근사치 — 환율 확정 시 갱신).
export const BUDGET_RANGES: Option<BudgetRange>[] = [
  { code: "usd_lt_100k", label: "USD 100,000 미만 (약 1.4억원 미만)" },
  { code: "usd_100k_500k", label: "USD 100,000 ~ 500,000 (약 1.4 ~ 7억원)" },
  { code: "usd_500k_1m", label: "USD 500,000 ~ 1,000,000 (약 7 ~ 14억원)" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000 (약 14 ~ 70억원)" },
  { code: "usd_5m_10m", label: "USD 5,000,000 ~ 10,000,000 (약 70 ~ 140억원)" },
  { code: "usd_10m_plus", label: "USD 10,000,000 이상 (약 140억원 이상)" },
]

// en 로케일은 원화 환산 부연을 뺀다(이슈 #7) — discover에 이 구간의 기존 영문 표기가 없어 신규 번역.
export const BUDGET_RANGES_EN: Option<BudgetRange>[] = [
  { code: "usd_lt_100k", label: "Under USD 100,000" },
  { code: "usd_100k_500k", label: "USD 100,000 - 500,000" },
  { code: "usd_500k_1m", label: "USD 500,000 - 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 - 5,000,000" },
  { code: "usd_5m_10m", label: "USD 5,000,000 - 10,000,000" },
  { code: "usd_10m_plus", label: "USD 10,000,000 or more" },
]

export function budgetRangeOptionsFor(locale: OptLocale): Option<BudgetRange>[] {
  return forLocale(BUDGET_RANGES, BUDGET_RANGES_EN, locale)
}

// 도입 시기 — 년도+반기(2026 하반기 ~ 2030 하반기). HITL: 주최사 확인(범위·과거반기 포함 여부).
export const ADOPTION_TIMELINES: Option<AdoptionTimeline>[] = [
  { code: "2026_h2", label: "2026년 하반기" },
  { code: "2027_h1", label: "2027년 상반기" },
  { code: "2027_h2", label: "2027년 하반기" },
  { code: "2028_h1", label: "2028년 상반기" },
  { code: "2028_h2", label: "2028년 하반기" },
  { code: "2029_h1", label: "2029년 상반기" },
  { code: "2029_h2", label: "2029년 하반기" },
  { code: "2030_h1", label: "2030년 상반기" },
  { code: "2030_h2", label: "2030년 하반기" },
  { code: "undecided", label: "미정" },
]

export const ADOPTION_TIMELINES_EN: Option<AdoptionTimeline>[] = [
  { code: "2026_h2", label: "H2 2026" },
  { code: "2027_h1", label: "H1 2027" },
  { code: "2027_h2", label: "H2 2027" },
  { code: "2028_h1", label: "H1 2028" },
  { code: "2028_h2", label: "H2 2028" },
  { code: "2029_h1", label: "H1 2029" },
  { code: "2029_h2", label: "H2 2029" },
  { code: "2030_h1", label: "H1 2030" },
  { code: "2030_h2", label: "H2 2030" },
  { code: "undecided", label: "Undecided" },
]

export function adoptionTimelineOptionsFor(locale: OptLocale): Option<AdoptionTimeline>[] {
  return forLocale(ADOPTION_TIMELINES, ADOPTION_TIMELINES_EN, locale)
}

export const EMPLOYEE_RANGE: Option<EmployeeRange>[] = [
  { code: "e_0_10", label: "0 ~ 10명" },
  { code: "e_11_50", label: "11 ~ 50명" },
  { code: "e_51_100", label: "51 ~ 100명" },
  { code: "e_101plus", label: "101명 이상" },
]

export const EMPLOYEE_RANGE_EN: Option<EmployeeRange>[] = [
  { code: "e_0_10", label: "0 - 10" },
  { code: "e_11_50", label: "11 - 50" },
  { code: "e_51_100", label: "51 - 100" },
  { code: "e_101plus", label: "101 or more" },
]

export function employeeRangeOptionsFor(locale: OptLocale): Option<EmployeeRange>[] {
  return forLocale(EMPLOYEE_RANGE, EMPLOYEE_RANGE_EN, locale)
}

export const BUSINESS_PERF_KOREA: Option<BusinessPerfKorea>[] = [
  { code: "none", label: "없음" },
  { code: "usd_1_1m", label: "USD 1 ~ 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000" },
  { code: "usd_5m_plus", label: "USD 5,000,000 이상" },
]

export const TRAVELERS_KOREA: Option<TravelersKorea>[] = [
  { code: "t_0_500", label: "0 ~ 500명" },
  { code: "t_501_1000", label: "501 ~ 1,000명" },
  { code: "t_1001_5000", label: "1,001 ~ 5,000명" },
  { code: "t_5001_10000", label: "5,001 ~ 10,000명" },
  { code: "t_10000plus", label: "10,000명 이상" },
]

export const PARTICIPATION_ROUTES: Option<ParticipationRoute>[] = [
  { code: "re_1_2", label: "재참가 (1~2회)" },
  { code: "re_3_5", label: "재참가 (3~5회)" },
  { code: "re_6plus", label: "재참가 (6회 이상)" },
  { code: "new", label: "신규 참가" },
]

// New 획득채널 — participation_route='new'일 때만 노출/필수 (bm-profile-fields §1.3)
export const ACQUISITION_CHANNELS: Option<AcquisitionChannel>[] = [
  { code: "edm", label: "EDM(이메일)" },
  { code: "official_letter", label: "공문" },
  { code: "kotra_invitation", label: "KOTRA 초청" },
  { code: "website_sns", label: "웹사이트/SNS" },
  { code: "media", label: "미디어" },
]

// code → label 조회 헬퍼(요약 화면 표시용). 미상 코드는 코드 그대로 노출.
export function labelOf<T extends string>(options: Option<T>[], code: T | "" | null | undefined): string {
  if (!code) return ""
  return options.find((o) => o.code === code)?.label ?? code
}
