import "server-only"

// OP-001 운영 대시보드(#53)의 **실연동 구현** — FastAPI 원시 집계 엔드포인트(GET /api/admin/events/
// {event_id}/ops-metrics, app/admin/router.py get_ops_metrics)를 호출해 frontend/lib/organizer/
// ops-metrics.ts의 OpsMetricsInput·frontend/lib/organizer/saturation-status.ts의 SaturationRun
// 형태로 매핑한다.
//
// ⚠ 여기서 비율·상태묶음·시간대 버킷을 계산하지 않는다 — 백엔드도 이 행사의 원시 사실만 주므로
//   (app/admin/service.py의 OP-001 절 docstring 참고), 이미 단위테스트로 지켜진 순수 집계
//   (aggregateOpsMetrics·saturationRunStatus)가 그대로 소비한다. lib/api-client/server.ts의
//   getHomeDashboard가 raw 미팅을 내려받아 FE가 buildHomeDashboardData로 집계하는 것과 동일 원칙.
//
// 인증·event_id 해석은 OP-002/003 명단 읽기(http-members-client.ts)·OP-005 배정 프록시
// (backend-proxy.ts)와 완전히 같은 헬퍼를 재사용한다(resolveEventId·backendJson) — organizer는
// SESSION_COOKIE 존재만으로 실세션 판정(resolveOrganizerToken, http-members-client.ts).

import { redirect } from "next/navigation"
import { OperatorHttpError } from "@/lib/auth/operator-errors"
import { backendJson, resolveEventId, type ProxyResult } from "./backend-proxy"
import type {
  MeetingStatus,
  OpsMeeting,
  OpsMetricsInput,
  OpsMetricsScope,
  OpsParticipant,
  OpsReview,
  ScheduleSettings,
} from "./ops-metrics"
import type { SaturationRun, SaturationRunStatus } from "./saturation-status"

// 401(인증 실패)은 500 페이지가 아니라 재인증으로 흘려보낸다 — 세션 쿠키는 있으나(resolveOrganizerToken
// 통과) 백엔드가 거부한 경우(예: DB 리셋으로 organizer 매핑 소실)가 여기 해당한다. 토큰 자체가 없는
// 비실세션 경로는 애초에 이 함수를 타지 않는다(호출부가 이미 mock 폴백으로 분기, lib/api-client/
// server.ts getOpsDashboard 참고). 그 외 실패(500·네트워크 등)는 그대로 Error로 던져 진짜 서버 문제로 남긴다.
// 던지는 에러는 OperatorHttpError — 403/404는 digest로 상태를 실어 콘솔 error.tsx가 "권한 없음/찾을 수
// 없음" 안내로 바꾼다(lib/auth/operator-errors.ts).
function unwrap<T>(result: ProxyResult<T>, context: string): T {
  if (!result.ok) {
    if (result.status === 401) redirect("/login")
    throw new OperatorHttpError(
      result.status,
      `organizer ops-metrics read failed: ${context} (${result.status} ${result.error})`,
    )
  }
  return result.value
}

// ── 백엔드 응답 형상(snake_case) — GET .../ops-metrics(app/admin/schemas.py OpsMetricsOut) ──
interface OpsRosterSnake {
  exhibitor_registrants: number
  buyer_registrants: number
}

interface OpsParticipantSnake {
  org_id: string
  role: "exhibitor" | "buyer"
  approved: boolean
}

interface OpsMeetingSnake {
  id: string
  exhibitor_org_id: string
  buyer_org_id: string
  status: MeetingStatus
  scheduled_start: string | null
  saturation_run_id?: string | null
}

interface OpsReviewSnake {
  meeting_id: string
  reviewer_org_id: string
  counterpart_noshow: boolean
  self_noshow: boolean
}

