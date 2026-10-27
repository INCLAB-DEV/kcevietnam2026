// OP-002 — 참가기업 삭제(DELETE). MembersTable의 "참가자 삭제" 확인 다이얼로그가 부른다.
// status/route.ts(형제 라우트, PATCH)와 동일한 실연동 원칙 — SESSION_COOKIE가 있으면 FastAPI
// DELETE /api/admin/events/{event_id}/organizations/{organization_id}로 프록시하고(선택된 행사
// 스코프, resolveEventId), 없으면(dev 스위처 mock 세션) 인증·권한만 확인하고 성공을 알린다 —
// 목업 모드에는 지울 실 저장소가 없다(화면의 인메모리 명단이 원래 소스다).
//
// memberId ↔ organization_id는 status/route.ts와 동일 규약(그대로 전달).
//
// 삭제는 되돌릴 수 없는 쓰기라 master 전용(ADR-0012) — FastAPI require_event_master가 최종 권위,
// mock 모드는 이 라우트가 직접 session.permissionLevel을 검사한다(status/route.ts와 동일).
//
// 백엔드가 거부하면 상태·코드를 그대로 올리고 **이유도 함께** 싣는다(화면은 서버가 확인한 뒤에만
// 행을 지우므로, 거부되면 행은 그대로 남고 이 이유를 안내한다):
//   · 409 ORG_HAS_MEETINGS    — 예정(수락 대기·확정)이나 완료 미팅이 있다. scheduledCount·completedCount로
//                               몇 건이 막는지 알린다(취소·거절된 미팅만 있으면 백엔드가 그 미팅과 함께 지운다).
//   · 409 ORG_DELETE_CONFLICT — 판정을 통과한 뒤 DB가 막았다(남은 참조·잠금 충돌). 아무것도 지워지지 않았다.
//   · 404 ORG_NOT_FOUND       — 이 행사 명단에 그 기업이 없다. 백엔드가 구조화된 detail.code로 그렇게 말한
//                               404만이다. 화면은 행을 숨기지 않고 명단을 다시 읽는다(다른 운영자가 먼저
//                               지웠는지, 다른 탭에서 행사가 바뀌었는지 404만으로는 모른다).
//   · 그 밖의 404(평문 detail — 라우팅·배포가 어긋난 "Not Found" 등) — 일반 실패 http_404(문장은 message).
//     화면은 다른 실패처럼 창을 두고 다시 시도하게 한다. (행사 해석 실패는 no_event로 따로 온다.)
// 지우기 전에 무엇이 막는지·무엇이 함께 지워지는지는 형제 라우트 deletion-impact(GET)가 읽어 준다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { BACKEND_URL, resolveEventId } from "@/lib/organizer/backend-proxy"
import { deletionErrorCode } from "@/lib/organizer/member-deletion"

export const dynamic = "force-dynamic"

type DeleteErrorDetail = {
  code?: string
  message?: string
  scheduled_count?: unknown
  completed_count?: unknown
}

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
      | { detail?: DeleteErrorDetail | string }
      | null
    const detail = errorBody?.detail
    if (typeof detail === "string" || !detail) {
      const fallback = typeof detail === "string" ? detail : `http_${upstream.status}`
      // 코드가 없는 실패 — "기업 없음"이 될 수 없다(404면 http_404, 문장은 message로만 싣는다).
      const error = deletionErrorCode(upstream.status, undefined, fallback)
      const body: { success: false; error: string; message?: string } = { success: false, error }
      if (error !== fallback && typeof detail === "string" && detail) body.message = detail
      return NextResponse.json(body, { status: upstream.status })
    }
    const code = typeof detail.code === "string" ? detail.code : undefined
    const body: {
      success: false
      error: string
      message?: string
      scheduledCount?: number
      completedCount?: number
    } = {
      success: false,
      // ORG_NOT_FOUND는 백엔드가 구조화된 코드로 그렇게 말한 404에만 붙는다(deletionErrorCode).
      error: deletionErrorCode(upstream.status, code, code ?? `http_${upstream.status}`),
    }
    if (typeof detail.message === "string" && detail.message) body.message = detail.message
    if (typeof detail.scheduled_count === "number") body.scheduledCount = detail.scheduled_count
    if (typeof detail.completed_count === "number") body.completedCount = detail.completed_count
    return NextResponse.json(body, { status: upstream.status })
  }
  return NextResponse.json({ success: true, id: memberId })
}
