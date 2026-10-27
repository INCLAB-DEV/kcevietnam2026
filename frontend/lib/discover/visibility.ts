// 기업 탐색(F-DV-001)의 방향별 노출 규칙 — "누가 누구를 보는가"를 한곳에 캡슐화.
// PRD의 deep module `org-listing` 중 역할 게이트 부분. 검색/필터/정렬은 OrgList가 담당.
//
// 가시성 정책(F-DV-001, 2026-08-28 갱신 — 베트남 전시 정책): 기본은 완전 대칭(상대 역할만) —
// 참가사는 바이어만, 바이어는 참가사만 본다. 같은 역할 상호 열람 허용 여부는 정책을 이 모듈에
// 하드코딩하지 않고 호출부가 행사 설정(lib/event/event-settings.ts의 allowSameRoleDiscovery)에서
// 읽어 파라미터로 넘긴다 — 행사가 바뀌면(어드민 콘솔 토글) 값만 달라진다.

import type { Organization, OrgRole, ViewerRole } from "@/lib/types"

// 뷰어의 상대 역할(바이어↔참가사).
export function counterpartRole(viewerRole: ViewerRole): OrgRole {
  return viewerRole === "buyer" ? "exhibitor" : "buyer"
}

// AI 추천(매칭) 후보 — 행사 설정과 무관하게 항상 "상대 역할만"(완전 대칭). 매칭은 애초에
// 반대 역할끼리만 의미가 있어 같은 역할 상호열람 허용과 별개로 늘 좁힌다.
export function counterpartOrgs(viewerRole: ViewerRole, orgs: Organization[]): Organization[] {
  const role = counterpartRole(viewerRole)
  return orgs.filter((o) => o.role === role)
}

// 기업 탐색 전체 디렉터리(AI 추천/전체 기업/관심기업 탭 공통 소스)에 적용하는 노출 필터.
// allowSameRoleDiscovery=false(기본)면 상대 역할만, true면 양쪽 역할 모두 노출.
export function visibleOrgs(
  viewerRole: ViewerRole,
  orgs: Organization[],
  allowSameRoleDiscovery = false,
): Organization[] {
  if (allowSameRoleDiscovery) return orgs
  return orgs.filter((o) => o.role === counterpartRole(viewerRole))
}

// 상세 페이지(DV-002)·미팅 가용성 조회의 접근 권한 — 전체 기업 탭 노출 규칙과 동일 게이트.
export function canViewOrg(
  viewerRole: ViewerRole,
  org: Organization,
  allowSameRoleDiscovery = false,
): boolean {
  return allowSameRoleDiscovery || org.role === counterpartRole(viewerRole)
}
