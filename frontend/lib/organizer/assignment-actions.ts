// OP-005 — 배정 쓰기의 클라 → 서버 호출(assignment-hub가 useTransition 안에서 부른다).
// 계약은 app/api/organizer/{assignments,saturation,saturation/confirm} 라우트와 짝.
// 실패는 던지지 않고 결과로 돌려준다 — 호출측이 낙관적 업데이트 롤백/토스트를 정한다.

import type { AssignmentMeeting } from "./forced-assignment"
import type { SaturationDraft } from "./saturation"
import type { ScheduleSettings } from "./schedule"

// SLOT_TAKEN에서 그 시각에 이미 확정 미팅이 있는 쪽(백엔드 MeetingError의 busy_roles).
export type BusyRole = "exhibitor" | "buyer"

export interface AssignmentActionResult {
  success: boolean
  // 실패 코드 — 백엔드 MeetingError.code(SLOT_TAKEN·VENUE_TAKEN…) 또는 BFF 코드(session_expired·
  // no_event·invalid_slot…). "network"는 **브라우저→서버 fetch 자체가 던졌을 때만** 쓴다(아래 post).
  error?: string
  // 백엔드가 준 사람이 읽는 이유(MeetingError.message) — 화면 문구의 재료.
  message?: string
  busyRoles?: BusyRole[]
  // ⚡ 재보충 배치가 중간에 실패했을 때, 그 앞까지 이미 저장된 건수(app/api/organizer/assignments).
  savedCount?: number
}

export interface SaturationRunResult extends AssignmentActionResult {
  draft?: SaturationDraft
}

// 실세션(backend proxy) confirm 응답의 부분성공 요약 — mock 모드는 항상 confirmedCount=전체,
// skippedCount=0(부분 실패 개념이 없다). app/api/organizer/saturation/confirm/route.ts 참고.
export interface SaturationConfirmResult extends AssignmentActionResult {
  confirmedCount?: number
  skippedCount?: number
}

const post = async (url: string, body: unknown): Promise<{ ok: boolean; data: unknown }> => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as unknown
    return { ok: res.ok, data }
  } catch {
    // fetch 자체가 던졌다 = 진짜 네트워크 실패(오프라인·연결 끊김). 화면이 "네트워크 확인"이라고
    // 말해도 되는 **유일한** 경우다(forced-assignment-submit.ts NETWORK_ERROR).
    return { ok: false, data: { error: "network" } }
  }
}

// BFF 실패 바디({success:false, error, message?, busyRoles?, savedCount?} — backend-proxy
// sessionAwareErrorResponse) → 결과. 바디를 못 읽으면(서버 500 HTML 등) "server_error"다 —
// 네트워크 탓이 아니다.
function failureOf(data: unknown): AssignmentActionResult {
  const body = (data ?? {}) as {
    error?: unknown
    message?: unknown
    busyRoles?: unknown
    savedCount?: unknown
  }
  const result: AssignmentActionResult = {
    success: false,
    error: typeof body.error === "string" ? body.error : "server_error",
  }
  if (typeof body.message === "string" && body.message) result.message = body.message
  if (Array.isArray(body.busyRoles)) {
    result.busyRoles = body.busyRoles.filter(
      (r): r is BusyRole => r === "exhibitor" || r === "buyer",
    )
  }
  if (typeof body.savedCount === "number" && body.savedCount > 0) result.savedCount = body.savedCount
  return result
}

// 강제 배정·단일 일괄배정 확정 — 확정된 미팅들을 저장.
export const postAssignments = async (
  meetings: AssignmentMeeting[],
): Promise<AssignmentActionResult> => {
  const { ok, data } = await post("/api/organizer/assignments", { meetings })
  return ok ? { success: true } : failureOf(data)
}

// 전체 포화배정 실행 — 서버가 Draft를 계산해 돌려준다(미발효).
export const postSaturationRun = async (input: {
  settings: ScheduleSettings
  assignMinutes: number
  runNumber: number
  now: { date: string; time: string }
}): Promise<SaturationRunResult> => {
  const { ok, data } = await post("/api/organizer/saturation", input)
  if (!ok) return failureOf(data)
  const draft = (data as { draft?: SaturationDraft } | null)?.draft
  if (!draft) return { success: false, error: "invalid_response" }
  return { success: true, draft }
}

// Draft 확정 — 검토 통과분 발효.
export const postSaturationConfirm = async (
  draftAssignments: AssignmentMeeting[],
): Promise<SaturationConfirmResult> => {
  const { ok, data } = await post("/api/organizer/saturation/confirm", { draftAssignments })
  if (!ok) return failureOf(data)
  const parsed = data as { confirmedCount?: number; skippedCount?: number } | null
  return { success: true, confirmedCount: parsed?.confirmedCount, skippedCount: parsed?.skippedCount }
}
