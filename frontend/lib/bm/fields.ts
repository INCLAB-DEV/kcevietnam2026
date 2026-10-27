// 고정 코드 → 국문 라벨 (표시용). 코드 집합·라벨의 권위는 docs/db/bm-profile-fields.md §1.
// API 는 code 로 주고받고, 화면은 이 맵으로 라벨을 보여준다(매칭 식별자=code, 표시=label).
// 순서는 폼 노출 순서를 따른다(원본 등록폼 순). 코드가 schemas.py Literal 과 어긋나면 빌드는
// 통과하되 잘못된 code 가 422로 떨어진다 — types.ts 유니온이 1차 방어선.

import type {
  AcquisitionChannel,
  AdoptionTimeline,
  AnnualSalesBuyer,
  AnnualSalesSeller,
  BudgetRange,
  BusinessFieldCode,
  ContentCategoryCode,
  EmployeeRange,
  Lang,
  OrgTypeCode,
  ParticipationRoute,
  ProductPriceRange,
} from "./types"

// 옵션 목록 헬퍼 — code 순서를 보존한 [code, label] 배열.
export type Option<T extends string> = { code: T; label: string }

// 참가자(참가사) 화면 로케일 — 운영자·관리자 콘솔은 항상 ko(인자를 안 넘기면 이 값이 기본).
export type FieldLocale = "ko" | "en"

function options<T extends string>(entries: Record<T, string>): Option<T>[] {
  return (Object.keys(entries) as T[]).map((code) => ({ code, label: entries[code] }))
}

// 코드 → 라벨 안전 조회(화면 표시 전용) — 맵에 없는 코드(레거시·드리프트·아직 못 채운 신규 코드)는
// 원문을 그대로 돌려준다(데이터 유실 방지). enum 코드가 라벨 없이 그대로 노출되는 버그를 막을 때 쓴다.
export function labelFor<T extends string>(
  labels: Record<T, string>,
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined
  return (labels as Record<string, string>)[code] ?? code
}

export function labelsFor<T extends string>(
  labels: Record<T, string>,
  codes: string[] | null | undefined,
): string[] {
  return (codes ?? []).map((code) => (labels as Record<string, string>)[code] ?? code)
}

// Option[] 버전(예: BUYER_COUNTRY_OPTIONS처럼 Record가 아니라 배열로 관리하는 코드 집합) — 같은
// 폴백 규칙(맵에 없으면 원문 유지).
export function labelsForOptions<T extends string>(
  options: Option<T>[],
  codes: string[] | null | undefined,
): string[] {
  return (codes ?? []).map((code) => options.find((o) => o.code === code)?.label ?? code)
}

// 사업분야 8종 (셀러 전시품목 = 바이어 관심분야) — bm-profile-fields §1.1. K-콘텐츠 택소노미
// (kct001tax01)가 옛 방산 13분야(defense_field)를 대체. ko 라벨은 backend demo_seed.py의
// DEMO_BUSINESS_FIELDS와 동치 유지(다르면 재시드가 keyword 마스터 라벨을 조용히 갈아치운다).
export const BUSINESS_FIELD_LABELS: Record<BusinessFieldCode, string> = {
  game_production: "게임 제작",
  animation_distribution: "애니메이션 유통 및 배급",
  content_production: "콘텐츠 제작",
  music_platform: "음악 플랫폼",
  newtech_content: "신기술융합콘텐츠",
  character_licensor: "캐릭터 라이센서",
  webtoon_production: "만화웹툰 제작",
  music_production: "음악 제작",
}

// 카테고리 3종 (셀러 전용·단일선택) — kct001tax01 신설. Hall 필터를 대체하는 회사 분류축(discover).
export const CONTENT_CATEGORY_LABELS: Record<ContentCategoryCode, string> = {
  animation_character: "애니메이션/캐릭터",
  broadcasting: "방송",
  comics_game_music: "만화,웹툰/게임/음악",
}

