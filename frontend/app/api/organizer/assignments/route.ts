// OP-005 — 배정 확정 저장(POST). 강제 배정(assignForced)·단일 일괄배정 확정(confirmSingleFill)이
// 만든 AssignmentMeeting[]을 영속한다(새로고침 후 유지).
//
// Phase 5 실연동: 실세션(SESSION_COOKIE)이면 두 경로로 프록시한다 —
//   · 강제 배정 단건(assignForced가 보내는 형태 — 정확히 1건, matchingType='forced') →
//     FastAPI POST /api/admin/events/{id}/forced-assignments.
//   · ⚡ 단일기업 AI 재보충(confirmSingleFill이 보내는 형태 — matchingType='ai' 전부) →
//     FastAPI POST /api/admin/events/{id}/retrigger-assignments, 항목마다 반복 호출한다
//     (2026-09-15 QA 지적 B 수정 — 이전엔 이 채널을 받는 백엔드 엔드포인트가 없어 실세션에서도
//     조용히 인메모리 mock store로 폴백했다. "⚡ 확정을 눌렀는데 매칭이 등록 안 되는 것 같다"의
//     실제 원인). 전체 일괄배정(saturation-runs)은 이 라우트를 쓰지 않으므로 matchingType='ai'는
//     전부 재트리거 건이다.
// 둘 다 app/api/admin/[...path]/route.ts와 같은 Bearer 전달 패턴, 시간은 slot_ids로 넘겨
// 백엔드 슬롯 그리드 검증을 그대로 태운다(아래 toSlotIds 주석).
//
// ⚠ 장소(venue_id)는 보내지 않는다(2026-10-01). 예전엔 이 라우트가 GET .../venues의 첫 zone_table을
// 빈 자리 확인 없이 골라 박았다 — 부스 전용 행사에선 404 no_venue(9/30), 장소가 있으면 매번 같은
// 테이블이라 한 시각에 행사 전체 1건만 잡혔다(10/1, 13회 중 6회 VENUE_TAKEN). 장소는 이제 백엔드가
// 참가자 신청과 같은 정책(기본: 참가사 부스)으로 정한다(assignment_service._auto_venue_resolver).
//
// 실패는 백엔드의 code·message(·SLOT_TAKEN이면 busyRoles)를 그대로 내려보낸다 — 화면이 원인별 문구를
// 고른다(lib/organizer/forced-assignment-submit.ts describeAssignmentError).
//
// mock 모드(dev 스위처, SESSION_COOKIE 없음)는 기존 동작 100% 보존.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { AssignmentMeetingSchema } from "@/lib/organizer/assignment-schemas"
import { addAssignments } from "@/lib/organizer/assignment-store"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import { DEFAULT_SCHEDULE_SETTINGS, occupiedSlotIds } from "@/lib/organizer/schedule"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import {
  backendJson,
  resolveEventContext,
  sessionAwareErrorResponse,
  type ProxyFailure,
  type ProxyResult,
} from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

const BodySchema = z.object({ meetings: z.array(AssignmentMeetingSchema).min(1) })

// 미팅 1건 → 백엔드가 검증할 슬롯 묶음(slot_ids). 시작 칸 + 길이만큼의 연속 칸을 그리드 간격으로
// 끊어 보낸다("2026-10-20T10:00" 형식 — FE slotId()와 백엔드 slot_grid.Slot.id가 같은 포맷).
//
// ⚠ scheduled_start/end를 직접 보내지 않는다. 백엔드 ForcedAssignmentIn은 두 방식을 다 받지만
// (둘 중 정확히 하나), explicit 구간은 `end > start`만 보고 **슬롯 그리드와 대조하지 않는다**
// (assignment_service._resolve_window). 그래서 FE가 45분 같은 잘못된 길이를 보내면 그대로
// DB에 저장됐다 — 10:00~10:30 배정이 10:00~10:45로 남던 QA 지적 B1/B2의 실제 경로다.
// slot_ids로 보내면 slot_grid.validate_slot_run이 ① 운영시간·점심·행사기간 소속 ② stride
// (= slot_minutes + gap) 간격의 엄격한 연속성 ③ 스팬이 max_meeting_minutes 이하 ④ 미래 슬롯을
// 전부 검증하고 시간 구간을 직접
// 환산한다 — 길이·타임존 계산이 백엔드 한 곳으로 모이고(참가자 미팅 신청과 같은 검증기),
// 틀린 입력은 저장 대신 422로 튕긴다.
//
// slotMinutes·slotGapMinutes는 행사 설정에서 온다 — 칸을 잇는 간격(stride)이 행사와 다르면
// 연속성 검증에 걸려 422가 되지, 이상한 구간이 저장되지 않는다. gap을 0으로 두고 계산하면
// 40분/텀5분 행사에서 10:00·10:40·11:20 같은 **존재하지 않는** 슬롯키가 만들어져 전부 튕긴다
// (mt003gap0001). 상한은 이제 칸 수가 아니라 분(max_meeting_minutes)인데, 그 검증은 백엔드 몫이다.
function toSlotIds(
  m: AssignmentMeeting,
  slotMinutes: number,
  slotGapMinutes: number,
): string[] {
  return occupiedSlotIds(m.slotId, m.durationMinutes, slotMinutes, slotGapMinutes)
}

