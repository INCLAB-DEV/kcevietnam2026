import type { RegistrantInfo } from "./registrant-prefill"
import type { ExhibitorProfileDraft } from "./types"

// BM-002 작성 폼(/exhibitor/apply)의 **목업 세션용** 데모값 — 실 세션에는 쓰지 않는다
// (app/exhibitor/apply/page.tsx가 isReal로 가른다: 실사용자에게 가짜 회사명·대표자명을 보여주지 않는다).

// 보완 요청 메모(changes_requested 배너) — 실연동 시 organization_event_roles.review_note(운영자 입력)로 교체.
export const DEMO_REVIEW_NOTE =
  "사업분야 분류가 누락되었습니다. 2단계 회사소개의 주력 분야와 3단계 사업분야를 보완해 다시 제출해 주세요."

// 행사 등록(명단/로스터) 정보 — 1단계 기본정보 자동 프리필의 데모 입력.
// ⚠ 전부 가상 데모값 — 실제 기업·개인정보 아님(개인정보 이슈 방지). 실연동 시 명단 원본에서 채움.
export const DEMO_REGISTRANT: RegistrantInfo = {
  businessRegNo: "000-00-00000",
  organizationNameKo: "가상콘텐츠(주)",
  organizationNameEn: "Virtual Content Co., Ltd.",
  // 부스 정보(구분) — Hall > 관 > 부스위치. 부스위치는 아직 배정 전(미배정).
  hall: "7",
  pavilion: "대한민국관",
  boothLocation: undefined,
  boothType: "독립부스",
  boothCount: 2,
  representativeNameKo: "홍길동",
  representativeNameEn: "Gildong Hong",
  companyEmail: "contact@example.com",
  mainTel: "02-0000-0000",
  fax: "02-0000-0001",
  zipCode: "00000",
  addressKo: "서울특별시 강남구 테헤란로 123",
  addressDetail: "예시빌딩 5층",
  addressEn: "123 Teheran-ro, Gangnam-gu, Seoul",
  businessType: "제조업",
  businessItem: "애니메이션·캐릭터 IP",
  contactNameKo: "김담당",
  contactNameEn: "Damdang Kim",
  contactTitle: "해외사업팀 차장",
  contactEmail: "manager@example.com",
  contactPhone: "010-0000-0000",
}

// BM-005 프로필 허브 데모용 예시 데이터 — 완성된 실제 프로필이 없을 때(데모 계정) 채워 보여준다.
// ⚠ 전부 가상 데모값(실제 기업·개인정보 아님). 실연동(#26 FastAPI 조회) 시 이 fallback은 제거한다.
// 코드값은 lib/bm/types.ts 유니온의 유효 code(BusinessFieldCode·ContentCategoryCode·OrgTypeCode·
// AnnualSalesSeller 등). 회사·부스·소개는 backend demo_seed.py의 mbr-exh-01(픽셀아츠 스튜디오)과
// 동치 유지(K-콘텐츠 택소노미 전환, kct001tax01) — 재시드 값이 바뀌면 여기도 맞춰 갱신한다.
export const DEMO_EXHIBITOR_PROFILE: ExhibitorProfileDraft = {
  // 1 기본정보 (행사 등록 정보 = 로스터)
  businessRegNo: "123-45-67890",
  organizationNameKo: "픽셀아츠 스튜디오",
  organizationNameEn: "PixelArts Studio",
  hall: "7",
  pavilion: "대한민국관",
  boothLocation: "7-A12",
  boothType: "독립부스",
  boothCount: 2,
  representativeNameKo: "이대표",
  representativeNameEn: "Daepyo Lee",
  companyEmail: "contact@pixelarts-studio.com",
  mainTel: "02-1234-5678",
  fax: "02-1234-5679",
  zipCode: "13524",
  addressKo: "경기도 성남시 분당구 판교로 123",
  addressDetail: "5층",
  addressEn: "123 Pangyo-ro, Bundang-gu, Seongnam-si, Gyeonggi-do",
  businessType: "제조업",
  businessItem: "애니메이션·캐릭터 IP",
  orgTypes: ["private_commercial"],
  attendees: [
    {
      firstNameKo: "김담당",
      firstNameEn: "Damdang Kim",
      titleKo: "해외사업팀 차장",
      email: "manager@pixelarts-studio.com",
      mobile: "010-0000-0000",
      languages: ["en"],
    },
  ],
  // 2 회사소개
  introKo: "오리지널 애니메이션과 캐릭터 IP를 기획·제작하는 애니메이션 스튜디오입니다.",
  introEn: "Animation studio creating original series and character IP.",
  website: "https://www.pixelarts-studio.com",
  annualSalesRange: "krw_50plus",
  employeeRange: "e_11_50",
  availableLanguages: ["en", "vi"],
  // 3 전시품목
  products: [
    {
      nameKo: "오리지널 애니메이션 시리즈 '스타빔레인저'",
      nameEn: "Original Animation Series 'StarBeam Rangers'",
      businessField: "content_production",
      hsCode: "8523.49",
      spec: "26부작, 4K HDR, 글로벌 OTT 동시 방영",
      specEn: "26 episodes, 4K HDR, simultaneous global OTT release",
      priceRange: "krw_10_30m",
    },
    {
      nameKo: "캐릭터 라이선싱 패키지 '문라이트 프렌즈'",
      nameEn: "Character Licensing Package 'Moonlight Friends'",
      businessField: "character_licensor",
      spec: "완구·문구·의류 라이선스 패키지",
      priceRange: "krw_30_50m",
    },
  ],
  exhibitionCategories: ["content_production", "character_licensor", "newtech_content"],
  contentCategory: "animation_character",
  // 4 타겟
  preferredBuyerCountries: ["usa", "vietnam"],
  preferredBuyerTypes: ["private_commercial", "association"],
  unavailableMeetingSlots: [],
  recommendedBuyers: [],
}
