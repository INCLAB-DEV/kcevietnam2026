// OP-002 — 참가기업 삭제(DELETE). MembersTable의 "삭제" 확인 다이얼로그(confirmDelete)가 부른다.
// status/route.ts(형제 라우트, PATCH)와 동일한 실연동 원칙 — SESSION_COOKIE가 있으면 FastAPI
// DELETE /api/admin/events/{event_id}/organizations/{organization_id}로 프록시하고(운영자가
// 배정된 첫 행사 스코프, resolveEventId), 없으면(dev 스위처 mock 세션) 인증·권한만 확인하고 성공을
// 알린다 — 실 삭제 대상 저장소가 없는 목업 모드는 클라 인메모리(removedIds)가 이미 원래 소스다.
//
// memberId ↔ organization_id는 status/route.ts와 동일 규약(그대로 전달).
//
// 삭제는 되돌릴 수 없는 쓰기라 master 전용(ADR-0012) — FastAPI require_event_master가 최종 권위,
// mock 모드는 이 라우트가 직접 session.permissionLevel을 검사한다(status/route.ts와 동일).
//
// 백엔드 409(ORG_HAS_MEETINGS)는 이 기업이 이 행사에서 미팅을 갖고 있다는 뜻 — 그대로 통과시켜
// 클라가 이유 있는 실패 토스트를 띄우게 한다(revert는 하지 않는다 — decide()/patchMemberStatus와
// 동일하게 화면은 낙관적으로 이미 바뀐 뒤라, 실패는 토스트로만 알린다).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { BACKEND_URL, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const { memberId } = await params

  if (!token) {
    // mock 모드(dev 스위처) — 실 저장소가 없다. 권한만 확인하고 성공을 알린다(클라 인메모리가 정본).
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
    return NextResponse.json({ success: true, id: memberId })
  }

  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }

  const target = `${BACKEND_URL}/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations/${encodeURIComponent(memberId)}`
  const upstream = await fetch(target, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  })
  if (!upstream.ok) {
    const errorBody = (await upstream.json().catch(() => null)) as
      | { detail?: { code?: string; message?: string } | string }
      | null
    const detail = errorBody?.detail
    const error = typeof detail === "string" ? detail : (detail?.code ?? `http_${upstream.status}`)
    return NextResponse.json({ success: false, error }, { status: upstream.status })
  }
  return NextResponse.json({ success: true, id: memberId })
}