// 참가자 구분 8종 — bm-profile-fields §1.1. 코드는 backend Literal(schemas.py OrgTypeCode)과 고정
// 결합이라 그대로 두고, 라벨만 K-콘텐츠 행사 어휘로 바꿨다(옛 DX Korea 방산 전시 라벨 정리, 2026-09-10).
// 순서 = 폼 노출 순서. private_defense(군납)는 이 행사에서 고를 이유가 없어 아래 ORG_TYPE_OPTIONS에서
// 빼지만, 라벨은 남겨 과거 데이터가 빈칸으로 보이지 않게 한다.
export const ORG_TYPE_LABELS: Record<OrgTypeCode, string> = {
  private_commercial: "민간기업(제작·유통)",
  media: "방송·미디어",
  exhibition_agent: "전시·에이전시",
  association: "협회 및 단체",
  government: "정부 및 공공기관",
  local_gov: "지자체 및 기관",
  other: "기타",
  private_defense: "민간기업(기타)", // 레거시 코드 — 선택지에는 없다(표시 전용)
}

// 상담 가능 언어 — bm-profile-fields §1.2. PPT 슬라이드6 확정(REQ-06A): 영어·베트남어 2종만.
export const LANGUAGE_LABELS: Record<Lang, string> = {
  en: "영어",
  vi: "베트남어",
}

// 셀러 연매출(억원) — bm-profile-fields §1.4.
export const ANNUAL_SALES_SELLER_LABELS: Record<AnnualSalesSeller, string> = {
  krw_1_5: "1~5억원",
  krw_5_10: "5~10억원",
  krw_10_50: "10~50억원",
  krw_50plus: "50억원 이상",
}

// 바이어 연매출(USD) — bm-profile-fields §1.4. 셀러(위, KRW)와 코드 집합이 다르다(schemas.py
// AnnualSalesBuyer). fields.ts 나머지 맵은 셀러 등록폼(F-BM-002)과 공유되지만 이 3종(연매출·예산·
// 도입시기)은 바이어 전용이라 F-BM-001 쪽에서만 쓰인다(운영자/어드민 콘솔의 표시 변환 용도).
export const ANNUAL_SALES_BUYER_LABELS: Record<AnnualSalesBuyer, string> = {
  usd_lt_500k: "USD 500,000 미만",
  usd_500k_1m: "USD 500,000 ~ 1,000,000",
  usd_1m_5m: "USD 1,000,000 ~ 5,000,000",
  usd_gt_5m: "USD 5,000,000 초과",
}

export const EMPLOYEE_RANGE_LABELS: Record<EmployeeRange, string> = {
  e_0_10: "10명 이하",
  e_11_50: "11~50명",
  e_51_100: "51~100명",
  e_101plus: "101명 이상",
}

// 상품 가격대(백만원) — bm-profile-fields §1.4.
export const PRODUCT_PRICE_RANGE_LABELS: Record<ProductPriceRange, string> = {
  krw_0_10m: "0~1천만원",
  krw_10_30m: "1천만~3천만원",
  krw_30_50m: "3천만~5천만원",
  krw_50_70m: "5천만~7천만원",
  krw_70_100m: "7천만~1억원",
}

// 참가 경로 — bm-profile-fields §1.3.
export const PARTICIPATION_ROUTE_LABELS: Record<ParticipationRoute, string> = {
  re_1_2: "재참가(1~2회)",
  re_3_5: "재참가(3~5회)",
  re_6plus: "재참가(6회 이상)",
  new: "신규 참가",
}

// New 획득채널 — route='new' 일 때만 노출/허용(조건부, §1.3).
export const ACQUISITION_CHANNEL_LABELS: Record<AcquisitionChannel, string> = {
  edm: "EDM(이메일)",
  official_letter: "공문",
  kotra_invitation: "KOTRA 초청",
  website_sns: "웹사이트/SNS",
  media: "미디어",
}

