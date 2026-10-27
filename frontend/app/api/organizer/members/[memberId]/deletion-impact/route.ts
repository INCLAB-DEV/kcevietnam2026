// OP-002 — 참가기업 삭제 영향 미리보기(GET). MembersTable의 "참가자 삭제" 확인 다이얼로그가 열릴 때
// 부른다. 형제 라우트([memberId]/route.ts DELETE·profile·status)와 같은 실연동 원칙 — SESSION_COOKIE가
// 있으면 FastAPI GET /api/admin/events/{event_id}/organizations/{organization_id}/deletion-impact로
// 프록시한다. 행사는 DELETE와 **같은 규칙**(lib/organizer/backend-proxy.ts resolveEventId — 선택된 행사)으로
// 고른다 — 미리보기가 본 행사와 삭제가 착지하는 행사가 갈리면 안 된다.
//
// 돌려주는 것: 삭제 가능 여부, 막는 미팅의 상태별 건수(예정·완료), 삭제하면 함께 지워지는 것의 건수.
// 판정은 백엔드가 한다(실제 삭제와 같은 함수) — 여기서는 모양만 화면용(camelCase)으로 옮긴다.
// 백엔드 응답의 모양이 어긋나면 502로 답한다: 빠진 칸을 0으로 채워 "함께 지워지는 것 없음"처럼
// 보이게 하지 않는다(화면은 읽지 못했다고 알리고 삭제 버튼을 막는다).
//
// "기업 없음"은 구조화된 코드로만 판정한다: 백엔드가 detail.code "ORG_NOT_FOUND"로 답한 404만 ORG_NOT_FOUND로
// 옮긴다(deletionErrorCode). 화면은 그것을 일반 실패와 구분해 "이 행사 명단에서 찾을 수 없는 기업"으로 안내하고
// 명단을 다시 읽는다. 평문 404(라우팅·배포가 어긋난 "Not Found" 등)는 일반 실패 http_404다(다시 확인 가능).
//
// 권한은 삭제와 같다 — master 전용(FastAPI require_event_master가 최종 권위, 403을 그대로 통과).
// mock 모드(dev 스위처)에는 읽어 올 실 저장소가 없다: 권한만 확인하고 "그냥 삭제"(함께 지워질 서버
// 데이터 없음)로 답한다 — 목업의 삭제도 서버에서는 아무것도 지우지 않는다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"
import {
  MOCK_DELETION_IMPACT,
  deletionErrorCode,
  toMemberDeletionImpact,
} from "@/lib/organizer/member-deletion"

export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const { memberId } = await params

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
    return NextResponse.json({ success: true, id: memberId, impact: MOCK_DELETION_IMPACT })
  }

  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }
  const result = await backendJson<unknown>(
    token,
    `/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations/${encodeURIComponent(memberId)}/deletion-impact`,
  )
  if (!result.ok) {
    const error = deletionErrorCode(result.status, result.code, result.error)
    return NextResponse.json({ success: false, error }, { status: result.status })
  }
  const impact = toMemberDeletionImpact(result.value)
  if (!impact) {
    return NextResponse.json({ success: false, error: "invalid_upstream" }, { status: 502 })
  }
  return NextResponse.json({ success: true, id: memberId, impact })
}
