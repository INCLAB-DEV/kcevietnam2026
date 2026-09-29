// BM-001 바이어 프로필 폼의 도메인 타입 — backend(#26) schemas.py의 Buyer* 모델을 FE에서 거울처럼
// 따른다(코드값은 동일, 키만 camelCase). 저장/조회 시 buyer-profile-store가 이 draft ↔ API
// snake_case payload를 매핑한다. 컬럼 권위 정의는 docs/db/bm-profile-fields.md §3.

import type { ApplicationStatus } from "@/lib/application-status"
export type { ApplicationStatus }

// BusinessFieldCode(사업분야 8종)는 lib/bm/types.ts가 단일 정본 — 여기선 re-export만 한다(중복
// union 정의 제거, 2026-09 K-콘텐츠 택소노미 전환). 바이어 관심분야(interestCategories)도 같은
// 코드 집합을 쓴다 — 셀러 전시품목 분야와 어휘 공유(매칭 축).
import type { BusinessFieldCode } from "@/lib/bm/types"
export type { BusinessFieldCode }

// ── 공유 코드값 (bm-profile-fields §1 — 코드는 backend Literal과 1:1) ─────────────
export type OrgTypeCode =
  | "private_defense"
  | "private_commercial"
  | "association"
  | "government"
  | "exhibition_agent"
  | "media"
  | "local_gov"
  | "other"

export type Lang = "en" | "vi"

export type ParticipationRoute = "re_1_2" | "re_3_5" | "re_6plus" | "new"
export type AcquisitionChannel =
  | "edm"
  | "official_letter"
  | "kotra_invitation"
  | "website_sns"
  | "media"

export type AnnualSalesBuyer = "usd_lt_500k" | "usd_500k_1m" | "usd_1m_5m" | "usd_gt_5m"
// 지출 가능 예산(구매 예산, USD) — 신규(2026-06-29). 구간·컬럼은 HITL(주최사 확인).
export type BudgetRange =
  | "usd_lt_100k"
  | "usd_100k_500k"
  | "usd_500k_1m"
  | "usd_1m_5m"
  | "usd_5m_10m"
  | "usd_10m_plus"
// 도입 시기 — 신규(2026-06-29). 년도+반기(2026 하반기 ~ 2030). 과거 잠정 adoption_timeline
// 재도입. 컬럼 HITL(주최사 확인). 코드=<year>_h<1|2>(상반기 h1 / 하반기 h2).
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
export type EmployeeRange = "e_0_10" | "e_11_50" | "e_51_100" | "e_101plus"
export type BusinessPerfKorea = "none" | "usd_1_1m" | "usd_1m_5m" | "usd_5m_plus"
export type TravelersKorea =
  | "t_0_500"
  | "t_501_1000"
  | "t_1001_5000"
  | "t_5001_10000"
  | "t_10000plus"

// ApplicationStatus 는 lib/application-status 정본을 상단에서 re-export(중복 정의 제거, codex P1).
// FE 폼은 registered→submitted 만 전이시킨다(승인은 운영 슬라이스).

// ── 복수 항목 ─────────────────────────────────────────────────────────────────
// 담당자 (buyer_attendees §3.2)
export interface BuyerAttendeeDraft {
  firstName: string
  lastName: string
  division: string
  jobTitle: string
  email: string
  tel: string
  mobile: string
  whatsappId: string
  messengerId: string
  languages: Lang[]
  interpreterNeed: boolean
  interpreterLanguages: Lang[]
}

// 추천 바이어 (buyer_recommended_buyers §3.3)
export interface RecommendedBuyerDraft {
  continent: string
  country: string
  organization: string
  personInCharge: string
  email: string
  tel: string
}

// ── 폼 전체 draft (BuyerProfileResponse 미러) ────────────────────────────────────
export interface BuyerProfileDraft {
  // 공유 식별(organizations §2) — Registrant prefill 대상. 폼에선 "소속(국문/영문)"으로 노출.
  organizationNameKo: string
  organizationNameEn: string
  businessRegNo: string
  website: string

  // 1. 기본정보 — 신청자 식별(신규, 2026-06-29). 컬럼 매핑은 후속(HITL): 대표 담당자 1인의
  // 이름/직위/이메일/언어. v1은 폼 수집만(buyer_attendees 1행 또는 buyer_profiles 신규 컬럼 — 미정).
  contactNameKo: string
  contactNameEn: string
  contactTitleKo: string
  contactTitleEn: string
  contactEmail: string
  contactLanguage: Lang | "" // 단일 선택(2026-06-29) — 상담 가능 언어 1개
  contactInterpreterNeed: boolean | null

