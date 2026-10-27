// 운영자 콘솔 전용 한국어 라벨 — 참가자 도메인의 enum(바이어 세부유형·신청 상태)을 운영자 화면에
// 한국어로 찍는 표. 운영자 콘솔은 쿠키 로케일과 무관하게 한국어로 고정이라 상수로 둔다.
//
// 예전엔 이 표들이 참가자와 공유하는 모듈(lib/types.ts·lib/application-status.ts)에 있었고, 참가자
// 화면(기업 탐색 카드·미팅 패널)도 그대로 import해 EN 화면에 "초청"이 찍혔다. 참가자 화면은 이제
// messages/{ko,en}.json(common.buyerType 등)에서 라벨을 뽑고, 한국어 상수는 운영자 쪽으로 옮겼다 —
// 참가자 화면 소스에 한글 리터럴이 남지 않게 하는 가드(lib/i18n/hangul-guard.test.ts)와 한 쌍이다.
import type { ApplicationStatus } from "@/lib/application-status"
import type { BuyerType } from "@/lib/types"

// 바이어 하위유형 (organization_event_roles.buyer_subtype)
export const BUYER_TYPE_LABELS: Record<BuyerType, string> = {
  hosted: "초청",
  pre_registered: "사전등록",
  on_site: "현장",
}

// 비즈매칭 승인 게이트 상태의 기본 라벨(참가자 관점 표현) — 운영자 명단의 상태 열은 이 표가 아니라
// lib/organizer/members.ts의 ORGANIZER_STATUS_LABELS(운영자 관점 표현)를 쓴다.
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  registered: "등록자",
  submitted: "검토 대기",
  changes_requested: "보완 요청",
  approved: "비즈매칭 참가자",
  rejected: "반려",
}
