// 운영자 배정 그리드/기업 상세의 미팅 취소 — 참가자 취소 API(app/api/meetings/[[...path]] →
// backend/app/meetings/router.py cancel_meeting)는 미팅 당사자(exhibitor/buyer org)만 통과한다
// (_assert_cancel_allowed가 principal.org_id를 미팅의 exhibitor/buyer와 대조). 운영자는 당사자가
// 아니므로 그 경로를 쓰면 403이 난다 — 발주자 QA 3차 지적 #1 "슈퍼관리자가 미팅을 취소하면 권한
// 없음"의 원인. 운영자는 반드시 이 전용 BFF(app/api/organizer/meetings/[meetingId]/cancel →
// FastAPI POST /api/admin/events/{event_id}/meetings/{meeting_id}/cancel, require_event_master)를
// 거친다 — lib/meeting/meeting-actions.ts의 dispatch와 같은 계약(MeetingActionResult)을 재사용해
// 호출부(MeetingDetailPanel)가 두 경로를 갈아끼울 수 있게 한다.

import type { MeetingActionResult } from "@/lib/meeting/meeting-actions"

type ErrorDetail = { code?: string; message?: string }

export function cancelAssignedMeeting(
  meetingId: string,
  reasonCode: string,
  reasonText?: string
): Promise<MeetingActionResult> {
  return dispatch(`/api/organizer/meetings/${encodeURIComponent(meetingId)}/cancel`, {
    reason_code: reasonCode || undefined,
    reason_text: reasonText || undefined,
  })
}

async function dispatch(path: string, body: unknown): Promise<MeetingActionResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.ok) return { success: true }

  const data = (await res.json().catch(() => null)) as
    | { detail?: ErrorDetail | string; error?: string }
    | null
  const detail = typeof data?.detail === "object" ? data.detail : undefined
  return {
    success: false,
    errorCode: detail?.code ?? data?.error ?? (typeof data?.detail === "string" ? undefined : `http_${res.status}`),
    message: detail?.message,
  }
}
