// OP-002 — "정보 수정" 다이얼로그(MembersTable.editMember)의 서버 영속(PATCH). status/route.ts·
// [memberId]/route.ts(형제 라우트)와 동일한 실연동 원칙.
//
// ⚠ 배경(H1, 2026-09-12): editMember()가 인메모리 state만 바꾸고 네트워크 요청 자체를 내지 않아
// 새로고침하면 소실되던 버그. 같은 기능이 /admin/organizations의 신청서 편집 다이얼로그
// (profile-editor.tsx)에서는 이미 정상 저장되는데, 그 경로는 백엔드 PATCH .../profile(직접 수정)
// / POST .../proxy-profile(대리작성)을 그대로 쓴다 — 새 API를 만들지 않고 같은 계약을 재사용한다.
//
// mode 선택(edit vs proxy)은 admin ProfileEditor와 동일 규칙: application_status가 "registered"
// (미신청)면 대리작성(proxy-profile, master는 승인/sub는 제출), 아니면 직접 수정(profile, 이미 제출한
// 신청서 정정) — 클라(members-table.tsx)가 row.applicationStatus로 이미 계산해 보낸다.
//
// body 필드는 lib/organizer/member-profile-patch.ts(toOrganizerProfilePatch)가 만든 patch 그대로
// 통과시킨다 — enum-guard가 없는 안전한 필드만 걸러 보내는 책임은 그쪽에 있다(여기선 재검증하지
// 않는다, PATCH profile류 라우트 공통 원칙 — FastAPI extra="forbid"가 최종 방어선).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  role: z.enum(["exhibitor", "buyer"]),
  mode: z.enum(["edit", "proxy"]),
  patch: z.record(z.string(), z.unknown()),
})

export async function PATCH(
  request: Request,
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
    return NextResponse.json({ success: true, id: memberId })
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

  const { role, mode, patch } = parsed.data
  const suffix = mode === "proxy" ? "proxy-profile" : "profile"
  const method = mode === "proxy" ? "POST" : "PATCH"
  const path = `/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations/${encodeURIComponent(memberId)}/${suffix}?role=${role}`

  const result = await backendJson(token, path, { method, body: patch })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  }
  return NextResponse.json({ success: true, id: memberId })
}
