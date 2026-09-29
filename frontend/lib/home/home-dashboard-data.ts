// 한 사용자의 역할·유형을 입력받아 HM-001 네 블록을 조립하는 읽기 전용 집계 모듈.
// 화면은 이 결과를 그리기만 한다. 권한 경계(내 기업 데이터만)는 FastAPI가 1차로 처리하지만(ADR-0008),
// 읽기 측에서도 viewerOrgId로 한 번 더 거른다.

import { rollupMeetingStatus, type MeetingStatusRollup, type ScheduleStatus } from "./meeting-status-rollup"
import { filterViewerMeetings, kstDate, resolveDirection } from "@/lib/meeting/meeting-projection"

export type ParticipantRole = "buyer" | "exhibitor"

export interface MeetingRecord {
  id: string
  status: ScheduleStatus
  hasReview: boolean
  // 참석 여부 — status==="completed"일 때만 의미. false=노쇼(불참). 미지정 시 참석(true).
  // 노쇼는 별도 상태가 아니라 완료 미팅의 결과 속성이다(ADR-0010, 진실원천=post_meeting_reviews).
  attended?: boolean
  scheduledAt: string // ISO8601 (KST offset 포함)
  durationMinutes?: number // 미팅 소요시간(30/60/90). 미지정 시 30. 30분 슬롯 1~3칸 연속 점유(F-MY-001 D4)
  buyerOrgId: string
  exhibitorOrgId: string
  // 미팅 요청을 보낸 org (방향 판정용). null=운영자 배정(신청 주체 org 없음) — resolveDirection이
  // "organizer" 방향으로 해석한다(백엔드 MeetingOut.requested_by_org_id nullable과 동일 계약).
  requestedByOrgId: string | null
  // 신청 주체 역할(참고용) — 방향 판정 자체는 requestedByOrgId로 하므로 필수는 아니다.
  requestedBy?: "exhibitor" | "buyer" | "organizer" | null
  counterpartName: string
  venue: string
  // 신청 메시지(request_reason) — 신청자가 확인 화면에서 적은 사유. 수신측(응답 대기 측)이
  // 수락/거절을 판단하는 핵심 정보라 미팅 상세에 보여준다(H-03). 없으면 undefined(비어 있음과
  // 미조회를 구분하지 않는다 — 화면은 값이 없으면 그냥 줄을 숨긴다).
  requestReason?: string | null
}

export interface HomeDashboardInput {
  viewerRole: ParticipantRole
  viewerOrgId: string
  meetings: MeetingRecord[]
  today: string // YYYY-MM-DD (KST). Date.now()는 모듈에서 쓰지 않고 주입받는다.
}

export interface HomeDashboardData {
  statusRollup: MeetingStatusRollup
  todaySchedule: MeetingRecord[]
}

// 오늘 일정에서 제외할 상태: 취소·거절은 "성사되지 않은" 건이라 일정에 노출하지 않는다.
const NOT_SCHEDULED: ScheduleStatus[] = ["cancelled", "rejected"]

export function buildHomeDashboardData(input: HomeDashboardInput): HomeDashboardData {
  // 권한 경계: 내 기업이 당사자인 미팅만 (viewer 필터·KST 투영은 meeting-projection 공유).
  const mine = filterViewerMeetings(input.meetings, input.viewerRole, input.viewerOrgId)

  const todaySchedule = mine
    .filter((m) => kstDate(m.scheduledAt) === input.today)
    .filter((m) => !NOT_SCHEDULED.includes(m.status))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))

  return {
    statusRollup: rollupMeetingStatus(
      mine.map((m) => ({
        id: m.id,
        status: m.status,
        hasReview: m.hasReview,
        attended: m.attended, // 노쇼(false)는 회의록 대상 제외(isPendingReview)
        // 내가 보낸 요청이면 sent, 아니면 received(내가 수락해야 하는 건). null=운영자 배정.
        direction: resolveDirection(m.requestedByOrgId, input.viewerOrgId),
      }))
    ),
    todaySchedule,
  }
}
