// OP-005 — 배정 쓰기의 클라 → 서버 호출(assignment-hub가 useTransition 안에서 부른다).
// 계약은 app/api/organizer/{assignments,saturation,saturation/confirm} 라우트와 짝.
// 실패는 던지지 않고 결과로 돌려준다 — 호출측이 낙관적 업데이트 롤백/토스트를 정한다.

import type { AssignmentMeeting } from "./forced-assignment"
import type { SaturationDraft } from "./saturation"
import type { ScheduleSettings } from "./schedule"

export interface AssignmentActionResult {
  success: boolean
  error?: string
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
    return { ok: false, data: { error: "network" } }
  }
}

const errorOf = (data: unknown): string =>
  (data as { error?: string } | null)?.error ?? "server_error"

// 강제 배정·단일 일괄배정 확정 — 확정된 미팅들을 저장.
export const postAssignments = async (
  meetings: AssignmentMeeting[],
): Promise<AssignmentActionResult> => {
  const { ok, data } = await post("/api/organizer/assignments", { meetings })
  return ok ? { success: true } : { success: false, error: errorOf(data) }
}

// 전체 포화배정 실행 — 서버가 Draft를 계산해 돌려준다(미발효).
export const postSaturationRun = async (input: {
  settings: ScheduleSettings
  assignMinutes: number
  runNumber: number
  now: { date: string; time: string }
}): Promise<SaturationRunResult> => {
  const { ok, data } = await post("/api/organizer/saturation", input)
  if (!ok) return { success: false, error: errorOf(data) }
  const draft = (data as { draft?: SaturationDraft } | null)?.draft
  if (!draft) return { success: false, error: "invalid_response" }
  return { success: true, draft }
}

// Draft 확정 — 검토 통과분 발효.
export const postSaturationConfirm = async (
  draftAssignments: AssignmentMeeting[],
): Promise<SaturationConfirmResult> => {
  const { ok, data } = await post("/api/organizer/saturation/confirm", { draftAssignments })
  if (!ok) return { success: false, error: errorOf(data) }
  const parsed = data as { confirmedCount?: number; skippedCount?: number } | null
  return { success: true, confirmedCount: parsed?.confirmedCount, skippedCount: parsed?.skippedCount }
}
