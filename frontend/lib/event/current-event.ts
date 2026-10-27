// 현재 비즈매칭이 열리는 행사 정보. 로그인·인트로 화면에서 "어느 행사의 비즈매칭인지" 각인용.
// 값 출처 = 발주사 수행계획서/소개 PDF(2026 베트남 K-콘텐츠 엑스포). 표시 전용 상수다.
// ⚠ 미팅 슬롯 날짜는 여기가 아니라 Event DB(exhibition_start/end)에서 온다. 실연동 시엔 이 정보도
// FastAPI에서 받아온다.
// 신청기간 제한은 해제했다(2026-09-11 발주자 결정) — Event의 application_start/end를 비우고
// BM_APPLICATION_* env도 걷어, 가입·신청서 작성·미팅 신청이 날짜로 막히지 않는다. 그래서 이 라벨도
// 특정 기간을 약속하지 않는다. 다시 기간을 두려면 그 두 곳을 되살리고 이 문구도 함께 고친다.
// applicationPeriodDateLabel 값은 발주사 공식 타임라인(2026-09-30 확정)으로 갱신했다 — 비즈매칭
// 신청기간 2026-10-02~10-12. 위 게이트 미적용 정책 자체는 그대로다(표시 전용 문구만 바뀐 것).
//
// locale별 쌍(ko/en)으로 둔다 — 유일한 소비처(EventBrandPanel)가 이미 next-intl 서버 컴포넌트라
// getLocale()로 골라 쓰는 쪽이 messages/*.json에 4개 값을 옮기는 것보다 변경 폭이 작다(2026-09-13,
// 참가자 화면 EN 전환 잔존 한국어 정리). EN 날짜 표기는 발주사 PDF에 별도 영문 표기가 없어 통상
// 국제 표기(Oct 20 (Tue) – 22 (Thu), 2026)로 직역했다.
export const CURRENT_EVENT = {
  ko: {
    name: "2026 베트남 K-콘텐츠 엑스포",
    dateLabel: "2026.10.20(화)–10.22(목)",
    venue: "베트남 호치민 GEM Center (Grand Castor, Level 5)",
    venueAddress: "Ho Chi Minh City, Vietnam",
    applicationPeriodLabel: "비즈매칭 신청 접수 중",
    // 표시 전용 — 신청 게이트는 여전히 날짜로 막지 않는다(2026-09-11 결정 유지). 시안 요구로
    // 로그인 화면에만 안내 기간을 노출한다(2026-09-18 발주자 지시).
    applicationPeriodDateLabel: "2026년 10월 2일(금) ~ 10월 12일(월)",
  },
  en: {
    name: "2026 Vietnam K-Content Expo",
    dateLabel: "Oct 20 (Tue) – 22 (Thu), 2026",
    venue: "GEM Center, Ho Chi Minh City (Grand Castor, Level 5)",
    venueAddress: "Ho Chi Minh City, Vietnam",
    applicationPeriodLabel: "Business matching applications open",
    applicationPeriodDateLabel: "Oct 2 (Fri) – 12 (Mon), 2026",
  },
} as const
