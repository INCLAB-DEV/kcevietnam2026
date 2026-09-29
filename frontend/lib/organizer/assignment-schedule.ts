// assignment-schedule (F-OP-005 / F-OP-003) — 배정 그리드의 seam 계약 타입 + 클라 안전 파생.
//
// 이 모듈은 휴리스틱(추천 점수계산)을 import하지 않는다 — 점수는 서버(assignment-mock)에서 계산해
// recsByOrgId로 내려오고(ADR-0001/0008), 여기 fitFromRecs는 그 점수를 selection용 맵으로 바꾸기만 한다.
// 그리드 허브(client)와 seam(server) 양쪽이 이 타입을 공유한다.

import type { Organization } from "@/lib/types"
import type { MatchResult } from "@/lib/api-client/types"
import type { AssignmentMeeting } from "./forced-assignment"
import type { MemberProfile } from "./member-profile"
import type { ScheduleSettings } from "./schedule"

export interface AssignmentDate {
  id: string // "2026-09-16"
  label: string // "9/16"
  weekday: string // "수"
}

// 배정 화면 한 묶음 — 기업(양 모집단)·행사일·운영설정·슬롯시각(그리드 열)·현재 미팅(셀)·추천·신청순.
export interface AssignmentScheduleData {
  // 행사 현지 타임존(IANA). slotId(행사 로컬 벽시계) ↔ ISO 변환에 쓴다(H5/P0-2). 미지정(mock 등)은
  // 소비처가 "Asia/Seoul"로 폴백 — 기존 동작 보존을 위한 optional.
  timezone?: string
  exhibitors: Organization[]
  buyers: Organization[]
  dates: AssignmentDate[]
  settings: ScheduleSettings
  slotTimes: string[] // 하루 슬롯 시각(모든 날짜 공통) — 그리드 가로 열
  meetings: AssignmentMeeting[] // 현재 배정된 미팅(셀 채움)
  recsByOrgId: Record<string, MatchResult[]> // org id → 매칭순 반대편 후보(빈슬롯 시트·selection)
  applicationOrder: Record<string, number> // org id → 비즈매칭 신청 순번(tie-break)
  // 기업별 "불가" 슬롯 id 목록 — 각 기업이 비즈매칭 신청 때 지정한 배정 불가 시간대. 없으면 전부 가능.
  unavailableByOrgId: Record<string, string[]>
  // org id → 담당자(이름·직함). 상세 슬라이드의 참석자 표시(내 미팅과 동일). 실연동 시 FastAPI 결과로 교체.
  contactsByOrgId: Record<string, { name: string; title: string }>
  // org id → 실제 제출된 비즈매칭 신청서(organizer read seam getMemberProfiles와 동일 소스, 신청
  // 이력 없는 기업은 키 자체가 없다). 상세 슬라이드의 "비즈매칭 신청서" 섹션(CompanyApplication)이
  // 읽는다 — 없으면 그 컴포넌트가 데모 값을 채우지 않고 빈 값/미제출 안내로 표시한다.
  profilesByOrgId?: Record<string, MemberProfile>
}

// OP-003 기업 디테일 일정 조회 결과 — 관할 밖(forbidden)·없는 기업(not_found)은 예외가 아니라 값이다.
// 화면은 이 결과로 콘솔 레이아웃 안에서 안내를 그린다(서버 오류 화면으로 무너지지 않게).
export type OrganizationScheduleResult =
  | { status: "ok"; data: AssignmentScheduleData }
  | { status: "forbidden" }
  | { status: "not_found" }

// recs(점수+사유)에서 selection용 적합도 점수 맵을 파생 — saturation.SaturationInput.fit 형태.
export function fitFromRecs(
  recsByOrgId: Record<string, MatchResult[]>,
): Record<string, Record<string, number>> {
  const fit: Record<string, Record<string, number>> = {}
  for (const [orgId, recs] of Object.entries(recsByOrgId)) {
    const scores: Record<string, number> = {}
    for (const rec of recs) scores[rec.org.id] = rec.aiScore
    fit[orgId] = scores
  }
  return fit
}

// 비-AI 폴백 후보(#6) — AI 매칭 추천 엔진이 아직 없어 recsByOrgId가 실 세션에서 항상 비어(#6 원인)
// 빈 슬롯 시트·상세 슬라이드의 후보 목록이 100% 0명이 되던 결함의 수정. "최적 상대"가 아니라
// "배정 가능한 상대 전부"를 이름순(가나다)으로 낸다 — 점수는 지어내지 않는다(aiScore: null,
// CandidateRow가 null이면 매칭률 표시를 숨긴다). 호출부가 그 시간에 비었는지(isFreeAt)·본인이
// 불가로 지정하지 않았는지(isAvailableAt)를 마저 걸러 최종 후보로 쓴다.
export interface FallbackCandidate {
  org: Organization
  aiScore: null
}

export function oppositeCandidates(
  data: Pick<AssignmentScheduleData, "exhibitors" | "buyers">,
  role: Organization["role"],
): FallbackCandidate[] {
  const pool = role === "exhibitor" ? data.buyers : data.exhibitors
  return [...pool]
    .sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .map((org) => ({ org, aiScore: null }))
}

// 불가 슬롯 목록(Record<string,string[]>)을 조회 빠른 집합 맵으로 변환 — 엔진·그리드 판정용.
export function unavailableSets(
  unavailableByOrgId: Record<string, string[]>,
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {}
  for (const [id, slots] of Object.entries(unavailableByOrgId)) out[id] = new Set(slots)
  return out
}

// id → Organization 인덱스(셀의 상대 기업명 조회 등).
export function indexOrgs(data: Pick<AssignmentScheduleData, "exhibitors" | "buyers">): Record<string, Organization> {
  const byId: Record<string, Organization> = {}
  for (const org of [...data.exhibitors, ...data.buyers]) byId[org.id] = org
  return byId
}
