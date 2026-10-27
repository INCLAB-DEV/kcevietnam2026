// 미팅 뮤테이션(신청/수락/거절/취소) 클라 안전 seam — lib/admin/admin-actions.ts와 같은 패턴.
//
// dispatch() 한 곳이 실연동 스왑 지점: NEXT_PUBLIC_AUTH_CLIENT==="http"면 같은 출처 BFF
// (app/api/meetings/[[...path]]) 경유로 FastAPI에 실제로 보내고, 아니면 아무 요청도 만들지 않는다
// (mock 모드에서는 호출부가 이 모듈을 아예 안 쓰거나, 기존 목업 동작을 그대로 유지 — 신청 모달의
// submit()이 그 분기를 갖고 있다). 인증 헤더는 여기가 아니라 BFF가 붙인다(경계 B, ADR-0001).

export function isMeetingHttpMode(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http"
}

export interface MeetingActionResult {
  success: boolean
  errorCode?: string
  message?: string
  // DUPLICATE_APPLICATION 전용 — 같은 상대에게 **같은 시각**으로 이미 넣어둔 신청의 id.
  // 그 미팅으로 이동시키고 싶을 때 쓴다. (#11에서 쌍 단위 중복 차단이 사라졌다 — 같은 두 기업이
  // 서로 다른 시각에 여러 번 미팅하는 건 이제 정상이고, 막히는 건 (쌍, 시각) 중복뿐이다.)
  existingMeetingId?: string
}

type ErrorDetail = { code?: string; message?: string; existing_meeting_id?: string }

async function dispatch(method: "POST" | "PUT", path: string, body?: unknown): Promise<MeetingActionResult> {
  if (!path.startsWith("/api/meetings")) return { success: false, errorCode: "BAD_PATH" }

  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.ok) return { success: true }

  const data = (await res.json().catch(() => null)) as { detail?: ErrorDetail | string } | null
  const detail = typeof data?.detail === "object" ? data.detail : undefined
  return {
    success: false,
    errorCode: detail?.code ?? (typeof data?.detail === "string" ? undefined : `http_${res.status}`),
    message: detail?.message,
    existingMeetingId: detail?.existing_meeting_id,
  }
}

export type PartyRole = "exhibitor" | "buyer"

// F-MT-001 미팅 신청. venue_type은 호출부가 이미 캐노니컬(booth/zone_table/business_room)로
// 변환해 넘긴다(모달의 VENUE_KIND_TO_CANONICAL). date_id는 안 보낸다 — 백엔드 MeetingCreateIn엔
// 그 필드가 없다(extra="forbid" — 보내면 422). 날짜는 slot_ids 자체가 담고 있다
// ("YYYY-MM-DDTHH:MM", app/meetings/schemas.py TimeSlotOut).
export function createMeeting(input: {
  counterpartOrgId: string
  slotIds: string[]
  venueType: string
  // 좌석/룸 번호(zone_table/business_room에서 사용자가 고른 구체 자리, 예: "T-03") — backend
  // MeetingCreateIn.venue_label(H-02)로 그대로 실어 보낸다. 안 보내면(부스이거나 자리 선택이
  // 없으면) 백엔드가 그 유형의 빈 자리 중 첫 번째를 자동 배정한다(기존 동작).
  venueLabel?: string | null
  reason?: string
  myRole?: PartyRole
}): Promise<MeetingActionResult> {
  return dispatch("POST", "/api/meetings", {
    counterpart_org_id: input.counterpartOrgId,
    slot_ids: input.slotIds,
    venue_type: input.venueType,
    venue_label: input.venueLabel || undefined,
    request_reason: input.reason || undefined,
    my_role: input.myRole,
  })
}

export function acceptMeeting(meetingId: string): Promise<MeetingActionResult> {
  return dispatch("POST", `/api/meetings/${encodeURIComponent(meetingId)}/accept`)
}

export function rejectMeeting(
  meetingId: string,
  reasonCode: string,
  reasonText?: string
): Promise<MeetingActionResult> {
  return dispatch("POST", `/api/meetings/${encodeURIComponent(meetingId)}/reject`, {
    reason_code: reasonCode,
    reason_text: reasonText || undefined,
  })
}

export function cancelMeeting(
  meetingId: string,
  reasonCode: string,
  reasonText?: string
): Promise<MeetingActionResult> {
  return dispatch("POST", `/api/meetings/${encodeURIComponent(meetingId)}/cancel`, {
    reason_code: reasonCode,
    reason_text: reasonText || undefined,
  })
}
