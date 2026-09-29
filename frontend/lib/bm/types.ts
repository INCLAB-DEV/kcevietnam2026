// F-BM-002 참가사(셀러) 프로필 작성의 클라이언트 계약.
// 백엔드(FastAPI) /api/bm/exhibitor/* 응답 형태를 camelCase 로 미러링한다 — mock→실연동 교체 시 1:1.
// 컬럼 권위 정의는 docs/db/bm-profile-fields.md(§1·§4), API 스키마는 backend/app/bm/schemas.py.

import type { ApplicationStatus } from "@/lib/application-status"
export type { ApplicationStatus }

// ── 고정 코드(시드 lookup / 표시 enum) — schemas.py 의 Literal 과 동일 집합 ──────────────
// 사업분야(business_field, 셀러·바이어 공용·멀티선택, 8종) — K-콘텐츠 택소노미(kct001tax01).
// 옛 방산 13분야(defense_field)를 대체(값·이름 전면 교체, 1:1 매핑 없음).
export type BusinessFieldCode =
  | "game_production"
  | "animation_distribution"
  | "content_production"
  | "music_platform"
  | "newtech_content"
  | "character_licensor"
  | "webtoon_production"
  | "music_production"

// 카테고리(content_category, 셀러 전용·단일선택, 3종) — kct001tax01 신설. exhibitor_profiles의
// 스칼라 컬럼(keyword 조인 아님). Hall 필터를 대체하는 회사 분류축(discover facet).
export type ContentCategoryCode = "animation_character" | "broadcasting" | "comics_game_music"

export type OrgTypeCode =
  | "private_defense"
  | "private_commercial"
  | "association"
  | "government"
  | "exhibition_agent"
  | "media"
  | "local_gov"
  | "other"

// 상담 가능 언어 — PPT 슬라이드6 확정(REQ-06A): 영어·베트남어 2종만(2026 베트남 K-콘텐츠 엑스포).
export type Lang = "en" | "vi"
export type ParticipationRoute = "re_1_2" | "re_3_5" | "re_6plus" | "new"
export type AcquisitionChannel =
  | "edm"
  | "official_letter"
  | "kotra_invitation"
  | "website_sns"
  | "media"
export type AnnualSalesSeller = "krw_1_5" | "krw_5_10" | "krw_10_50" | "krw_50plus"
// 바이어 연매출(USD) — 셀러(AnnualSalesSeller, KRW)와 코드 집합이 다르다(schemas.py AnnualSalesBuyer).
export type AnnualSalesBuyer = "usd_lt_500k" | "usd_500k_1m" | "usd_1m_5m" | "usd_gt_5m"
export type EmployeeRange = "e_0_10" | "e_11_50" | "e_51_100" | "e_101plus"
export type ProductPriceRange =
  | "krw_0_10m"
  | "krw_10_30m"
  | "krw_30_50m"
  | "krw_50_70m"
  | "krw_70_100m"
// 바이어 전용(schemas.py BudgetRange/AdoptionTimeline) — 지출 가능 예산(USD)·도입 시기.
export type BudgetRange =
  | "usd_lt_100k"
  | "usd_100k_500k"
  | "usd_500k_1m"
  | "usd_1m_5m"
  | "usd_5m_10m"
  | "usd_10m_plus"
export type AdoptionTimeline =
  | "2026_h2"
  | "2027_h1"
  | "2027_h2"
  | "2028_h1"
  | "2028_h2"
  | "2029_h1"
  | "2029_h2"
  | "2030_h1"
  | "2030_h2"
  | "undecided"

// ApplicationStatus 는 lib/application-status 정본을 상단에서 re-export(중복 정의 제거, codex P1).

// ── 자식 컬렉션(전체 교체 단위) ─────────────────────────────────────────────────
// 전시품목 — 제품명(국문)만 필수, 나머지는 선택(HS코드·카테고리·사양·가격대). (PRD User Story 7)
// ⚠ 가격대(priceRange)는 제품별. 백엔드(#26 ProductIn)엔 없고 product_price_range가 프로필 단위라
//   스키마 후속 필요(제품별 가격으로 이전).
export interface Product {
  nameKo: string
  nameEn?: string
  businessField?: BusinessFieldCode // 사업분야(business_field, 8종) 중 선택 — 제품별 분야
  categoryKo?: string // (구) 자유텍스트 카테고리 — businessField 선택으로 대체(비파괴 보존)
  categoryEn?: string
  hsCode?: string
  hsDescription?: string
  spec?: string // 사양(국문)
  specEn?: string // 사양(영문)
  priceRange?: ProductPriceRange
}

// 담당자(복수, 국/영 이중) — bm-profile-fields §4.3.
export interface ExhibitorAttendee {
  lastNameKo?: string
  lastNameEn?: string
  firstNameKo?: string
  firstNameEn?: string
  divisionKo?: string
  divisionEn?: string
  titleKo?: string
  titleEn?: string
  email?: string
  tel?: string
  mobile?: string
  whatsappId?: string
  languages?: Lang[]
}

// 초청 바이어 추천(복수) — bm-profile-fields §4.4.
export interface RecommendedBuyer {
  continent?: string
  country?: string
  orgNameEn?: string
  personNameEn?: string
  email?: string
  contact?: string
}