// 바이어 전용 — 지출 가능 예산(USD, §1.4).
export const BUDGET_RANGE_LABELS: Record<BudgetRange, string> = {
  usd_lt_100k: "USD 100,000 미만",
  usd_100k_500k: "USD 100,000 ~ 500,000",
  usd_500k_1m: "USD 500,000 ~ 1,000,000",
  usd_1m_5m: "USD 1,000,000 ~ 5,000,000",
  usd_5m_10m: "USD 5,000,000 ~ 10,000,000",
  usd_10m_plus: "USD 10,000,000 이상",
}

// 바이어 전용 — 도입 시기(§1.4).
export const ADOPTION_TIMELINE_LABELS: Record<AdoptionTimeline, string> = {
  "2026_h2": "2026년 하반기",
  "2027_h1": "2027년 상반기",
  "2027_h2": "2027년 하반기",
  "2028_h1": "2028년 상반기",
  "2028_h2": "2028년 하반기",
  "2029_h1": "2029년 상반기",
  "2029_h2": "2029년 하반기",
  "2030_h1": "2030년 상반기",
  "2030_h2": "2030년 하반기",
  undecided: "미정",
}

// 부스 정보(구분) — Hall > 관(pavilion) > 부스위치 뎁스. 회원가입 정보라 폼은 읽기 전용 표시.
// 부스위치는 아직 배정 전이라 값 없음("미배정"). 이 매핑은 표시·검증·향후 편집 가능 시 선택지로 쓴다.
export const HALLS = ["7", "8", "9", "10"] as const
export type HallCode = (typeof HALLS)[number]

// ⚠ 실제 베트남 전시장 홀 구성 미확정 — K-콘텐츠 카테고리 기반 플레이스홀더(확정 시 교체).
export const HALL_PAVILIONS: Record<HallCode, string[]> = {
  "7": ["대한민국관"],
  "8": ["국제관"],
  "9": ["애니메이션·캐릭터관", "웹툰·만화관", "음악관"],
  "10": ["게임관", "방송관", "콘텐츠제작관", "신기술융합관"],
}

// 선호 바이어 국가(타겟) — K-콘텐츠 수출 시장 기준. 개최국(베트남) → 동남아 → 동아시아 → 그 외
// 주요 시장 순. 옛 DX Korea 방산 전시의 중동·중남미 타깃국 목록을 대체했다(2026-09-10).
// code=영문 슬러그(저장·매칭 식별자, 변경 시 기존 저장값과 어긋나므로 유지 대상), label=국문 표시.
// DB는 자유 텍스트 배열이라 이 목록만 고치면 되고, 기존 저장값(vietnam·thailand·indonesia·australia)은
// 그대로 살아있다.
export const BUYER_COUNTRY_OPTIONS: Option<string>[] = [
  { code: "vietnam", label: "베트남" },
  { code: "thailand", label: "태국" },
  { code: "indonesia", label: "인도네시아" },
  { code: "philippines", label: "필리핀" },
  { code: "malaysia", label: "말레이시아" },
  { code: "singapore", label: "싱가포르" },
  { code: "japan", label: "일본" },
  { code: "china", label: "중국" },
  { code: "taiwan", label: "대만" },
  { code: "hongkong", label: "홍콩" },
  { code: "india", label: "인도" },
  { code: "usa", label: "미국" },
  { code: "australia", label: "호주" },
  { code: "uk", label: "영국" },
]

