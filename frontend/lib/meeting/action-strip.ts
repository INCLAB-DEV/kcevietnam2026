// MY-001 상단 액션 스트립 집계(F-MY-001 D15~D18). "나를 기다리는 액션"만 추린다.
// 단일 소스: 분류 술어(isReceivedRequest/isPendingReview)를 홈 rollup과 공유한다 — 카운트와
// "점프 대상 id"가 같은 정의에서 나오므로 둘이 어긋날 수 없다(codex P2). 같은 개념엔 같은 라벨
// — 받은 미팅요청(receivedRequests)·회의록(pendingReview).

import {
  rollupMeetingStatus,
  isReceivedRequest,
  isPendingReview,
  type ScheduleEntry,
} from "@/lib/home/meeting-status-rollup"
import { isExpiredProposed } from "@/lib/meeting/timeline"
import { resolveDirection } from "@/lib/meeting/meeting-projection"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ViewerRole } from "@/lib/types"

export interface ActionStripView {
  receivedRequests: number // 받은 미팅요청(받은 proposed) — 수락/거부 필요
  earliestReceivedId: string | null // 가장 이른 받은 미팅요청(점프 대상)
  pendingReview: number // 회의록 미작성(완료·노쇼 & !hasReview) — 작성 필요
  earliestReviewId: string | null // 가장 이른 회의록 작성 대상(점프 대상)
}

// 미팅의 viewer 측 org. 권한 경계(내 기업 당사자만)에 쓴다 — 홈 집계와 동일 규칙.
function viewerSideOrgId(m: MeetingRecord, role: ViewerRole): string {
  return role === "exhibitor" ? m.exhibitorOrgId : m.buyerOrgId
}

export function resolveActionStrip(input: {
  meetings: MeetingRecord[]
  viewerRole: ViewerRole
  viewerOrgId: string
  now?: { date: string; time: string } // 만료(수락 전 시간 지남) 제외용
}): ActionStripView {
  const mine = input.meetings
    .filter((m) => viewerSideOrgId(m, input.viewerRole) === input.viewerOrgId)
    // 만료된 받은요청은 처리 불가 → "받은 미팅요청" 카운트·점프 대상에서 제외.
    .filter((m) => !isExpiredProposed(m.status, m.scheduledAt, input.now))

  // 각 미팅을 rollup의 분류 단위(ScheduleEntry)로 투영. 카운트와 점프 대상이 같은 술어를 쓰도록.
  const classified = mine.map((m) => ({
    meeting: m,
    entry: {
      id: m.id,
      status: m.status,
      hasReview: m.hasReview,
      attended: m.attended, // 노쇼(false)는 회의록 대상 제외 — isPendingReview가 사용
      // 내가 보낸 요청이면 sent, 아니면 received(내가 수락해야 하는 건). null=운영자 배정.
      direction: resolveDirection(m.requestedByOrgId, input.viewerOrgId),
    } as ScheduleEntry,
  }))

  const rollup = rollupMeetingStatus(classified.map((c) => c.entry))

  // 술어에 맞는 미팅 중 일정상 가장 이른 것의 id(없으면 null). 카운트와 동일 술어 → 어긋나지 않음.
  const earliestId = (pred: (e: ScheduleEntry) => boolean): string | null =>
    classified
      .filter((c) => pred(c.entry))
      .sort((a, b) => a.meeting.scheduledAt.localeCompare(b.meeting.scheduledAt))[0]?.meeting.id ??
    null

  return {
    receivedRequests: rollup.receivedRequests,
    earliestReceivedId: earliestId(isReceivedRequest),
    pendingReview: rollup.pendingReview,
    earliestReviewId: earliestId(isPendingReview),
  }
}
