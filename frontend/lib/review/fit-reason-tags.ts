// Fit 사유 태그의 표시 라벨 키 — AI가 고른 근거 카테고리를 화면 로케일로 보여주기 위한 표.
//
// 태그는 백엔드 시드 어휘(app/services/structuring.py FIT_REASON_SEED_CATEGORIES)의 **한국어 문자열
// 그대로** 내려오고 그대로 저장된다(검수 화면이 받은 값을 손대지 않고 다시 보낸다). 저장값을 바꾸지
// 않고, 화면에 찍을 때만 아는 시드 태그를 messages의 review.fitTags.{키}로 옮긴다 — EN 화면에서
// 배지가 "제품 적합성"으로 남던 것을 "Product fit"으로 보여준다.
//
// 시드 밖의 태그(AI가 새로 지은 말·과거 데이터)는 옮길 근거가 없어 null을 돌려주고, 화면은 원문을
// 그대로 그린다(지어내지 않는다).

// 키(왼쪽)는 화면 문구가 아니라 백엔드 데이터 값과 맞추는 매칭 키다. 백엔드 시드 목록이 바뀌면 여기와
// messages의 review.fitTags를 함께 맞춘다(fit-reason-tags.test.ts가 카탈로그 쪽 누락을 잡는다).
const SEED_TAG_KEYS: Record<string, string> = {
  "예산": "budget",
  "기술 성숙도": "techMaturity",
  "도입 시기": "adoptionTiming",
  "생산능력": "productionCapacity",
  "인증·규격": "certification",
  "제품 적합성": "productFit",
  "보안등급": "securityClearance",
  "수출통제": "exportControl",
}

/** 시드 태그면 messages의 review.fitTags 하위 키, 아니면 null(원문 그대로 표시). */
export function fitReasonTagKey(tag: string): string | null {
  return SEED_TAG_KEYS[tag] ?? null
}

/** 테스트·검증용 — 표가 다루는 메시지 키 전부. */
export const FIT_REASON_TAG_KEYS: readonly string[] = Object.values(SEED_TAG_KEYS)
