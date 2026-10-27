// 기업 관리 테이블의 순수 로직(검색·필터·정렬). 컴포넌트가 아니라 여기서 판정한다 — 외부 관찰
// 가능한 동작만 테스트한다. 페이지네이션은 운영자 콘솔과 같은 규칙을 재사용한다
// (lib/organizer/members의 paginate/pageCount/pageItems — 순수 함수라 표면이 달라도 안전하게 공유).

import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"
import { matchesAnySelected } from "@/lib/category-filter"
import type { AdminOrganization, AdminOrgRole } from "./types"

export { APPLICATION_STATUSES }

export interface AdminOrgFilters {
  query: string // 기업명(국/영)·담당자·이메일 검색
  roles: AdminOrgRole[] // 빈 배열 = 전체
  statuses: ApplicationStatus[] // 빈 배열 = 전체
  proxyOnly: boolean // 대리작성분만
  categories: string[] // business fields
  contentCategories: string[] // exhibitor category
}

export const EMPTY_ORG_FILTERS: AdminOrgFilters = {
  query: "",
  roles: [],
  statuses: [],
  proxyOnly: false,
  categories: [],
  contentCategories: [],
}

export type AdminOrgSort = "name" | "status" | "meetings" | "updated"
export const ADMIN_ORG_SORTS: readonly AdminOrgSort[] = ["name", "status", "meetings", "updated"]
export const ADMIN_ORG_SORT_LABELS: Record<AdminOrgSort, string> = {
  name: "기업명순",
  status: "상태순",
  meetings: "미팅 건수순",
  updated: "최근 수정순",
}

// 상태 정렬 우선순위 — 운영자가 손댈 것(제출됨·보완요청)이 위로, 종단(반려)이 아래로.
const STATUS_RANK: Record<ApplicationStatus, number> = {
  submitted: 0,
  changes_requested: 1,
  registered: 2,
  approved: 3,
  rejected: 4,
}

// 선택된 행사로 먼저 스코프한다 — 멀티 행사 콘솔이라 모든 뷰의 첫 단계가 이것이다.
export function scopeToEvent<T extends { event_id: string }>(rows: T[], eventId: string): T[] {
  return rows.filter((r) => r.event_id === eventId)
}

export function filterOrganizations(
  rows: AdminOrganization[],
  filters: AdminOrgFilters,
): AdminOrganization[] {
  const q = filters.query.trim().toLowerCase()
  const roles = new Set(filters.roles)
  const statuses = new Set(filters.statuses)
  const categories = new Set(filters.categories)
  const contentCategories = new Set(filters.contentCategories)
  return rows.filter((r) => {
    const matchesQuery =
      !q ||
      r.name_ko.toLowerCase().includes(q) ||
      (r.name_en?.toLowerCase().includes(q) ?? false) ||
      (r.contact_name?.toLowerCase().includes(q) ?? false) ||
      (r.contact_email?.toLowerCase().includes(q) ?? false)
    const matchesRole = roles.size === 0 || roles.has(r.role)
    const matchesStatus = statuses.size === 0 || statuses.has(r.application_status)
    const matchesProxy = !filters.proxyOnly || r.proxy_written
    const matchesFields = matchesAnySelected(r.business_field_codes, categories)
    const matchesContent = matchesAnySelected(
      r.content_category != null ? [r.content_category] : [], contentCategories,
    )
    return matchesQuery && matchesRole && matchesStatus && matchesProxy && matchesFields && matchesContent
  })
}

// 안정 정렬: 동률은 기업명 가나다순으로 tie-break해 재현 가능한 순서를 만든다.
export function sortOrganizations(
  rows: AdminOrganization[],
  sort: AdminOrgSort,
): AdminOrganization[] {
  const byName = (a: AdminOrganization, b: AdminOrganization) =>
    a.name_ko.localeCompare(b.name_ko, "ko")
  const arr = [...rows]
  if (sort === "name") arr.sort(byName)
  else if (sort === "meetings") arr.sort((a, b) => b.meeting_count - a.meeting_count || byName(a, b))
  else if (sort === "updated")
    arr.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byName(a, b))
  else
    arr.sort(
      (a, b) =>
        STATUS_RANK[a.application_status] - STATUS_RANK[b.application_status] || byName(a, b),
    )
  return arr
}

// 대리작성 대상(미신청) 수 — 대시보드 카드·기업 관리 헤더가 같은 정의를 쓰게 한다.
//
// 회원가입으로 새로 유입되는 기업도 application_status = "registered"로 들어오므로 이 집계와
// "미신청" 배지·필터가 그대로 신규 가입자를 덮는다 — 가입 경로용 별도 상태를 만들지 않는다
// (상태의 뜻은 "아직 비즈매칭 신청서를 내지 않음"이지 "명단으로 들어옴"이 아니다, ADR-0009).
export function countUnsubmitted(rows: AdminOrganization[]): number {
  return rows.filter((r) => r.application_status === "registered").length
}

// ── 역할 전환(바이어 ↔ 참가사) ───────────────────────────────────────────────

export type RoleSwitchOutcome =
  | { ok: true; organization: AdminOrganization }
  | { ok: false; reason: "same-role" | "has-meetings"; message: string }

// 이미 잡힌 미팅이 있으면 막는다. 미팅 행은 (exhibitor_id, buyer_id) 두 축으로 기업을 참조하는데,
// 역할을 뒤집으면 그 참조가 반대편 축으로 가야 해서 기존 미팅이 "참가사 자리에 바이어가 앉은" 상태가
// 된다. 운영자가 미팅을 먼저 정리하도록 안내하는 편이 데이터가 조용히 깨지는 것보다 낫다.
export function switchOrgRole(
  org: AdminOrganization,
  nextRole: AdminOrgRole,
  at: string,
): RoleSwitchOutcome {
  if (org.role === nextRole) {
    return { ok: false, reason: "same-role", message: "이미 해당 역할입니다." }
  }
  if (org.meeting_count > 0) {
    return {
      ok: false,
      reason: "has-meetings",
      message: `이 기업에는 미팅 ${org.meeting_count}건이 잡혀 있습니다. 역할을 바꾸면 기존 미팅의 양측 배치가 어긋나므로, 미팅 관리에서 먼저 정리한 뒤 전환해 주세요.`,
    }
  }
  return { ok: true, organization: { ...org, role: nextRole, updated_at: at } }
}
