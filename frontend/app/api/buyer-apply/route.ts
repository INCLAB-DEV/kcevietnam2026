// WL-001 — 바이어 신청서 최종 제출(POST). backend POST /buyer/{id}/submit 계약의 Next.js 측 관문
// (최종 draft 병합 + application_status 전환을 한 번에 — 원자). 실 로그인 세션이면 백엔드로 그대로
// 프록시하고, mock/dev 세션이면 기존 서버 메모리 store로 판정한다(BM-001 실배선). /welcome의
// ApplicationActions는 role/isReal 무관하게 이 라우트 하나를 통해 제출을 호출하므로(buyer 분기는
// 아직 isReal로 갈라지지 않는다), 실세션 지원은 여기서 닫아야 실 바이어의 "제출"이 실 DB에 반영된다.
//
// 권한·상태 가드는 서버 한 곳(ADR-0012 미러): 인증 바이어 + registered|changes_requested만 제출
// 가능(mock 분기). profileKey는 세션(orgId)에서 도출한다. 실세션 분기는 org_event_role_id를
// fetchMe()에서 도출한다(클라가 지정 못함).
//
// draft 저장(부분, 빈 값 허용)과 달리 제출은 검증 게이트다 — mock 분기는 1~2단계 필수 전부
// 충족해야 한다(form-state isSubmittable 미러). 실세션 분기는 백엔드(app.bm.service._validate_submit
// — 신청자 영문 이름·이메일 등)가 검증을 최종 소유하고, 이 라우트는 422/409 응답을 그대로 통과시킨다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import {
  INPUT_STEPS,
  STEP_FIELDS,
  validateStep,
} from "@/lib/apply/form-state"
import {
  loadProfile,
  submitProfile,
  SubmitBlockedError,
} from "@/lib/apply/buyer-profile-store"
import { toApiBody } from "@/lib/bm/http-buyer-client"
import type { BuyerProfileDraft } from "@/lib/apply/types"

export const dynamic = "force-dynamic"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// 입력 단계(1~2) 소유 필드만 병합 — 미지의 키는 버린다(부분저장 라우트와 동일 정책, mock/실세션 공유).
function ownedFieldsPatch(incoming: Record<string, unknown>): Partial<BuyerProfileDraft> {
  const patch: Partial<BuyerProfileDraft> = {}
  for (const step of INPUT_STEPS) {
    for (const key of STEP_FIELDS[step]) {
      if (key in incoming) (patch as Record<string, unknown>)[key] = incoming[key]
    }
  }
  return patch
}

async function readDraftBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as { draft?: unknown }
    if (body.draft != null && typeof body.draft === "object" && !Array.isArray(body.draft)) {
      return body.draft as Record<string, unknown>
    }
  } catch {
    // body 없는 제출도 허용 — 실세션은 백엔드에 저장된 값, mock은 서버 store 기준.
  }
  return {}
}

// 실 세션 — org_event_role_id를 fetchMe()에서 도출해 백엔드로 그대로 프록시(app/api/bm/[[...path]]/
// route.ts와 동일 인증 붙이기 방식: httpOnly 세션 쿠키 → Authorization: Bearer). 제출 완결성
// 검증(신청자 영문 이름·이메일 등)은 백엔드(_validate_submit)가 소유 — 여기서는 재검증하지 않는다.
async function proxyRealSession(request: Request): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
  }
  const me = await fetchMe()
  const buyerRole = me?.roles.find((r) => r.is_buyer) ?? null
  if (!buyerRole) {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
  }

  const incoming = await readDraftBody(request)
  const patch = ownedFieldsPatch(incoming)
  const hasPatch = Object.keys(patch).length > 0

  const upstream = await fetch(`${BACKEND_URL}/api/bm/buyer/${buyerRole.org_event_role_id}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: hasPatch ? JSON.stringify(toApiBody(patch)) : undefined,
  })
  if (!upstream.ok) {
    const error =
      upstream.status === 422 ? "validation_failed" : upstream.status === 409 ? "submit_blocked" : `http_${upstream.status}`
    return NextResponse.json({ success: false, error }, { status: upstream.status })
  }
  const data = (await upstream.json()) as { application_status?: string }
  return NextResponse.json({ success: true, applicationStatus: data.application_status })
}

export async function POST(request: Request) {
  const realSession = await resolveHttpSession()
  if (realSession) {
    if (realSession.role !== "buyer") {
      return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
    }
    return proxyRealSession(request)
  }

  // mock/dev — 기존 서버 메모리 store(그대로 보존).
  const guard = await resolveRequestGuard()
  if (!guard.authenticated) {
    return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
  }

  const session = await resolveRequestSession()
  if (session.role !== "buyer") {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
  }
  if (
    session.applicationStatus !== "registered" &&
    session.applicationStatus !== "changes_requested"
  ) {
    return NextResponse.json(
      { success: false, error: "submit_blocked", details: { status: session.applicationStatus } },
      { status: 409 },
    )
  }

  const incoming = await readDraftBody(request)
  const patch = ownedFieldsPatch(incoming)

  // 제출 게이트 — 1~2단계 필수 전부 충족(isSubmittable 미러). 미충족 필드를 details로 돌려준다.
  const merged: BuyerProfileDraft = { ...loadProfile(session.orgId).draft, ...patch }
  const missing = INPUT_STEPS.flatMap((step) => validateStep(step, merged).missing)
  if (missing.length > 0) {
    return NextResponse.json(
      { success: false, error: "validation_failed", details: { missing } },
      { status: 422 },
    )
  }

  try {
    const stored = submitProfile(session.orgId, patch)
    return NextResponse.json({ success: true, applicationStatus: stored.status })
  } catch (e) {
    if (e instanceof SubmitBlockedError) {
      return NextResponse.json(
        { success: false, error: "submit_blocked", details: { status: e.status } },
        { status: 409 },
      )
    }
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 })
  }
}