  // 1. 기본정보 — 기관/연락 (buyer_profiles §3.1, step 1)
  continent: string
  country: string
  cityState: string
  zipCode: string
  address1: string
  address2: string
  tel: string
  lastYearBestBuyer: string
  annualSalesRange: AnnualSalesBuyer | ""
  employeeRange: EmployeeRange | ""
  businessPerfKorea3y: BusinessPerfKorea | ""
  travelersKorea3y: TravelersKorea | ""
  orgTypes: OrgTypeCode[]

  // 2. 관심분야·소개 (step 2)
  interestCategories: BusinessFieldCode[]
  companyIntroKo: string // 신규(2026-06-29) — 바이어 기업소개 국문. 컬럼 매핑 후속(HITL, 확정결정 #3=영문)
  companyIntroEn: string
  budgetRange: BudgetRange | "" // 신규(2026-06-29) — 지출 가능 예산(USD). 구간·컬럼 HITL(과거 잠정 budget_range 재도입)
  adoptionTimeline: AdoptionTimeline | "" // 신규(2026-06-29) — 도입 시기. 구간·컬럼 HITL(과거 잠정 adoption_timeline 재도입)
  note: string // 폼 미수집(2026-06-29 제거) — 컬럼은 buyer_profiles.note에 유지

  // 3. 담당자 (step 3)
  attendees: BuyerAttendeeDraft[]

  // 4. 참가정보·추천 (step 4)
  participationRoute: ParticipationRoute | ""
  newAcquisitionChannel: AcquisitionChannel | ""
  kstAvailableTime: string
  recommendedBuyers: RecommendedBuyerDraft[]
}

// ── 실 백엔드 연동 클라이언트 계약 (BM-001 실배선, 2026-09) ────────────────────────
// mock↔실연동 단일 교체점 — lib/bm/types.ts의 ExhibitorProfileClient와 같은 seam 패턴(ADR-0008).
// 저장 가능 단계는 1(기본정보)·2(관심분야·소개)뿐이다(3=확인·제출은 입력 없음) — backend
// BUYER_STEP_MODELS(app/bm/schemas.py)의 1·2와 번호가 그대로 대응한다(우연이 아니라 FE 3단계 폼이
// backend step1·step2 필드의 부분집합이 되도록 설계됐다, lib/apply/form-state.ts STEP_FIELDS 참고).
export type BuyerEditableStep = 1 | 2
export type BuyerStepPatch = Partial<BuyerProfileDraft>

export interface BuyerProfileReadResult {
  draft: BuyerProfileDraft
  status: ApplicationStatus
}

export interface BuyerProfileClient {
  // 이어쓰기 입력 — 저장된 단계 보존된 프로필 + 신청 상태.
  getProfile(orgEventRoleId: string): Promise<BuyerProfileReadResult>
  // 한 단계 부분 저장. 그 단계 필드만 변경(미제공·다른 단계 불변).
  saveStep(
    orgEventRoleId: string,
    step: BuyerEditableStep,
    patch: BuyerStepPatch,
  ): Promise<BuyerProfileReadResult>
  // 제출 — 최종 편집(선택) + application_status=submitted 를 원자적으로(반쪽 제출 불가, ADR-0009 D6).
  submit(orgEventRoleId: string, patch?: BuyerStepPatch): Promise<BuyerProfileReadResult>
}

export function emptyAttendee(): BuyerAttendeeDraft {
  return {
    firstName: "",
    lastName: "",
    division: "",
    jobTitle: "",
    email: "",
    tel: "",
    mobile: "",
    whatsappId: "",
    messengerId: "",
    languages: [],
    interpreterNeed: false,
    interpreterLanguages: [],
  }
}

export function emptyRecommendedBuyer(): RecommendedBuyerDraft {
  return { continent: "", country: "", organization: "", personInCharge: "", email: "", tel: "" }
}

// 빈 draft — 신규 작성 시작점. Registrant prefill은 store가 이 위에 덮어쓴다.
export function emptyBuyerProfileDraft(): BuyerProfileDraft {
  return {
    organizationNameKo: "",
    organizationNameEn: "",
    businessRegNo: "",
    website: "",
    contactNameKo: "",
    contactNameEn: "",
    contactTitleKo: "",
    contactTitleEn: "",
    contactEmail: "",
    contactLanguage: "",
    contactInterpreterNeed: null,
    continent: "",
    country: "",
    cityState: "",
    zipCode: "",
    address1: "",
    address2: "",
    tel: "",
    lastYearBestBuyer: "",
    annualSalesRange: "",
    employeeRange: "",
    businessPerfKorea3y: "",
    travelersKorea3y: "",
    orgTypes: [],
    interestCategories: [],
    companyIntroKo: "",
    companyIntroEn: "",
    budgetRange: "",
    adoptionTimeline: "",
    note: "",
    attendees: [],
    participationRoute: "",
    newAcquisitionChannel: "",
    kstAvailableTime: "",
    recommendedBuyers: [],
  }
}
