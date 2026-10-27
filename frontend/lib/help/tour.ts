// 요소 앵커드 가이드 투어(coach marks) 레지스트리 — (현재 라우트 + 뷰어 역할) → 투어 ID → 스텝 시퀀스.
//
// 책임 분리(정적 도움말 패널 lib/help/content.ts 와 같은 컨벤션):
//  · 이 파일 = "어떤 화면·역할에 어떤 투어를, 어떤 요소를, 어떤 순서로 보여줄지"만 담는다(순수, 단위 테스트 대상).
//  · 실제 문구(스텝 제목·설명, 버튼 라벨)는 messages/{ko,en}.json 의 "help.tour" 네임스페이스에 둔다
//    → help 패널 문구와 같은 파일. 투어 스텝 문구는 `help.tour.<tourId>.steps.<i>.{title,description}`.
//
// 소비 측(components/help/guided-tour.tsx)은 resolveTourId()로 투어 ID를 얻고, TOURS[id]의 셀렉터와
// 로케일 문구(next-intl)를 index로 zip 하여 driver.js 스텝을 만든다. 셀렉터↔문구 개수 일치는 tour.test.ts가 강제.

import type { UserRole } from "@/components/layout/nav"
import { resolveHelpTopicId, type HelpTopicId } from "./content"

// 투어가 존재하는 화면들 — 정적 도움말 토픽(HelpTopicId)의 부분집합이다. 나머지 화면(홈·알림·admin·
// 일반 폴백)은 투어 없이 도움말 패널만 뜬다(폴백). resolveTourId가 이 집합 밖이면 null을 돌려준다.
export type TourId =
  | "welcome"
  | "discoverBuyer"
  | "discoverExhibitor"
  | "meetingsBuyer"
  | "meetingsExhibitor"
  | "profileBuyer"
  | "profileExhibitor"
  | "applyBuyer"
  | "applyExhibitor"
  | "organizerDashboard"
  | "organizerMembers"
  | "organizerForcedMatching"

// 한 스텝 = 하이라이트할 요소의 CSS 셀렉터(data-tour 앵커). 런타임에 요소를 못 찾으면 driver.js가
// 팝오버를 화면 중앙에 띄운다(하이라이트만 생략) — 조건부 렌더 요소(빈 상태 등)에서도 안전하게 degrade.
export interface TourStep {
  element: string
}

