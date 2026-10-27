// OP-002 — 담당자 계정 비밀번호 설정/재설정(PATCH). MembersTable의 "비밀번호 설정" 다이얼로그가
// 부른다. 형제 라우트(status·profile)와 같은 실연동 원칙 — SESSION_COOKIE가 있으면 FastAPI
// PATCH /api/admin/events/{event_id}/organizations/{organization_id}/contact-password로
// 프록시하고(운영자가 배정된 첫 행사 스코프, resolveEventId), 없으면(dev 스위처 mock 세션)
// 인증·권한만 확인하고 성공을 알린다(실 계정 저장소가 없는 목업 모드).
//
// 권한: 이 행사의 운영자(master·sub). sub는 자기 관할 바이어만 — **관할 판정의 권위는 FastAPI**
// (service.check_write_jurisdiction)이고 여기서 재검사하지 않는다(403을 그대로 통과시킨다).
// 운영자 계정(organizers 행과 연결된 회원)은 백엔드가 409 OPERATOR_ACCOUNT로 거부한다.
//
// ⚠ 평문 비밀번호는 요청 본문으로 통과시키기만 한다 — 로그에 찍지 않고, 응답에도 싣지 않는다
// (백엔드 ContactPasswordResult에도 비밀번호·해시가 없다). 정책 검사·해시는 FastAPI
// app.auth.credentials가 단일 정본이라 여기서 규칙을 흉내 내지 않는다(화면 즉시안내는
// lib/auth/password-policy.ts의 사본이 하고, 최종 판정은 서버가 한다).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  password: z.string().min(1),
})

interface ContactPasswordResultSnake {
  organization_id: string
  member_id: string
  contact_email: string
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
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
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    // details에 입력값이 실리지 않도록 코드만 돌려준다(zod flatten은 값을 담지 않지만 명시적으로).
    return NextResponse.json({ success: false, error: "validation_failed" }, { status: 422 })
  }

  const { memberId } = await params

  if (!token) {
    // 목업 모드 — 실 계정이 없어 저장할 곳도 없다. 화면 흐름만 유지한다.
    return NextResponse.json({ success: true, id: memberId, contactEmail: null })
  }

  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }
  const result = await backendJson<ContactPasswordResultSnake>(
    token,
    `/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations/${encodeURIComponent(memberId)}/contact-password`,
    { method: "PATCH", body: { password: parsed.data.password } },
  )
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  }
  return NextResponse.json({
    success: true,
    id: result.value.organization_id,
    contactEmail: result.value.contact_email,
  })
}
