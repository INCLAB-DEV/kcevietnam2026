// OP-002 운영자 명단 관리의 순수 로직 (F-OP-002 / 이슈 #51).
// 화면(컴포넌트)이 아니라 여기서 검색·필터·정렬·상태 판정을 한다 — 외부 관찰 동작만 테스트한다.
// 데이터 소스는 v1 mock(members-mock). 실연동 시 FastAPI 조회 결과(같은 MemberRow shape)로 스왑한다.
//
// ⚠ 리스트는 A층(등록 정보) + 파생 운영지표만 표시하고(F-OP-002 D18), 비즈매칭 신청서(B층) 선언
//   내용 전체는 "신청서 조회" 모달에서만 본다. 컬럼은 KOTRA 소스 ②/별첨2 기준이며 탭(참가사/바이어)별로
//   갈린다. 구 자유텍스트 "업종"은 폐기, 구조화 "전시품목 카테고리"는 A/B에서 파생해 채택(D18).

import { BUSINESS_FIELD_LABELS } from "@/lib/bm/fields"
import { matchesAnySelected } from "@/lib/category-filter"

import {
  type ApplicationStatus,
  APPLICATION_STATUSES,
  isMatchingExposed,
} from "@/lib/application-status"
import { APPLICATION_STATUS_LABELS } from "./participant-labels"

// 명단 모집단 탭: 참가사 / 바이어 (organization_event_roles.role 출처유추, ADR-0009 D5).
// 글로서리: "참가기업"은 Organization avoid-term이라 역할 라벨은 "참가사"를 쓴다.
export type MemberTab = "exhibitor" | "buyer"
export const MEMBER_TABS: readonly MemberTab[] = ["exhibitor", "buyer"]
export const MEMBER_TAB_LABELS: Record<MemberTab, string> = {
  exhibitor: "참가사",
  buyer: "바이어",
}

export type { ApplicationStatus }
export { APPLICATION_STATUS_LABELS, APPLICATION_STATUSES }

// 비즈매칭 상태 — 운영자 컨텍스트 라벨(F-OP-002 D18). 로직 분기는 단일정본(lib/application-status)
// 술어를 쓰고, 라벨만 운영자용으로 오버라이드한다(참가자측은 등록자/검토 대기/비즈매칭 참가자 유지).
export const ORGANIZER_STATUS_LABELS: Record<ApplicationStatus, string> = {
  registered: "미신청",
  submitted: "승인대기중",
  changes_requested: "수정요청중",
  approved: "승인됨",
  rejected: "반려",
}

// 정렬 키 — 기업명 / 매칭 건수 / 비즈매칭 상태 (F-OP-002 D18 정본 3종).
export type MemberSort = "name" | "matches" | "status"
export const MEMBER_SORTS: readonly MemberSort[] = ["name", "matches", "status"]
export const MEMBER_SORT_LABELS: Record<MemberSort, string> = {
  name: "기업명순",
  matches: "매칭 건수순",
  status: "승인 상태순",
}

// 승인 상태 정렬 우선순위 — 매칭 노출(approved)이 위, 종단 반려(rejected)가 아래.
const STATUS_SORT_RANK: Record<ApplicationStatus, number> = {
  approved: 0,
  submitted: 1,
  changes_requested: 2,
  registered: 3,
  rejected: 4,
}

// 행 = organization_event_roles(회사×행사 역할). 표시값은 A층(등록) + 파생 운영지표.
// 탭별 전용 필드: 참가사=부스·전시품목 / 바이어=유형·관심품목·언어·체류정보·등록주체.
export interface MemberRow {
  contentCategory?: string | null
  businessFields?: string[]
  id: string // 행/라우팅 키 = 기업 상세(OP-003) /organizer/members/:id
  name: string // 기업명(국문)
  nameEn?: string // 기업명(영문) — 국영문 병기(소스 ② 국영문 필수)
  tab: MemberTab
  applicationStatus: ApplicationStatus
  // 담당자 1차 연락(참가자 성명/전화/이메일 — registrants, 없으면 운영자 직접입력분). A층.
  primaryContact: string | null // 1차 담당자 성명(바이어=바이어 이름). 참가사는 "이름 직위" 합쳐도 됨.
  primaryContactEn?: string // 담당자 성명 영문(바이어 이름 영문병기)
  contactTitle?: string // 직위(국문)
  contactTitleEn?: string // 직위(영문)
  contactPhone: string | null
  contactEmail: string | null
  productCategory: string | null // 전시품목(참가사)/관심품목(바이어) 카테고리 — A/B 파생
  // A층 등록 정보(KOTRA 소스 ②④ 등록 필수정보 + 별첨2). 운영자 단건등록·정정으로 채운다.
  businessRegNo?: string // 사업자등록번호 (②)
  mainTel?: string // 대표 전화번호 (②④)
  website?: string // 웹사이트/홈페이지 (별첨2)
  hsCode?: string // 품목 HS코드/설명 (②④)
  kstAvailableTime?: string // KST 상담 가능 시간 (②④)
  address?: string // 주소 (D17 A층 박제 항목)
  importedAt: string // 적재일 ISO8601
  profileCompletion: number // 0–100 (%) — 파생 운영지표
  matchCount: number // 보유 매칭(미팅) 건수 — 파생 운영지표
  lastActivityAt: string | null // ISO8601, 등록자(미로그인 유령 org)는 null
  // 참가사 전용
  boothLabel?: string // 부스정보(홀·관·부스번호) 파생 표시값
  // 바이어 전용
  buyerTypeLabel?: string // 초청/사전등록/현장
  language?: string // 통역언어(소스 ④)
  stayInfo?: string | null // 체류정보 요약(항공·숙박·통역) — 참석자 단위 상세는 모달(ADR-0013)
  registeredBy?: string // 등록주체: 무역관명 또는 "직접등록"(주최사/master)
  // 에이전트 = 바이어를 주선한 KOTRA 무역관 정보(요구사항 ④: 무역관명·실무자·전화·이메일).
  // 별개 개념 아님 — organizer(무역관) 엔티티 매핑(ADR-0012/0013). 무역관명은 등록주체와 연동되고,
  // 실무자 구조화(이름/전화/이메일)는 organizer 보강 = 스핀오프 ①(#110) 소관.
  agentName?: string // 무역관명
  agentContact?: string // 무역관 실무 담당자
  agentPhone?: string // 무역관 실무자 전화
  agentEmail?: string // 무역관 실무자 이메일
}

