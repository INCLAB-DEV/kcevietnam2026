import "server-only"

// OP-005 배정 스케줄 읽기의 **실연동 구현** — FastAPI GET /api/admin/events/{event_id}/
// assignment-schedule(app/admin/router.py get_assignment_schedule, app/admin/service.py "OP-005
// 배정 스케줄 읽기" 절)를 호출해 frontend/lib/organizer/assignment-schedule.ts의
// AssignmentScheduleData로 매핑한다. 강제/포화 "쓰기"는 이미 실배선된 app/api/organizer/
// assignments·saturation/route.ts와 짝이 되는 "읽기" 쪽이다.
//
// 기업 카드는 탐색(discover)과 완전히 같은 wire shape(DiscoverOrgOut, app/discover/schemas.py)라
// lib/discover/http-discover-client.ts의 toOrganization을 그대로 재사용한다(같은 매핑을 두 번
// 만들지 않는다) — 단 이 로스터는 승인·가시성 필터가 없다(운영자는 미승인 기업도 강제배정 대상으로
// 본다, "슈퍼관리자 자유도 최대" — app.matching.assignment_service 모듈 docstring).
//
// ⚠ 이 응답엔 추천(recsByOrgId)이 없다 — AI 매칭 추천 엔진은 별도 미구현 기능이라 계약 밖이다.
//   여기서 빈 값으로 채운다(임의로 점수를 지어내지 않는다, 지침 원칙).
//
// slotTimes는 백엔드가 계산하지 않는다 — 그리드 산술(하루 슬롯 시각)은 이미 테스트로 지켜진 FE
// 순수 함수(schedule.ts slotTimes)가 단일 진실원천이라 여기서 그대로 재사용한다(OP-001 ops-metrics
// 클라이언트와 동일 원칙 — 계산은 FE에 둔다).

import { redirect } from "next/navigation"
import { OperatorHttpError } from "@/lib/auth/operator-errors"
import { toOrganization } from "@/lib/discover/http-discover-client"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import type { BuyerType } from "@/lib/types"
import { backendJson, resolveEventContext, type ProxyResult } from "./backend-proxy"
import type { AssignmentDate, AssignmentScheduleData, OrganizationScheduleResult } from "./assignment-schedule"
import type { AssignmentMeeting, MatchingType } from "./forced-assignment"
import { fetchOrganizerMemberProfiles } from "./http-members-client"
import { slotTimes, type ScheduleSettings } from "./schedule"

// 401(인증 실패)은 500 페이지가 아니라 재인증으로 흘려보낸다 — http-ops-metrics-client.ts unwrap과
// 동일 원칙(토큰 있음 + 백엔드 거부 → redirect, 토큰 없음 → 호출부가 이미 mock 폴백으로 분기).
function unwrap<T>(result: ProxyResult<T>, context: string): T {
  if (!result.ok) {
    if (result.status === 401) redirect("/login")
    throw new OperatorHttpError(
      result.status,
      `organizer assignment-schedule read failed: ${context} (${result.status} ${result.error})`,
    )
  }
  return result.value
}

// ── 백엔드 응답 형상(snake_case) — GET .../assignment-schedule(app/admin/schemas.py AssignmentScheduleOut) ──
// 기업 카드는 discover의 DiscoverOrgOutSnake와 필드 단위로 동일 shape(구조적 타이핑으로 toOrganization에
// 그대로 넘긴다 — 타입을 다시 export/import하지 않는다).
interface AssignmentOrgCardSnake {
  org_id: string
  role: "exhibitor" | "buyer"
  name: string
  buyer_subtype: BuyerType | null
  booth: { hall_no: string; hall_name: string; code: string } | null
  keywords: string[]
  exhibits: string[]
  description: string | null
  employee_range: string | null
  content_category: string | null
}

interface AssignmentScheduleSettingsSnake {
  start_time: string
  end_time: string
  slot_minutes: number
  // Phase 1 계약서 §3.2 추가 필드 — 칸 사이 텀(분)과 연속 예약 상한(분). 이름·타입은 계약서
  // 그대로 백엔드가 내려준다고 가정하고 그대로 읽는다.
  slot_gap_minutes: number
  max_meeting_minutes: number
  lunch_start: string
  lunch_end: string
  min_slots: number
}

interface AssignmentMeetingSnake {
  id: string
  exhibitor_org_id: string
  buyer_org_id: string
  slot_id: string
  status: ScheduleStatus
  matching_type: "ai" | "open" | "forced" | "on_site"
  duration_minutes: number | null
  attended: boolean | null
  has_review: boolean
  venue_label: string | null
  requested_by_org_id: string | null
}

interface AssignmentScheduleSnake {
  exhibitors: AssignmentOrgCardSnake[]
  buyers: AssignmentOrgCardSnake[]
  dates: AssignmentDate[]
  settings: AssignmentScheduleSettingsSnake
  meetings: AssignmentMeetingSnake[]
  application_order: Record<string, number>
  unavailable_by_org_id: Record<string, string[]>
  contacts_by_org_id: Record<string, { name: string; title: string }>
}

