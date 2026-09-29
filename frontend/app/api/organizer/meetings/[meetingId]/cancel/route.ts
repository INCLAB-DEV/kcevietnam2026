// 운영자 전용 미팅 취소 프록시(QA 3차 #1) — 참가자용 /api/meetings/{id}/cancel은 미팅 당사자
// (exhibitor/buyer org)만 통과해 운영자(슈퍼관리자)가 배정 화면에서 취소하면 403이 났다. 이
// 라우트는 실세션(SESSION_COOKIE)이면 FastAPI admin 라우터(POST /api/admin/events/{event_id}/
// meetings/{meeting_id}/cancel — require_event_master, 취소 후 양쪽 org에 meeting_cancelled 알림,
// backend/app/admin/router.py cancel_meeting)로 프록시한다. event_id 해석은 다른 organizer BFF와
// 동일(resolveEventContext, lib/organizer/backend-proxy.ts — 그 운영자가 배정된 첫 행사).
//
// mock 모드(dev 스위처, SESSION_COOKIE 없음)는 배정 그리드의 미팅이 로컬 state일 뿐 서버측 영속
// 저장소가 없다(assignment-store는 "추가"만 다룬다) — 가드만 통과시키고 성공을 반환해, 호출부의
// 낙관적 갱신으로 취소를 반영한다(members/[memberId]/status 라우트와 같은 mock 폴백 원칙).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventContext } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

// backend MeetingCancelIn과 동일 계약 — 둘 다 선택(extra=forbid, 참가자 취소와 달리 어휘 강제 없음).
const BodySchema = z.object({
  reason_code: z.string().optional(),
  reason_text: z.string().max(2000).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
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
    if (session.permissionLevel !== "master") {
      return NextResponse.json({ success: false, error: "forbidden_sub" }, { status: 403 })
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

  const { meetingId } = await params

  if (!token) {
    return NextResponse.json({ success: true, id: meetingId, status: "cancelled" })
  }

  const eventResult = await resolveEventContext(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }

  const result = await backendJson<{ id: string; status: string }>(
    token,
    `/api/admin/events/${encodeURIComponent(eventResult.value.id)}/meetings/${encodeURIComponent(meetingId)}/cancel`,
    { method: "POST", body: parsed.data },
  )
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  }
  return NextResponse.json({ success: true, id: result.value.id, status: result.value.status })
}