// 화면별 앵커 시퀀스(여정 순서). 각 배열 길이 = messages help.tour.<id>.steps 배열 길이 여야 한다
// (ko/en 양쪽, tour.test.ts 가 검증). data-tour 값은 각 화면 컴포넌트에 최소 침습으로 부여돼 있다.
export const TOURS: Record<TourId, TourStep[]> = {
  // /welcome — 입장 전 랜딩(단독 화면). 상태 카드 → 계정/로그아웃.
  welcome: [
    { element: '[data-tour="welcome-card"]' },
    { element: '[data-tour="welcome-account"]' },
  ],

  // /discover — 기본 탭(AI 추천 SwipeDeck) 흐름: 탭 → 추천 카드 → 미팅 신청 → 추천 피드백.
  discoverBuyer: [
    { element: '[data-tour="discover-tabs"]' },
    { element: '[data-tour="discover-card"]' },
    { element: '[data-tour="discover-request"]' },
    { element: '[data-tour="discover-feedback"]' },
  ],
  discoverExhibitor: [
    { element: '[data-tour="discover-tabs"]' },
    { element: '[data-tour="discover-card"]' },
    { element: '[data-tour="discover-request"]' },
    { element: '[data-tour="discover-feedback"]' },
  ],

  // /meetings — 일자 탭 → 타임라인 목록 → 상세 패널(수락/거절/회의록).
  meetingsBuyer: [
    { element: '[data-tour="meeting-days"]' },
    { element: '[data-tour="meeting-list"]' },
    { element: '[data-tour="meeting-panel"]' },
  ],
  meetingsExhibitor: [
    { element: '[data-tour="meeting-days"]' },
    { element: '[data-tour="meeting-list"]' },
    { element: '[data-tour="meeting-panel"]' },
  ],

  // /profile · /exhibitor/profile — 조회 전용 허브. 허브 구조가 역할별로 달라(바이어=StepReview, 참가사=
  // ProfileView) 단일 앵커 1스텝으로 둔다(조회 전용임을 알리는 코치마크 하나면 충분).
  profileBuyer: [{ element: '[data-tour="profile-view"]' }],
  profileExhibitor: [{ element: '[data-tour="profile-view"]' }],

  // /apply · /exhibitor/apply — 단계 표시 → 입력 폼 → 이동/제출 버튼.
  applyBuyer: [
    { element: '[data-tour="apply-steps"]' },
    { element: '[data-tour="apply-form"]' },
    { element: '[data-tour="apply-nav"]' },
  ],
  applyExhibitor: [
    { element: '[data-tour="apply-steps"]' },
    { element: '[data-tour="apply-form"]' },
    { element: '[data-tour="apply-nav"]' },
  ],

  // /organizer — 매칭 현황 대시보드: 지표 → 0건 참가사 경고 → 미팅 상태분포 → 시간대 차트 → 사이드바.
  organizerDashboard: [
    { element: '[data-tour="ops-metrics"]' },
    { element: '[data-tour="ops-zero"]' },
    { element: '[data-tour="ops-status"]' },
    { element: '[data-tour="ops-hourly"]' },
    { element: '[data-tour="app-nav"]' },
  ],

  // /organizer/members — 회원 관리: 역할 탭 → 검색 → 필터 → 명단 표 → 내보내기.
  organizerMembers: [
    { element: '[data-tour="members-tabs"]' },
    { element: '[data-tour="members-search"]' },
    { element: '[data-tour="members-filters"]' },
    { element: '[data-tour="members-table"]' },
    { element: '[data-tour="members-export"]' },
  ],

  // /organizer/forced-matching — 비즈매칭 배정: 역할 탭 → 전체 일괄배정 → 검색·필터 → 스케줄 그리드.
  organizerForcedMatching: [
    { element: '[data-tour="fm-tabs"]' },
    { element: '[data-tour="fm-run"]' },
    { element: '[data-tour="fm-filters"]' },
    { element: '[data-tour="fm-grid"]' },
  ],
}

// 투어가 정의된 화면인지 판별하는 집합(TOURS 키로 자동 도출 — 목록을 두 번 관리하지 않는다).
const TOUR_IDS = new Set<string>(Object.keys(TOURS))

// (pathname, role) → 투어 ID | null. 라우트·역할 판정은 정적 도움말과 완전히 동일한 규칙을 재사용한다
// (resolveHelpTopicId) — 도움말 패널과 투어가 같은 화면 정의 위에서 어긋나지 않게 한다. 투어가 없는
// 화면(홈·알림·admin·일반 폴백)은 null → 소비 측이 자동시작·재생 트리거를 렌더하지 않는다(패널만).
export function resolveTourId(pathname: string, role: UserRole): TourId | null {
  const topic: HelpTopicId = resolveHelpTopicId(pathname, role)
  return TOUR_IDS.has(topic) ? (topic as TourId) : null
}

// ── 최초 1회 자동시작 플래그(브라우저 localStorage) ────────────────────────────────
// 화면×역할별로 최초 진입 1회만 투어를 자동 재생하고, 이후에는 "가이드 다시 보기"로만 실행한다.
// tourId 가 이미 (역할 + 화면)을 인코딩하므로 tourId 하나를 키로 쓴다(예: nabi-tour-seen:discoverBuyer).
const SEEN_PREFIX = "nabi-tour-seen:"

export function tourSeenStorageKey(id: TourId): string {
  return `${SEEN_PREFIX}${id}`
}

// localStorage 접근 불가(SSR·프라이빗 모드 예외)면 "이미 봤다"로 간주해 자동시작을 하지 않는다(안전측).
export function hasSeenTour(id: TourId): boolean {
  try {
    return window.localStorage.getItem(tourSeenStorageKey(id)) === "1"
  } catch {
    return true
  }
}

export function markTourSeen(id: TourId): void {
  try {
    window.localStorage.setItem(tourSeenStorageKey(id), "1")
  } catch {
    // 저장 실패는 조용히 무시 — 자동시작이 한 번 더 뜰 수 있을 뿐 기능엔 지장 없다.
  }
}