// 백엔드 "on_site" ↔ FE "onsite"(forced-assignment.ts MatchingType) — 기존 어휘 불일치(DB CHECK는
// on_site, FE 타입은 onsite)를 여기서 흡수한다. forced/AI 채널은 이 값을 만들지 않아 실전 경로에선
// 거의 안 나오지만, 참가자 현장(onsite) 미팅이 그리드에 섞여 들어오면 필요하다.
function toMatchingType(t: AssignmentMeetingSnake["matching_type"]): MatchingType {
  return t === "on_site" ? "onsite" : t
}

function toSettings(s: AssignmentScheduleSettingsSnake): ScheduleSettings {
  return {
    startTime: s.start_time,
    endTime: s.end_time,
    slotMinutes: s.slot_minutes,
    slotGapMinutes: s.slot_gap_minutes,
    lunchStart: s.lunch_start,
    lunchEnd: s.lunch_end,
    minSlots: s.min_slots,
    maxMeetingMinutes: s.max_meeting_minutes,
  }
}

function toMeeting(m: AssignmentMeetingSnake): AssignmentMeeting {
  return {
    id: m.id,
    exhibitorId: m.exhibitor_org_id,
    buyerId: m.buyer_org_id,
    slotId: m.slot_id,
    status: m.status,
    matchingType: toMatchingType(m.matching_type),
    durationMinutes: m.duration_minutes ?? undefined,
    attended: m.attended ?? undefined,
    hasReview: m.has_review,
    venue: m.venue_label ?? undefined,
    requestedByOrgId: m.requested_by_org_id ?? undefined,
  }
}

// 그리드 모양 응답 → 화면 계약. 행사 전역 그리드와 기업 디테일 일정이 같은 매핑을 쓴다.
function toScheduleData(timezone: string, data: AssignmentScheduleSnake): AssignmentScheduleData {
  const settings = toSettings(data.settings)
  return {
    timezone,
    // 운영자 콘솔은 한국어 고정 — 직원 규모 등 코드→라벨 변환도 ko로 명시한다.
    exhibitors: data.exhibitors.map((card) => toOrganization(card, "ko")),
    buyers: data.buyers.map((card) => toOrganization(card, "ko")),
    dates: data.dates,
    settings,
    slotTimes: slotTimes(settings),
    meetings: data.meetings.map(toMeeting),
    recsByOrgId: {}, // AI 매칭 추천 엔진 미구현 — 지어내지 않는다(추천 오버레이 없음)
    applicationOrder: data.application_order,
    unavailableByOrgId: data.unavailable_by_org_id,
    contactsByOrgId: data.contacts_by_org_id,
  }
}

export async function fetchAssignmentSchedule(token: string): Promise<AssignmentScheduleData> {
  const event = unwrap(await resolveEventContext(token), "GET /api/admin/events")
  const eventId = event.id
  // 신청서(profilesByOrgId)는 별도 엔드포인트(organizer read seam getMemberProfiles와 동일 소스,
  // http-members-client.fetchOrganizerMemberProfiles)라 그리드 조회와 병렬로 받는다 — 상세 슬라이드
  // (CompanyApplication)에서만 쓰이므로 그리드 자체 지연을 늘리지 않는다.
  const [data, profilesByOrgId] = await Promise.all([
    backendJson<AssignmentScheduleSnake>(
      token,
      `/api/admin/events/${encodeURIComponent(eventId)}/assignment-schedule`,
    ).then((result) => unwrap(result, "GET .../assignment-schedule")),
    fetchOrganizerMemberProfiles(token),
  ])
  return { ...toScheduleData(event.timezone, data), profilesByOrgId }
}

// OP-003 기업 디테일 일정(조회) — GET .../organizations/{id}/schedule(master+sub, 관할 검사). 행사 전역
// 그리드(master 전용)와 달리 sub도 부를 수 있고, 관할 밖(403)·없는 기업(404)은 **던지지 않고** 결과로
// 돌려준다 — 페이지가 콘솔 레이아웃 안에서 "권한 없음/찾을 수 없음" 안내를 그리게 하기 위해서다(예상된
// 실패는 값으로, Next 에러 처리 가이드). 그 외 실패(500 등)는 unwrap이 던져 error.tsx가 받는다.
export async function fetchOrganizationSchedule(
  token: string,
  organizationId: string,
): Promise<OrganizationScheduleResult> {
  const event = unwrap(await resolveEventContext(token), "GET /api/admin/events")
  const result = await backendJson<AssignmentScheduleSnake>(
    token,
    `/api/admin/events/${encodeURIComponent(event.id)}/organizations/${encodeURIComponent(organizationId)}/schedule`,
  )
  if (!result.ok && result.status === 403) return { status: "forbidden" }
  if (!result.ok && result.status === 404) return { status: "not_found" }
  const data = unwrap(result, "GET .../organizations/{id}/schedule")
  return { status: "ok", data: toScheduleData(event.timezone, data) }
}