// ── 프로필 드래프트(전 단계 합집합, 모두 선택 — 부분 저장/이어쓰기 단위) ─────────────────
// 단계: 1 기본정보(행사 등록 시 입력한 정보 확인=로스터 컬럼) · 2 회사소개 · 3 전시품목 · 4 타겟 · 5 완료.
// ⚠ 부스/대표자/업태/종목 등 신규 로스터 컬럼은 백엔드(#26 EXHIBITOR_STEP_MODELS) ·
//   docs/db/bm-profile-fields.md 에 아직 없음 → 스키마 반영은 후속(HITL).
export interface ExhibitorProfileDraft {
  // ── 1 기본정보 (행사 등록 정보 = 로스터 컬럼, 확인·수정) ──
  businessRegNo?: string // 사업자등록번호 — D4: 데이터 속성, 미입력이어도 작성·제출 안 막힘
  organizationNameKo?: string // 회사명(국문)
  organizationNameEn?: string // 회사명(영문)
  // 구분 = 부스 정보(Hall > 관 > 부스위치). 회원가입 정보라 읽기 전용. 부스위치는 미배정 가능.
  hall?: string // 부스 Hall(7·8·9·10)
  pavilion?: string // 관(대한민국관·드론/대드론/로봇관 등)
  boothLocation?: string // 부스위치(미배정 시 빈 값)
  boothType?: string // 부스타입 (신규 컬럼 — 백엔드 미반영)
  boothCount?: number // 부스개수 (신규)
  orgTypes?: OrgTypeCode[] // 참가자 구분(매칭 차원, 백엔드 org_event_role_org_types) — 현재 폼 미수집
  representativeNameKo?: string // 대표자명(국문) (신규)
  representativeNameEn?: string // 대표자명(영문) (신규)
  companyEmail?: string // 회사 이메일 (신규)
  mainTel?: string // 회사 전화번호
  fax?: string // 회사 팩스
  zipCode?: string // 회사 우편번호 (신규)
  addressKo?: string // 회사 주소
  addressDetail?: string // 회사 상세주소 (신규)
  addressEn?: string // 회사 영문주소
  businessType?: string // 업태 (신규)
  businessItem?: string // 종목 (신규)
  attendees?: ExhibitorAttendee[] // 담당자(명 국/영·직책·이메일·연락처) — 기본정보로 통합
  // ── 2 회사소개 (소개 + 비-로스터 보강정보) ──
  introKo?: string
  introEn?: string
  website?: string // 홈페이지 (기본정보→회사소개 이관)
  annualSalesRange?: AnnualSalesSeller // 연매출 (이관)
  employeeRange?: EmployeeRange // 직원 수 (이관)
  availableLanguages?: Lang[] // 상담 가능 언어 (이관)
  // ── 3 전시품목 (가격대는 제품별 Product.priceRange. 상품소개는 제거 — 회사소개+제품 사양과 중복) ──
  products?: Product[]
  exhibitionCategories?: BusinessFieldCode[] // 사업분야(8, 멀티)
  contentCategory?: ContentCategoryCode // 카테고리(3, 단일선택) — Hall 필터를 대체하는 회사 분류축
  // ── 4 타겟 (담당자는 1 기본정보로 이동) ──
  preferredBuyerCountries?: string[] // 선호 바이어 국가(복수 선택, BUYER_COUNTRY_OPTIONS code)
  preferredBuyerTypes?: OrgTypeCode[] // 선호 바이어 구분(복수, 기관유형 8종)
  participationRoute?: ParticipationRoute
  newAcquisitionChannel?: AcquisitionChannel
  unavailableMeetingSlots?: string[] // 행사 기간 미팅 '불가' 슬롯 키(opt-out, 나머지는 가능)
  recommendedBuyers?: RecommendedBuyer[]
}

// 서버가 돌려주는 저장된 프로필 — 드래프트 + 상태 + 식별자. (로고·소개서 파일은 미사용 — 폼에서 받지 않음)
export interface ExhibitorProfile extends ExhibitorProfileDraft {
  orgEventRoleId: string
  applicationStatus: ApplicationStatus
}

// 단계별 PATCH 입력 — 해당 단계 필드만 담은 드래프트 부분집합(부분 저장).
export type ExhibitorStepPatch = Partial<ExhibitorProfileDraft>

// 편집 가능 단계는 1~4(5단계=요약·제출). EXHIBITOR_STEP_MODELS 와 동일.
export type EditableStep = 1 | 2 | 3 | 4
export type Step = 1 | 2 | 3 | 4 | 5

// mock↔실연동 단일 교체점. review 의 ReviewClient 와 같은 seam 패턴(ADR-0008).
export interface ExhibitorProfileClient {
  // 이어쓰기 입력 — 저장된 단계 보존된 프로필.
  getProfile(orgEventRoleId: string): Promise<ExhibitorProfile>
  // 한 단계 부분 저장. 그 단계 필드만 변경(미제공·다른 단계 불변). 목록은 전체 교체.
  saveStep(
    orgEventRoleId: string,
    step: EditableStep,
    patch: ExhibitorStepPatch,
  ): Promise<ExhibitorProfile>
  // 제출 — 최종 편집(선택) + application_status=submitted 를 원자적으로(반쪽 제출 불가, ADR-0009 D6).
  submit(orgEventRoleId: string, patch?: ExhibitorStepPatch): Promise<ExhibitorProfile>
}