export interface MemberFilters {
  contentCategories?: string[] // 대표 카테고리(3종), 참가사 전용
  query: string // 기업명(국/영) 검색
  statuses: ApplicationStatus[] // 비즈매칭 상태 다중 선택(빈 배열=전체)
  categories: string[] // 전시품목/관심품목 카테고리 다중 선택
  hasMatchesOnly: boolean // 매칭 보유(matchCount>0)만
}

export const EMPTY_FILTERS: MemberFilters = {
  query: "",
  statuses: [],
  categories: [],
  hasMatchesOnly: false,
}

// 비즈매칭 참가자(매칭/배정 노출) 여부 — approved 단일 기준(lib/application-status, ADR-0009 §6).
export function isParticipant(row: MemberRow): boolean {
  return isMatchingExposed(row.applicationStatus)
}

// 선택지는 현재 데이터와 무관한 정규 8종. 기존 mock 라벨도 코드로 해석한다.
export function businessFieldCodes(row: MemberRow): string[] {
  if (row.businessFields) return row.businessFields
  return (row.productCategory ?? "").split(",").map((value) => {
    const label = value.trim()
    return Object.entries(BUSINESS_FIELD_LABELS).find(([code, text]) => code === label || text === label)?.[0] ?? label
  }).filter(Boolean)
}

export function categoryOptions(): string[] {
  return Object.values(BUSINESS_FIELD_LABELS)
}

// 탭 + 검색 + 패싯 필터. 정렬과 분리(순수 함수 합성). 검색은 국/영 기업명 모두 본다.
export function filterMembers(
  rows: MemberRow[],
  tab: MemberTab,
  filters: MemberFilters,
): MemberRow[] {
  const q = filters.query.trim().toLowerCase()
  const statuses = new Set(filters.statuses)
  const categories = new Set(filters.categories.map((value) =>
    Object.entries(BUSINESS_FIELD_LABELS).find(([code, label]) => code === value || label === value)?.[0] ?? value,
  ))
  return rows.filter((r) => {
    if (r.tab !== tab) return false
    const matchesQuery =
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.nameEn?.toLowerCase().includes(q) ?? false)
    const matchesStatus = statuses.size === 0 || statuses.has(r.applicationStatus)
    const matchesCategory = matchesAnySelected(businessFieldCodes(r), categories)
    const matchesContent = tab === "buyer" || matchesAnySelected(
      r.contentCategory != null ? [r.contentCategory] : [],
      new Set(filters.contentCategories ?? []),
    )
    const matchesMatches = !filters.hasMatchesOnly || r.matchCount > 0
    return matchesQuery && matchesStatus && matchesCategory && matchesContent && matchesMatches
  })
}

// 한 페이지 행 수(기본). 실데이터(참가기업 103·바이어 178)에서 목록이 길어 페이지네이션한다.
export const MEMBERS_PAGE_SIZE = 10

// 전체 페이지 수(빈 목록도 최소 1페이지).
export function pageCount(total: number, pageSize: number = MEMBERS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

// page(1-base)에 해당하는 행 구간. page는 호출부에서 1..pageCount로 클램프해 넘긴다.
export function paginate<T>(rows: T[], page: number, pageSize: number = MEMBERS_PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize
  return rows.slice(start, start + pageSize)
}

// 페이지 버튼 구성. 7페이지 이하는 전부, 초과 시 1·현재±1·끝을 보이고 사이는 생략(…)으로.
export type PageItem = number | "ellipsis"
export function pageItems(current: number, total: number): PageItem[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const items: PageItem[] = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) items.push("ellipsis")
  for (let i = left; i <= right; i++) items.push(i)
  if (right < total - 1) items.push("ellipsis")
  items.push(total)
  return items
}

// 안정 정렬: 동률은 기업명 가나다순으로 tie-break해 재현 가능한 순서를 만든다.
export function sortMembers(rows: MemberRow[], sort: MemberSort): MemberRow[] {
  const byName = (a: MemberRow, b: MemberRow) => a.name.localeCompare(b.name, "ko")
  const arr = [...rows]
  if (sort === "name") {
    arr.sort(byName)
  } else if (sort === "matches") {
    arr.sort((a, b) => b.matchCount - a.matchCount || byName(a, b))
  } else {
    arr.sort(
      (a, b) =>
        STATUS_SORT_RANK[a.applicationStatus] - STATUS_SORT_RANK[b.applicationStatus] ||
        byName(a, b),
    )
  }
  return arr
}
