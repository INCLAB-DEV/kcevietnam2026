// OP-002 — 신청서 편집 패널의 "미팅 불가 시간" 저장(PATCH). profile/route.ts(형제 라우트)와 같은
// 실연동 원칙: 로그인 BFF가 심은 SESSION_COOKIE를 서버에서 Bearer로 바꿔 FastAPI
// PATCH /api/admin/events/{event_id}/organizations/{org_id}/unavailable-slots 로 보낸다.
//
// 미팅 불가 시간은 프로필 PATCH가 받지 않는 운영자 전용 칸이라(backend ExhibitorStep4 docstring —
// 넣으면 422) 엔드포인트가 따로다. 본문은 { slots } 전체 치환이고, 백엔드가 master 전용으로 막는다
// (require_event_master — sub는 403. 여기서 재검사하지 않고 그대로 통과시킨다).
//
// 성공 응답에는 백엔드가 돌려준 저장된 참가사 프로필을 싣는다(profile) — 패널이 그 값으로 다시 그린다.
// 관리자 콘솔은 catch-all BFF(app/api/admin/[...path])로 같은 백엔드 엔드포인트를 직접 부른다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

// 슬롯 id = "YYYY-MM-DDTHH:MM"(격자 칸 하나, lib/operator/slot-grid). 형식이 다른 문자열을 백엔드로 넘기지
// 않는다 — 전체 치환이라 잘못된 본문이 그대로 저장된다.
// 칸 수 상한은 두지 않는다: 격자 크기는 행사 설정(기간 × 운영시간 ÷ 슬롯 간격)이 정하고 백엔드에 기간 상한이
// 없어, 고정 상한은 슬롯이 짧고 기간이 긴 행사의 정상 저장을 막는다(예: 10분 슬롯 × 9시간 × 10일 = 540칸 —
// 전체 치환이라 한 칸만 풀어도 목록 전체가 다시 실린다).
const SLOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

const BodySchema = z.object({
  slots: z.array(z.string().regex(SLOT_ID)),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const { memberId } = await params

  if (!token) {
    // mock 모드(dev 스위처) — 저장할 실 저장소가 없다. 성공한 척하지 않는다: 목업 화면은 클라의 인메모리
    // 전송을 쓰므로 이 경로를 부르지 않고, 불렸다면 저장되지 않았다고 정직하게 답한다.
    const guard = await resolveRequestGuard()
    if (!guard.authenticated) {
      return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
    }
    const session = await resolveRequestSession()
    if (session.role !== "organizer") {
      return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
    }
    return NextResponse.json({ success: false, error: "mock_session" }, { status: 404 })
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

  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }

  const path = `/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations/${encodeURIComponent(memberId)}/unavailable-slots`
  const result = await backendJson(token, path, { method: "PATCH", body: { slots: parsed.data.slots } })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  }
  return NextResponse.json({ success: true, id: memberId, profile: result.value })
}