async function proxyForcedAssignment(token: string, m: AssignmentMeeting): Promise<ProxyResult<{ id: string }>> {
  // slot_ids를 만들 때 칸 사이 텀(stride)이 필요하므로 설정 왕복을 opt-in으로 켠다(mt003gap0001).
  const eventResult = await resolveEventContext(token, { withSlotGap: true })
  if (!eventResult.ok) return eventResult
  if (m.slotId.indexOf("T") < 0) return { ok: false, status: 422, error: "invalid_slot" }
  const slotIds = toSlotIds(
    m,
    eventResult.value.slotMinutes ?? DEFAULT_SCHEDULE_SETTINGS.slotMinutes,
    eventResult.value.slotGapMinutes ?? DEFAULT_SCHEDULE_SETTINGS.slotGapMinutes,
  )
  return backendJson<{ id: string }>(
    token,
    `/api/admin/events/${encodeURIComponent(eventResult.value.id)}/forced-assignments`,
    {
      method: "POST",
      // venue_id 없음 — 장소는 백엔드가 정한다(파일 상단 주석).
      body: {
        exhibitor_org_id: m.exhibitorId,
        buyer_org_id: m.buyerId,
        slot_ids: slotIds,
      },
    },
  )
}

// ⚡ 재보충 배치 결과 — 실패면 그 앞까지 이미 커밋된 건수(savedCount)를 함께 돌려준다.
type RetriggerResult = { ok: true; value: { ids: string[] } } | (ProxyFailure & { savedCount: number })

// ⚡ 단일기업 AI 재보충(confirmSingleFill) 확정 — 항목마다 독립적으로
// /retrigger-assignments를 호출한다(app.matching.assignment_service.create_retrigger_meeting,
// Channel.AI_RETRIGGER — 받는 쪽 바이어 유형이 진입 상태를 결정, 강제배정처럼 항상 accepted가
// 아니다). 행사 조회는 배치 전체에서 한 번만 한다. 항목 하나가 실패하면(예: 그 사이 다른
// 경로로 그 시각이 찼다) 그 자리에서 멈추고 실패를 그대로 보고한다 — 이미 성공한 앞쪽 항목은
// 백엔드에 이미 커밋돼 있으므로 되돌리지 않는다(각 호출이 독립 트랜잭션이라 애초에 되돌릴 수도
// 없다 — book_meeting 계약). 대신 그 건수를 savedCount로 알려, 화면이 "N건 중 M건만 저장"을
// 말하고 서버 진실로 다시 그리게 한다(전부 실패한 척 롤백만 하면 저장된 건이 화면에서 사라진다).
async function proxyRetriggerAssignments(
  token: string,
  meetings: AssignmentMeeting[],
): Promise<RetriggerResult> {
  // 강제배정과 같은 이유로 텀을 함께 읽는다 — retrigger도 slot_ids로 보낸다(mt003gap0001).
  const eventResult = await resolveEventContext(token, { withSlotGap: true })
  if (!eventResult.ok) return { ...eventResult, savedCount: 0 }
  const slotMinutes = eventResult.value.slotMinutes ?? DEFAULT_SCHEDULE_SETTINGS.slotMinutes
  const slotGapMinutes =
    eventResult.value.slotGapMinutes ?? DEFAULT_SCHEDULE_SETTINGS.slotGapMinutes

  const ids: string[] = []
  for (const m of meetings) {
    if (m.slotId.indexOf("T") < 0) {
      return { ok: false, status: 422, error: "invalid_slot", savedCount: ids.length }
    }
    const result = await backendJson<{ id: string }>(
      token,
      `/api/admin/events/${encodeURIComponent(eventResult.value.id)}/retrigger-assignments`,
      {
        method: "POST",
        // venue_id 없음 — 강제 배정과 같은 백엔드 단일 장소 결정(파일 상단 주석).
        body: {
          exhibitor_org_id: m.exhibitorId,
          buyer_org_id: m.buyerId,
          slot_ids: toSlotIds(m, slotMinutes, slotGapMinutes),
        },
      },
    )
    if (!result.ok) return { ...result, savedCount: ids.length }
    ids.push(result.value.id)
  }
  return { ok: true, value: { ids } }
}

export async function POST(request: Request) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  if (!token) {
    // mock 모드(dev 스위처) — 기존 인메모리 동작 그대로.
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

  const meetings = parsed.data.meetings as AssignmentMeeting[]

  if (token && meetings.length === 1 && meetings[0].matchingType === "forced") {
    const result = await proxyForcedAssignment(token, meetings[0])
    if (!result.ok) {
      return sessionAwareErrorResponse(result)
    }
    return NextResponse.json({ success: true, status: "created", count: 1, ids: [result.value.id] })
  }

  // ⚡ 단일기업 AI 재보충(confirmSingleFill) — 전체 일괄배정(saturation-runs)은 이 라우트를
  // 쓰지 않으므로 matchingType='ai'는 전부 이 채널이다.
  if (token && meetings.length > 0 && meetings.every((m) => m.matchingType === "ai")) {
    const result = await proxyRetriggerAssignments(token, meetings)
    if (!result.ok) {
      return sessionAwareErrorResponse(result, { savedCount: result.savedCount })
    }
    return NextResponse.json({
      success: true,
      status: "created",
      count: result.value.ids.length,
      ids: result.value.ids,
    })
  }

  const count = addAssignments(meetings)
  return NextResponse.json({
    success: true,
    status: "created",
    count,
    ids: meetings.map((m) => m.id),
  })
}