export const BUSINESS_FIELD_OPTIONS = options(BUSINESS_FIELD_LABELS)
export const CONTENT_CATEGORY_OPTIONS = options(CONTENT_CATEGORY_LABELS)
// 선택지에서는 방산 전용 구분(private_defense)을 뺀다 — 라벨 맵에는 남아 과거 데이터는 그대로 표시된다.
export const ORG_TYPE_OPTIONS = options(ORG_TYPE_LABELS).filter(
  (option) => option.code !== "private_defense",
)
export const LANGUAGE_OPTIONS = options(LANGUAGE_LABELS)
export const ANNUAL_SALES_SELLER_OPTIONS = options(ANNUAL_SALES_SELLER_LABELS)
export const EMPLOYEE_RANGE_OPTIONS = options(EMPLOYEE_RANGE_LABELS)
export const PRODUCT_PRICE_RANGE_OPTIONS = options(PRODUCT_PRICE_RANGE_LABELS)
export const PARTICIPATION_ROUTE_OPTIONS = options(PARTICIPATION_ROUTE_LABELS)
export const ACQUISITION_CHANNEL_OPTIONS = options(ACQUISITION_CHANNEL_LABELS)

// ── 참가자(참가사) 화면 영문 라벨 — 이슈 #7 ────────────────────────────────────────
// 운영자·관리자 콘솔(admin/organizer)은 위 ko 전용 맵/옵션을 그대로 쓴다(호출부 불변, 회귀 없음).
// 참가자 화면(exhibitor apply-form 등)만 아래 `*OptionsFor(locale)` 게터로 전환한다.
// BUSINESS_FIELD_LABELS_EN은 discover가 이미 쓰는 backend keywords 마스터(label_en)와 동치 —
// demo_seed.py DEMO_BUSINESS_FIELDS / migrations/kct001tax01_kcontent_taxonomy_pivot.py 참고,
// 새로 창작하지 않고 그대로 가져왔다. 그 외(카테고리·구분·연매출 등)는 backend에 영문 마스터가
// 없어 이 파일에서 신규 번역했다.
export const BUSINESS_FIELD_LABELS_EN: Record<BusinessFieldCode, string> = {
  game_production: "Game Production",
  animation_distribution: "Animation Distribution",
  content_production: "Content Production",
  music_platform: "Music Platform",
  newtech_content: "New-Tech Convergence Content",
  character_licensor: "Character Licensor",
  webtoon_production: "Comics & Webtoon Production",
  music_production: "Music Production",
}

export const CONTENT_CATEGORY_LABELS_EN: Record<ContentCategoryCode, string> = {
  animation_character: "Animation & Character",
  broadcasting: "Broadcasting",
  comics_game_music: "Comics, Game & Music",
}

export const ORG_TYPE_LABELS_EN: Record<OrgTypeCode, string> = {
  private_commercial: "Private Company (Production/Distribution)",
  media: "Broadcasting/Media",
  exhibition_agent: "Exhibition/Agency",
  association: "Association/Organization",
  government: "Government/Public Institution",
  local_gov: "Local Government/Institution",
  other: "Other",
  private_defense: "Private Company (Other)", // 레거시 코드 — 선택지에는 없다(표시 전용)
}

export const LANGUAGE_LABELS_EN: Record<Lang, string> = {
  en: "English",
  vi: "Vietnamese",
}

export const ANNUAL_SALES_SELLER_LABELS_EN: Record<AnnualSalesSeller, string> = {
  krw_1_5: "KRW 100M - 500M",
  krw_5_10: "KRW 500M - 1B",
  krw_10_50: "KRW 1B - 5B",
  krw_50plus: "KRW 5B or more",
}

export const EMPLOYEE_RANGE_LABELS_EN: Record<EmployeeRange, string> = {
  e_0_10: "10 or fewer",
  e_11_50: "11 - 50",
  e_51_100: "51 - 100",
  e_101plus: "101 or more",
}

export const PRODUCT_PRICE_RANGE_LABELS_EN: Record<ProductPriceRange, string> = {
  krw_0_10m: "0 - 10M KRW",
  krw_10_30m: "10M - 30M KRW",
  krw_30_50m: "30M - 50M KRW",
  krw_50_70m: "50M - 70M KRW",
  krw_70_100m: "70M - 100M KRW",
}

