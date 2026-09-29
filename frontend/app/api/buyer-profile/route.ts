// BM-001 — 바이어 프로필 draft 단계별 부분저장(POST). backend PATCH /buyer/{id}/steps/{step}
// 계약의 Next.js 측 관문. 실 로그인 세션이면 백엔드(FastAPI)로 그대로 프록시하고, mock/dev
// 세션이면 기존 서버 메모리 store를 쓴다(BM-001 실배선 — apply-form.tsx의 실 세션 분기는 이제
// getBuyerClient(true)로 이 라우트를 거치지 않고 BFF(app/api/bm/[[...path]]/route.ts)를 직접
// 부르지만, 이 라우트는 saveStepToServer(form-actions.ts)의 계약대로 실세션도 일관되게 지원한다).
//
// 권한검사는 서버 한 곳(ADR-0008/ADR-0012 미러): 인증 바이어 + 수정 가능 상태(registered|
// changes_requested)만 저장할 수 있다(mock 분기). profileKey는 body가 아니라 세션(orgId)에서
// 도출한다 — 클라가 다른 프로필 키를 지정하지 못하게. 실세션 분기는 org_event_role_id를
// fetchMe()에서 도출한다(마찬가지로 클라가 지정하지 못함).
//
// 부분저장은 빈 값도 허용한다(#26 정합, form-state 주석 — "막는" 건 제출 게이트뿐). 따라서 필수
// 필드 미충족은 422가 아니다: [이전]/[저장하고 나가기]가 미완성 단계도 저장하기 때문. 여기서는
// 요청 형태(step 범위·draft 타입)만 검증하고, 단계 소유 필드만 골라 병합한다(STEP_FIELDS 미러).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { INPUT_STEPS, STEP_FIELDS, type StepNumber } from "@/lib/apply/form-state"
import { saveStep } from "@/lib/apply/buyer-profile-store"
import { toApiBody } from "@/lib/bm/http-buyer-client"
import type { BuyerProfileDraft } from "@/lib/apply/types"

export const dynamic = "force-dynamic"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

function parseStepPatch(
  body: { step?: unknown; draft?: unknown },
): { step: StepNumber; patch: Partial<BuyerProfileDraft> } | NextResponse {
  const step = body.step
  if (typeof step !== "number" || !INPUT_STEPS.includes(step as StepNumber)) {
    return NextResponse.json(
      { success: false, error: "invalid_step", details: { allowed: [...INPUT_STEPS] } },
      { status: 400 },
    )
  }
  if (body.draft == null || typeof body.draft !== "object" || Array.isArray(body.draft)) {
    return NextResponse.json({ success: false, error: "invalid_draft" }, { status: 400 })
  }
  // 그 단계 소유 필드만 병합(backend /steps/{step} 미러) — 다른 단계·미지의 키는 버린다.
  const incoming = body.draft as Record<string, unknown>
  const patch: Partial<BuyerProfileDraft> = {}
  for (const key of STEP_FIELDS[step as StepNumber]) {
    if (key in incoming) (patch as Record<string, unknown>)[key] = incoming[key]
  }
  return { step: step as StepNumber, patch }
}

// 실 세션 — org_event_role_id를 fetchMe()에서 도출해 백엔드로 그대로 프록시(app/api/bm/[[...path]]/
// route.ts와 동일 인증 붙이기 방식: httpOnly 세션 쿠키 → Authorization: Bearer).
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

  let body: { step?: unknown; draft?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 })
  }
  const parsed = parseStepPatch(body)
  if (parsed instanceof NextResponse) return parsed

  const upstream = await fetch(
    `${BACKEND_URL}/api/bm/buyer/${buyerRole.org_event_role_id}/steps/${parsed.step}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(toApiBody(parsed.patch)),
    },
  )
  if (!upstream.ok) {
    return NextResponse.json({ success: false, error: `http_${upstream.status}` }, { status: upstream.status })
  }
  return NextResponse.json({ success: true })
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

  // 제출 후 잠금 — ApplyForm 읽기전용 가드와 동일 판단. 수정은 changes_requested로 다시 열릴 때만.
  if (
    session.applicationStatus !== "registered" &&
    session.applicationStatus !== "changes_requested"
  ) {
    return NextResponse.json(
      { success: false, error: "locked", details: { status: session.applicationStatus } },
      { status: 409 },
    )
  }

  let body: { step?: unknown; draft?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 })
  }
  const parsed = parseStepPatch(body)
  if (parsed instanceof NextResponse) return parsed

  // 목업 단계: 서버 메모리 store에 병합(프로세스 생존 동안 유지). 클라 localStorage가 여전히
  // 복구(재개)의 단일 소스다 — GET(loadProfile) 라우트가 생기면 그때 localStorage를 걷어낸다.
  const stored = saveStep(session.orgId, parsed.step, parsed.patch)
  return NextResponse.json({ success: true, draft: stored.draft })
}
