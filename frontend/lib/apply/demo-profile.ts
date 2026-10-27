import { emptyBuyerProfileDraft, type BuyerProfileDraft } from "./types"

// BM-004 프로필 허브 데모용 예시 데이터 — 완성된 실제 프로필이 없을 때(데모 계정) 채워 보여준다.
// ⚠ 전부 가상 데모값(실제 기업·개인정보 아님). 실연동(#26 FastAPI 조회) 시 이 fallback은 제거한다.
// 코드값은 lib/apply/options.ts의 유효 code(없는 code는 라벨이 code 그대로 떠 티가 난다). K-콘텐츠
// 택소노미 전환(kct001tax01) — backend demo_seed.py의 mbr-buyer-01(Seoul Content Partners)과
// 관심분야 동치 유지.
export const DEMO_BUYER_PROFILE: BuyerProfileDraft = {
  ...emptyBuyerProfileDraft(),
  // 1 기본정보
  contactNameKo: "김바이어",
  contactNameEn: "Buyer Kim",
  contactTitleKo: "구매팀장",
  contactTitleEn: "Procurement Lead",
  contactEmail: "buyer01@seoulcontent.com",
  tel: "010-1234-5678",
  contactLanguage: "en",
  contactInterpreterNeed: false,
  organizationNameKo: "서울콘텐츠파트너스",
  organizationNameEn: "Seoul Content Partners",
  country: "대한민국",
  orgTypes: ["private_commercial"],
  annualSalesRange: "usd_500k_1m",
  employeeRange: "e_101plus",
  // 2 관심분야·소개
  interestCategories: ["game_production", "content_production", "character_licensor"],
  companyIntroKo: "게임·애니메이션·캐릭터 IP의 해외 공동제작을 검토하는 콘텐츠 투자사입니다.",
  companyIntroEn:
    "Content investment group sourcing game, animation, and character IP for international co-production.",
  budgetRange: "usd_100k_500k",
  adoptionTimeline: "2026_h2",
}
