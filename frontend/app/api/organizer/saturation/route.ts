// OP-005 — 전체 포화배정 실행(POST): Draft를 만들어 미리보기를 돌려준다(미발효).
//
// Phase 5 실연동: 실세션이면 FastAPI POST /api/admin/events/{id}/saturation-runs로 프록시한다.
// ⚠ 백엔드는 이 호출에 body를 받지 않는다 — settings/assignMinutes 같은 실행 파라미터 없이
// 서버가 자체 규칙(미팅 0건 참가사↔바이어 naive 매칭)으로 즉시 계산해 run+items를 돌려준다
// (app/matching/assignment_service.py create_saturation_run). 클라가 보낸 settings/assignMinutes/
// runNumber는 실세션에서는 계산에 쓰이지 않는다 — settings는 응답 echo(그리드 표시용)로만 쓰고,
// runNumber는 백엔드의 run_number(권위)로 덮어쓴다.
//
// run_id는 FE 타입(AssignmentMeeting)에 없는 필드라 각 draft meeting에 `runId`로 passthrough
// 시켜 돌려준다(assignment-schemas.ts의 AssignmentMeetingSchema가 .passthrough()라 이후
// saturation/confirm 라우트까지 그대로 실려간다) — Draft 상태를 FE가 들고 있다가 확정 시
// run 단위 확정 엔드포인트를 부르기 위한 유일한 연결고리.
//
// buyer 수락상태(proposed/accepted) 미리보기는 best-effort다 — 이 라우트가 아는 기업 로스터는
// 여전히 mock 픽스처뿐이라(실 행사 로스터 연동은 이 Phase 밖) 백엔드가 돌려준 실 org id가
// 픽스처에 없으면 "proposed"로 기본 처리한다(확정 후 실제 상태는 백엔드가 정확히 결정 — 여기는
// 검토 화면의 색상 미리보기일 뿐).
//
// mock 모드(dev 스위처, SESSION_COOKIE 없음)는 기존 서버 계산 동작 100% 보존.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { NowSchema, ScheduleSettingsSchema } from "@/lib/organizer/assignment-schemas"
import { fitFromRecs, unavailableSets } from "@/lib/organizer/assignment-schedule"
import { generateSaturationDraft, type DraftMeeting, type SaturationInput } from "@/lib/organizer/saturation"
import { buildSlotUniverse, slotId } from "@/lib/organizer/schedule"
import { expandOccupancy, mergeConsecutive } from "@/lib/organizer/slot-intersection"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventContext, sessionAwareErrorResponse } from "@/lib/organizer/backend-proxy"
import { zonedParts } from "@/lib/timezone"

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  settings: ScheduleSettingsSchema,
  assignMinutes: z.number().int().positive(),
  runNumber: z.number().int().positive(),
  now: NowSchema,
})

interface BackendSaturationItem {
  id: string
  exhibitor_org_id: string
  buyer_org_id: string
  venue_id: string | null
  scheduled_start: string
  scheduled_end: string
  status: "draft" | "confirmed" | "skipped"
  materialized_meeting_id: string | null
  seq_no: number | null
}

interface BackendSaturationRun {
  id: string
  event_id: string
  run_number: number
  min_guaranteed_slots: number
  status: "draft" | "confirmed" | "discarded"
  created_at: string
  confirmed_at: string | null
  items: BackendSaturationItem[]
}

type BackendDraftMeeting = DraftMeeting & { runId: string }

// 백엔드 scheduled_start(타임존 포함 ISO) → 그리드 셀 키("YYYY-MM-DDTHH:MM", 행사 로컬 벽시계).
// schedule.ts의 slotId() 규칙과 정합해야 그리드 셀 매칭(meetingAt)이 맞아떨어진다. ⚠ Asia/Seoul
// 고정은 쓰지 않는다 — 행사 timeZone(resolveEventContext)을 반드시 인자로 받는다(H5/P0-2).
function toSlotId(iso: string, timeZone: string): string {
  const { date, time } = zonedParts(iso, timeZone)
  return slotId(date, time)
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)
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
  const { settings, assignMinutes, runNumber, now } = parsed.data

  if (token) {
    const eventResult = await resolveEventContext(token)
    if (!eventResult.ok) {
      return sessionAwareErrorResponse(eventResult)
    }
    const runResult = await backendJson<BackendSaturationRun>(
      token,
      `/api/admin/events/${encodeURIComponent(eventResult.value.id)}/saturation-runs`,
      { method: "POST" },
    )
    if (!runResult.ok) {
      return sessionAwareErrorResponse(runResult)
    }
    const run = runResult.value
    const timeZone = eventResult.value.timezone
    const meetings: BackendDraftMeeting[] = run.items.map((item) => {
      return {
        id: item.id,
        exhibitorId: item.exhibitor_org_id,
        buyerId: item.buyer_org_id,
        slotId: toSlotId(item.scheduled_start, timeZone),
        // 전체 일괄배정(AI_SATURATION)은 운영자 개입 채널이라 확정으로 물질화된다 — 받는 쪽
        // 바이어 유형을 보지 않는다(backend acceptance_rule._OPERATOR_OVERRIDE_CHANNELS,
        // 2026-09-15 정정). 예전엔 여기서 바이어 유형으로 "수락대기"를 그려 확정 후 상태가 뒤집혔다.
        status: "accepted",
        matchingType: "ai",
        durationMinutes: minutesBetween(item.scheduled_start, item.scheduled_end),
        runId: run.id,
      }
    })
    return NextResponse.json({
      success: true,
      draft: { runNumber: run.run_number, settings, meetings },
      count: meetings.length,
    })
  }

  // mock 모드 — 입력 재구성은 assignment-hub buildInput()과 동일 파이프라인(서버 진실 기준).
  const data = await serverApiClient.getAssignmentSchedule()
  const nowKey = `${now.date} ${now.time}`
  const allSlotIds = buildSlotUniverse(
    data.dates.map((d) => d.id),
    settings,
  )
    .filter((s) => `${s.dateId} ${s.time}` >= nowKey)
    .map((s) => s.id)
  const merged = mergeConsecutive(data.meetings, settings.slotMinutes, settings.slotGapMinutes)
  const input: SaturationInput = {
    exhibitors: data.exhibitors,
    buyers: data.buyers,
    fit: fitFromRecs(data.recsByOrgId),
    applicationOrder: data.applicationOrder,
    allSlotIds,
    existing: expandOccupancy(merged, settings.slotMinutes, settings.slotGapMinutes),
    unavailable: unavailableSets(data.unavailableByOrgId),
    assignMinutes,
  }

  const draft = generateSaturationDraft(input, settings, runNumber)
  return NextResponse.json({
    success: true,
    draft,
    count: draft.meetings.length,
  })
}
