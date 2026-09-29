// OP-003 — 참가기업 신청 상태 변경(PATCH). 승인 심사 모달(OP-002 MembersTable)의 승인/반려/
// 수정요청 결정을 서버에 영속한다. REFACTORING.md Phase 2 계약(PATCH /api/organizer/members/
// {id}/status).
//
// 실연동: 로그인 BFF가 심은 SESSION_COOKIE가 있으면 FastAPI 신규 엔드포인트로 프록시한다
// (app/api/admin/[...path]/route.ts와 같은 Bearer 전달 패턴 — 클라 JS는 토큰을 만지지 않는다).
// 없으면(dev 스위처 mock 세션) 기존 인메모리 store로 폴백 — 참가사/홈 배선과 동일한
// "실세션이면 proxy, 아니면 mock" 원칙이다. organizer 로그인은 참가자(buyer/exhibitor)용
// resolveHttpSession(lib/auth/http-session.ts)의 대상이 아니다(그 함수는 ROLE_COOKIE가
// buyer/exhibitor일 때만 실세션으로 본다, extractRole 주석 참고) — organizer는 애초에
// ROLE_COOKIE를 쓰지 않고 SESSION_COOKIE 존재 여부만으로 실세션을 판정한다(app/api/admin/
// [...path]/route.ts와 동일한 판정 방식, 그 프록시가 이미 이 방식으로 운영자 실연동을 돌리고 있다).
//
// memberId ↔ organization_id: 이 라우트의 memberId는 FastAPI 쪽 organization_id와 동일 값으로
// 그대로 전달한다(FE/BE 식별자 규약 — serverApiClient.getMember(orgId)도 같은 값을 org id로
// 다룬다). 백엔드 review 엔드포인트는 (event_id, organization_id)로 organization_event_roles
// 행을 찾으므로, event_id는 이 라우트가 GET /api/admin/events(그 운영자가 배정된 행사 목록)의
// 첫 번째 행사로 보완한다 — 이 구(舊) 운영자 콘솔(app/organizer/members)은 아직 행사 선택 UI가
// 없는 단일 행사 전제이고, 새 콘솔(app/admin, lib/admin/events.ts resolveSelectedEvent)의
// "쿠키 없으면 첫 행사" 폴백과 같은 원칙이다.
//
// 권한: 운영자 master 전용(ADR-0012 / op-003 spec §6.1 — sub 무역관은 상태 변경 불가). mock
// 모드는 이 라우트가 직접 session.permissionLevel을 검사하지만, 실세션 모드는 FastAPI
// require_event_master가 최종 권위다(app/api/admin proxy와 동일 원칙 — 여기서 재검사하지 않고
// 401/403을 그대로 통과시킨다).
// 허용 상태: 운영 결정 3종(approved·rejected·changes_requested)만 — registered/submitted 전이는
// 참가측 플로우(제출)의 소관이라 이 라우트로 못 바꾼다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { setStatusOverride } from "@/lib/organizer/member-status-store"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

export const dynamic = "force-dynamic"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

const BodySchema = z.object({
  status: z.enum(["approved", "rejected", "changes_requested"]),
  note: z.string().max(500).optional(),
})

type ReviewDecision = z.infer<typeof BodySchema>

type ProxyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string }

// 실세션 프록시 — 운영자가 배정된 첫 행사를 찾은 뒤 그 행사 스코프로 검토 엔드포인트를 때린다.
async function proxyReview(
  token: string,
  organizationId: string,
  decision: ReviewDecision,
): Promise<ProxyResult> {
  const eventsRes = await fetch(`${BACKEND_URL}/api/admin/events`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!eventsRes.ok) {
    return { ok: false, status: eventsRes.status, error: `event_lookup_failed_${eventsRes.status}` }
  }
  const eventsBody = (await eventsRes.json().catch(() => null)) as { items?: { id: string }[] } | null
  const eventId = eventsBody?.items?.[0]?.id
  if (!eventId) {
    return { ok: false, status: 404, error: "no_event" }
  }

  const target = `${BACKEND_URL}/api/admin/events/${encodeURIComponent(eventId)}/organizations/${encodeURIComponent(organizationId)}/review`
  const upstream = await fetch(target, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(decision),
  })
  if (!upstream.ok) {
    const errorBody = (await upstream.json().catch(() => null)) as { detail?: unknown } | null
    const detail = typeof errorBody?.detail === "string" ? errorBody.detail : `http_${upstream.status}`
    return { ok: false, status: upstream.status, error: detail }
  }
  return { ok: true, body: await upstream.json() }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
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

  const { memberId } = await params

  if (token) {
    const result = await proxyReview(token, memberId, parsed.data)
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json({ success: true, id: memberId, status: parsed.data.status })
  }

  const member = await serverApiClient.getMember(memberId)
  if (!member) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 })
  }

  setStatusOverride(memberId, parsed.data.status)
  return NextResponse.json({ success: true, id: memberId, status: parsed.data.status })
}
