// 운영자 신청서 조회용 — 회사가 제출한 B층 비즈매칭 신청서(BM-001 바이어 / BM-002 참가사) 표시 데이터.
// 필드셋은 docs/db/bm-profile-fields.md §3.1(buyer_profiles)·§4.1(exhibitor_profiles) 정본을 미러한다.
// A층(등록 정보, MemberRow)과 별개: 여기 값은 회사가 신청서로 직접 선언한 정본(D17). 라벨은 표시용으로
// 미리 해석해 담는다(코드↔라벨 권위는 lib/bm/fields). 실연동 시 FastAPI가 제출 프로필을 반환한다.

export interface ProfileProduct {
  nameKo: string
  nameEn?: string
  category?: string // 사업분야(8종) 라벨
  hsCode?: string
  hsDescription?: string
  priceRange?: string // 제품 가격대(라벨)
}

export interface ProfileAttendee {
  name: string // 성명(국/영 병기 표시)
  division?: string // 부서
  title?: string // 직위
  email?: string
  tel?: string
  mobile?: string
  languages?: string // "영어, 한국어"
  interpreterNeed?: boolean
}

export interface MemberProfile {
  contentCategory?: string
  // ── 공유 식별(organizations §2) ──
  businessRegNo?: string
  website?: string

  // ── 바이어 신청자/참가사 대표 담당자 ──
  contactNameKo?: string
  contactNameEn?: string
  contactTitleKo?: string
  contactTitleEn?: string
  contactEmail?: string
  contactPhone?: string // 바이어 tel
  contactLanguage?: string // 상담/소통 언어(단일, 라벨)
  interpreterNeed?: boolean // 통역 필요 여부

  // ── 기관/규모(바이어·참가사 공통) ──
  country?: string // 바이어 소속 국가
  orgTypes?: string[] // 참가자 구분(8, 라벨)
  annualSales?: string // 연매출(라벨)
  employeeRange?: string // 직원수(라벨)

  // ── 관심분야/전시품목(사업분야 8종 라벨) + 소개 ──
  categories: string[]
  companyIntroKo?: string
  companyIntroEn?: string

  // ── 바이어 전용 ──
  budgetRange?: string // 지출 가능 예산(라벨)
  adoptionTimeline?: string // 도입 시기(라벨)
  kstAvailableTime?: string // KST 상담 가능 시간(요구사항·운영/무역관 수집)
  participationRoute?: string // 참가 경로(라벨)
  stayInfo?: string // 체류(항공·숙박·통역) — 운영자 입력
  attendees?: ProfileAttendee[] // 참석자(복수)

  // ── 참가사 전용 ──
  representativeNameKo?: string
  representativeNameEn?: string
  companyEmail?: string // 회사 이메일
  mainTel?: string // 대표 번호
  fax?: string
  address?: string // 주소(국/영 합쳐 표시)
  businessType?: string // 업태
  businessItem?: string // 종목
  booth?: string // 부스(홀·관·위치)
  boothType?: string
  boothCount?: number
  availableLanguages?: string // 상담 가능 언어(멀티, 라벨)
  products?: ProfileProduct[]
  preferredBuyerCountries?: string // 선호 바이어 국가(멀티, 라벨)
  preferredBuyerTypes?: string // 선호 바이어 구분(멀티, 라벨)
  unavailableSlots?: string // 미팅 불가 시간(요약)
}