interface OpsScheduleSnake {
  operating_start: string
  operating_end: string
  slot_minutes: number
  // Phase 1 계약서 §3.3 추가 필드 — 칸 사이 텀(분). slotsPerDay가 stride(slot_minutes+이 값)
  // 기준으로 하루 슬롯 총량을 셀 수 있도록 그대로 전달한다.
  slot_gap_minutes: number
  // 점심 블록 "HH:MM". 백엔드가 NULL을 "00:00"/"00:00"으로 내려준다(OpsScheduleOut 관례) —
  // slotTimes가 빈 구간으로 해석해 아무 칸도 건너뛰지 않는다. 이 값 없이 총량을 세면 점심을
  // 못 빼서 분모가 부풀고 슬롯 사용률이 실제보다 낮게 표시된다(mt003gap0001).
  lunch_start: string
  lunch_end: string
  event_days: number
}

interface OpsSaturationRunSnake {
  run_number: number
  status: SaturationRunStatus
  created_at: string
  min_guaranteed_slots: number
}

interface OpsMetricsSnake {
  roster: OpsRosterSnake
  participants: OpsParticipantSnake[]
  meetings: OpsMeetingSnake[]
  reviews: OpsReviewSnake[]
  schedule: OpsScheduleSnake
  saturation_runs: OpsSaturationRunSnake[]
  // 'event'(master, 행사 전역) | 'jurisdiction'(sub, 관할 바이어 활동만). 필드가 없던 구 백엔드는
  // master 전용 엔드포인트였으므로 'event'로 읽는다.
  scope?: OpsMetricsScope
}

function toParticipant(p: OpsParticipantSnake): OpsParticipant {
  return { orgId: p.org_id, role: p.role, approved: p.approved }
}

function toMeeting(m: OpsMeetingSnake): OpsMeeting {
  return {
    id: m.id,
    exhibitorOrgId: m.exhibitor_org_id,
    buyerOrgId: m.buyer_org_id,
    status: m.status,
    scheduledStart: m.scheduled_start,
    saturationRunId: m.saturation_run_id ?? null,
  }
}

function toReview(r: OpsReviewSnake): OpsReview {
  return {
    meetingId: r.meeting_id,
    reviewerOrgId: r.reviewer_org_id,
    counterpartNoshow: r.counterpart_noshow,
    selfNoshow: r.self_noshow,
  }
}

function toSchedule(s: OpsScheduleSnake): ScheduleSettings {
  return {
    operatingStart: s.operating_start,
    operatingEnd: s.operating_end,
    slotMinutes: s.slot_minutes,
    slotGapMinutes: s.slot_gap_minutes,
    lunchStart: s.lunch_start,
    lunchEnd: s.lunch_end,
    eventDays: s.event_days,
  }
}

function toSaturationRun(r: OpsSaturationRunSnake): SaturationRun {
  return {
    runNumber: r.run_number,
    status: r.status,
    createdAt: r.created_at,
    minGuaranteedSlots: r.min_guaranteed_slots,
  }
}

export async function fetchOpsMetricsInput(
  token: string,
): Promise<{ input: OpsMetricsInput; saturationRuns: SaturationRun[]; scope: OpsMetricsScope }> {
  const eventId = unwrap(await resolveEventId(token), "GET /api/admin/events")
  const data = unwrap(
    await backendJson<OpsMetricsSnake>(
      token,
      `/api/admin/events/${encodeURIComponent(eventId)}/ops-metrics`,
    ),
    "GET .../ops-metrics",
  )
  return {
    input: {
      roster: {
        exhibitorRegistrants: data.roster.exhibitor_registrants,
        buyerRegistrants: data.roster.buyer_registrants,
      },
      participants: data.participants.map(toParticipant),
      meetings: data.meetings.map(toMeeting),
      reviews: data.reviews.map(toReview),
      schedule: toSchedule(data.schedule),
    },
    saturationRuns: data.saturation_runs.map(toSaturationRun),
    scope: data.scope === "jurisdiction" ? "jurisdiction" : "event",
  }
}
