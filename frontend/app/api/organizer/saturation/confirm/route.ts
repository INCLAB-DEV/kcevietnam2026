// OP-005 — 포화배정 Draft 확정(POST). 검토를 통과한 draftAssignments를 발효한다.
//
// Phase 5 실연동: 실세션이면 FastAPI POST /api/admin/events/{id}/saturation-runs/{run_id}/confirm
// 으로 프록시한다. run_id는 body의 draftAssignments 각 항목에 실려온 `runId`(POST /saturation
// 응답이 passthrough로 심어둔 필드, saturation/route.ts 주석 참고)에서 꺼낸다 — 확정은 run
// 단위이므로 draftAssignments 배열 전체가 아니라 run_id 하나만 백엔드에 넘긴다.
//
// ⚠ 알려진 갭: 백엔드 confirm은 그 run의 draft 항목을 전부 물질화한다(항목별 부분 확정 API 없음).
// FE 화면이 검토 중 ✕로 개별 항목을 제외(removeDraftMeeting)해도 draftAssignments에서 빠질 뿐
// 백엔드 run에서는 빠지지 않으므로, 실세션에서 "일부만 확정"은 클라 쪽에서 안 막힌다 — 화면이
// 보내는 배열은 검토 결과 그대로 신뢰하되, 실제로는 run 전체가 확정된다는 점을 운영자에게
// 알려야 하면 후속 조치가 필요하다(오케스트레이터 판단 필요 항목으로 보고).
//
// 응답의 confirmed_count/skipped_count/items(부분 성공)를 camelCase로 그대로 실어 돌려준다 —
// assignment-actions.ts postSaturationConfirm이 이를 화면에 표시할 수 있게 매핑한다.
//
// mock 모드(dev 스위처, SESSION_COOKIE 없음)는 기존 동작 100% 보존(항상 confirmedCount=count,
// skippedCount=0 — 부분 실패 개념이 없다).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { AssignmentMeetingSchema } from "@/lib/organizer/assignment-schemas"
import { addAssignments } from "@/lib/organizer/assignment-store"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

const BodySchema = z.object({ draftAssignments: z.array(AssignmentMeetingSchema).min(1) })

interface BackendConfirmItem {
  id: string
  exhibitor_org_id: string
  buyer_org_id: string
  status: "confirmed" | "skipped"
  materialized_meeting_id: string | null
  error_code: string | null
  error_message: string | null
}

interface BackendConfirmOut {
  confirmed_count: number
  skipped_count: number
  items: BackendConfirmItem[]
}

export async function POST(request: Request) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  if (!token) {
    const guard = await resolveRequestGuard()
    if (!guard.authenticated) {
      return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
    }
    const session = await resolveRequestSession()
    if (session.role !== "organizer") {
      return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
    }
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "validation_failed", details: parsed.error.flatten() },
      { status: 422 },
    )
  }

  const meetings = parsed.data.draftAssignments as (AssignmentMeeting & { runId?: string })[]

  if (token) {
    const runId = meetings.find((m) => typeof m.runId === "string")?.runId
    if (!runId) {
      return NextResponse.json({ success: false, error: "missing_run_id" }, { status: 422 })
    }
    const eventResult = await resolveEventId(token)
    if (!eventResult.ok) {
      return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
    }
    const result = await backendJson<BackendConfirmOut>(
      token,
      `/api/admin/events/${encodeURIComponent(eventResult.value)}/saturation-runs/${encodeURIComponent(runId)}/confirm`,
      { method: "POST" },
    )
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    const { confirmed_count, skipped_count, items } = result.value
    return NextResponse.json({
      success: true,
      status: "confirmed",
      count: confirmed_count,
      confirmedCount: confirmed_count,
      skippedCount: skipped_count,
      items: items.map((it) => ({
        id: it.id,
        exhibitorId: it.exhibitor_org_id,
        buyerId: it.buyer_org_id,
        status: it.status,
        materializedMeetingId: it.materialized_meeting_id,
        errorCode: it.error_code,
        errorMessage: it.error_message,
      })),
    })
  }

  const count = addAssignments(meetings)
  return NextResponse.json({
    success: true,
    status: "confirmed",
    count,
    confirmedCount: count,
    skippedCount: 0,
  })
}
