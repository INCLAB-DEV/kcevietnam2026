// 인app 도움말 콘텐츠 레지스트리 — (현재 라우트 + 뷰어 역할) → 도움말 토픽 ID.
//
// 책임 분리:
//  · 이 파일 = "어떤 화면·역할에 어떤 토픽을 보여줄지" 라우팅 규칙만 담는다(순수 함수, 단위 테스트 대상).
//  · 실제 문구(제목·소개·단계·팁)는 messages/{ko,en}.json 의 "help" 네임스페이스에 토픽 ID를 키로 둔다.
//    → nav.tsx가 labelKey로 라벨을 참조하는 것과 같은 컨벤션. 로컬라이즈는 next-intl(useTranslations)이 담당.
//
// 소비 측(components/help/help-button.tsx)은 resolveHelpTopicId()로 토픽 ID를 얻고
// useTranslations("help").raw(topicId)로 구조화된 HelpTopic 객체를 뽑아 렌더한다.

import type { UserRole } from "@/components/layout/nav"

// messages "help" 네임스페이스의 각 토픽이 갖는 구조. t.raw(topicId)가 이 shape을 돌려준다.
export interface HelpTopic {
  title: string
  intro: string
  steps: string[]
  tips: string[]
}

// 토픽 ID = "help" 네임스페이스의 키. ko.json / en.json 양쪽에 반드시 존재해야 한다(coverage 테스트로 강제).
export type HelpTopicId =
  | "homeBuyer"
  | "homeExhibitor"
  | "discoverBuyer"
  | "discoverExhibitor"
  | "meetingsBuyer"
  | "meetingsExhibitor"
  | "profileBuyer"
  | "profileExhibitor"
  | "applyBuyer"
  | "applyExhibitor"
  | "notifications"
  | "welcome"
  | "organizerDashboard"
  | "organizerMembers"
  | "organizerForcedMatching"
  | "admin"
  | "generalBuyer"
  | "generalExhibitor"
  | "generalOrganizer"

// resolver가 폴백으로 돌려줄 수 있는 역할별 일반 도움말 — 특정 화면 매칭이 없을 때 쓴다.
const GENERAL_BY_ROLE: Record<UserRole, HelpTopicId> = {
  buyer: "generalBuyer",
  exhibitor: "generalExhibitor",
  organizer: "generalOrganizer",
}

// (pathname, role) → 도움말 토픽 ID. 항상 유효한 토픽 ID를 반환한다(폴백 = 역할별 일반 도움말).
//
// 라우트 우선 판정 이유: 라우트 자체가 역할을 상당 부분 규정한다(/organizer/*=운영자, /exhibitor/*=참가사,
// /profile=바이어). 바이어·참가사가 공유하는 화면(/, /discover, /meetings)에서만 role로 분기한다.
// 순서 주의: 더 구체적인 접두사(/organizer/members)를 넓은 접두사(/organizer)보다 먼저 검사한다.
export function resolveHelpTopicId(pathname: string, role: UserRole): HelpTopicId {
  const path = normalize(pathname)

  // 운영자 · 슈퍼어드민 콘솔
  if (path === "/admin" || path.startsWith("/admin/")) return "admin"
  if (path.startsWith("/organizer/forced-matching")) return "organizerForcedMatching"
  if (path.startsWith("/organizer/members")) return "organizerMembers"
  if (path === "/organizer" || path.startsWith("/organizer/")) return "organizerDashboard"

  // 참가사(exhibitor) 전용 라우트 — 라우트로 역할이 확정된다.
  if (path.startsWith("/exhibitor/apply")) return "applyExhibitor"
  if (path.startsWith("/exhibitor/profile")) return "profileExhibitor"

  // 바이어 전용 라우트
  if (path.startsWith("/profile")) return "profileBuyer"
  if (path.startsWith("/apply")) return "applyBuyer"

  // 입장 전 랜딩 · 알림 — 바이어/참가사 공통 콘텐츠
  if (path.startsWith("/welcome")) return "welcome"
  if (path.startsWith("/notifications")) return "notifications"

  // 바이어·참가사가 공유하는 화면 — role로 분기
  if (path.startsWith("/discover")) return role === "exhibitor" ? "discoverExhibitor" : "discoverBuyer"
  if (path.startsWith("/meetings")) return role === "exhibitor" ? "meetingsExhibitor" : "meetingsBuyer"
  if (path === "/") return role === "exhibitor" ? "homeExhibitor" : "homeBuyer"

  // 특정 화면 매칭 없음 → 역할별 일반 도움말 폴백
  return GENERAL_BY_ROLE[role]
}

// 후행 슬래시 정규화(예: "/discover/" → "/discover"). 루트 "/"는 보존한다.
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "")
  return pathname || "/"
}