export const BUYER_COUNTRY_OPTIONS_EN: Option<string>[] = [
  { code: "vietnam", label: "Vietnam" },
  { code: "thailand", label: "Thailand" },
  { code: "indonesia", label: "Indonesia" },
  { code: "philippines", label: "Philippines" },
  { code: "malaysia", label: "Malaysia" },
  { code: "singapore", label: "Singapore" },
  { code: "japan", label: "Japan" },
  { code: "china", label: "China" },
  { code: "taiwan", label: "Taiwan" },
  { code: "hongkong", label: "Hong Kong" },
  { code: "india", label: "India" },
  { code: "usa", label: "United States" },
  { code: "australia", label: "Australia" },
  { code: "uk", label: "United Kingdom" },
]

const BUSINESS_FIELD_OPTIONS_EN = options(BUSINESS_FIELD_LABELS_EN)
const CONTENT_CATEGORY_OPTIONS_EN = options(CONTENT_CATEGORY_LABELS_EN)
const ORG_TYPE_OPTIONS_EN = options(ORG_TYPE_LABELS_EN).filter(
  (option) => option.code !== "private_defense",
)
const LANGUAGE_OPTIONS_EN = options(LANGUAGE_LABELS_EN)
const ANNUAL_SALES_SELLER_OPTIONS_EN = options(ANNUAL_SALES_SELLER_LABELS_EN)
const EMPLOYEE_RANGE_OPTIONS_EN = options(EMPLOYEE_RANGE_LABELS_EN)
const PRODUCT_PRICE_RANGE_OPTIONS_EN = options(PRODUCT_PRICE_RANGE_LABELS_EN)

export function businessFieldOptionsFor(locale: FieldLocale): Option<BusinessFieldCode>[] {
  return locale === "en" ? BUSINESS_FIELD_OPTIONS_EN : BUSINESS_FIELD_OPTIONS
}
export function contentCategoryOptionsFor(locale: FieldLocale): Option<ContentCategoryCode>[] {
  return locale === "en" ? CONTENT_CATEGORY_OPTIONS_EN : CONTENT_CATEGORY_OPTIONS
}
export function orgTypeOptionsFor(locale: FieldLocale): Option<OrgTypeCode>[] {
  return locale === "en" ? ORG_TYPE_OPTIONS_EN : ORG_TYPE_OPTIONS
}
export function languageOptionsFor(locale: FieldLocale): Option<Lang>[] {
  return locale === "en" ? LANGUAGE_OPTIONS_EN : LANGUAGE_OPTIONS
}
export function annualSalesSellerOptionsFor(locale: FieldLocale): Option<AnnualSalesSeller>[] {
  return locale === "en" ? ANNUAL_SALES_SELLER_OPTIONS_EN : ANNUAL_SALES_SELLER_OPTIONS
}
export function employeeRangeOptionsFor(locale: FieldLocale): Option<EmployeeRange>[] {
  return locale === "en" ? EMPLOYEE_RANGE_OPTIONS_EN : EMPLOYEE_RANGE_OPTIONS
}
// 코드 → 라벨 맵(로케일별) — 선택지 배열이 아니라 `labelFor`로 단건 조회할 때 쓴다(탐색 상세의
// 직원 규모: lib/discover/http-discover-client.ts).
export function employeeRangeLabelsFor(locale: FieldLocale): Record<EmployeeRange, string> {
  return locale === "en" ? EMPLOYEE_RANGE_LABELS_EN : EMPLOYEE_RANGE_LABELS
}
export function productPriceRangeOptionsFor(locale: FieldLocale): Option<ProductPriceRange>[] {
  return locale === "en" ? PRODUCT_PRICE_RANGE_OPTIONS_EN : PRODUCT_PRICE_RANGE_OPTIONS
}
export function buyerCountryOptionsFor(locale: FieldLocale): Option<string>[] {
  return locale === "en" ? BUYER_COUNTRY_OPTIONS_EN : BUYER_COUNTRY_OPTIONS
}
