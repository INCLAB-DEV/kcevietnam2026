// OP-002 — 참가기업 단건 등록(POST). MembersTable의 단건 등록 다이얼로그(registerMember)가 부른다.
// status/route.ts·[memberId]/route.ts(형제 라우트)와 동일한 실연동 원칙 — SESSION_COOKIE가 있으면
// FastAPI POST /api/admin/events/{event_id}/organizations로 프록시하고(운영자가 배정된 첫 행사
// 스코프, resolveEventId), 없으면(dev 스위처 mock 세션) 인증·권한만 확인하고 성공을 알린다 — 실
// 등록 대상 저장소가 없는 목업 모드는 클라 인메모리(setMembers)가 이미 원래 소스다.
//
// 등록은 **이 행사의 운영자(master·sub)** — 명단 업로드를 master+sub로 연 것과 같은 규칙을 단건
// 경로에도 맞췄다(발주자 지시). sub는 바이어만 만들 수 있고 만든 바이어는 그 sub 관할로 들어간다.
// FastAPI(require_event_operator + 서비스 계층 관할 검사)가 최종 권위고, mock 모드는 이 라우트가
// 직접 session.permissionLevel/role로 같은 규칙을 흉내 낸다. 백엔드 스키마는 명단 A층 전체가 아니라
// 최소 식별 필드(기업명·역할·담당자 연락처)만 받는다 — businessRegNo·website·productCategory 등
// 나머지 A층 필드는 신청서(BM) 작성 단계에서 채워진다(roster import와 달리 단건등록은 최소 스캐폴딩만).
//
// password(선택)는 담당자 계정의 로그인 비밀번호다 — **본문으로 통과시키기만 한다**. 로그에 찍지
// 않고 응답에도 되돌려주지 않는다(정책 검사·해시는 FastAPI app.auth.credentials가 단일 정본).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  name: z.string().min(1),
  nameEn: z.string().optional(),
  role: z.enum(["exhibitor", "buyer"]),
  contactName: z.string().optional(),
  contactEmail: z.string().optional(),
  contactPhone: z.string().optional(),
  // 비어 있으면 "비밀번호 없이 등록"(그 계정은 로그인 불가) — 백엔드로 아예 보내지 않는다.
  password: z.string().optional(),
})

interface OrgListItemSnake {
  id: string
  name_ko?: string | null
  name_en?: string | null
  is_exhibitor: boolean
  is_buyer: boolean
  application_status: string
}

export async function POST(request: Request) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  // mock 모드(dev 스위처) — 실 저장소가 없다. 권한만 확인하고 성공을 알린다(클라 인메모리가 정본).
  // 관할(sub는 바이어만)은 본문을 파싱한 뒤에 봐야 하므로 세션을 여기서 잡아 아래에서 재사용한다.
  const mockSession = token ? null : await resolveRequestSession()
  if (!token) {
    const guard = await resolveRequestGuard()
    if (!guard.authenticated) {
      return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
    }
    if (mockSession?.role !== "organizer") {
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
    return NextResponse.json(
      { success: false, error: "validation_failed", details: parsed.error.flatten() },
      { status: 422 },
    )
  }

  // sub는 바이어만 등록한다(관할, FastAPI check_create_jurisdiction 미러). 실세션이면 백엔드가
  // 최종 권위지만, 실 저장소가 없는 mock 모드에선 이 라우트가 유일한 게이트다.
  if (mockSession && mockSession.permissionLevel !== "master" && parsed.data.role !== "buyer") {
    return NextResponse.json({ success: false, error: "forbidden_sub" }, { status: 403 })
  }

  if (token) {
    const eventResult = await resolveEventId(token)
    if (!eventResult.ok) {
      return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
    }
    const result = await backendJson<OrgListItemSnake>(
      token,
      `/api/admin/events/${encodeURIComponent(eventResult.value)}/organizations`,
      {
        method: "POST",
        body: {
          name_ko: parsed.data.name,
          name_en: parsed.data.nameEn || undefined,
          role: parsed.data.role,
          contact_name: parsed.data.contactName || undefined,
          contact_email: parsed.data.contactEmail || undefined,
          contact_phone: parsed.data.contactPhone || undefined,
          contact_password: parsed.data.password || undefined,
        },
      },
    )
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json({ success: true, id: result.value.id })
  }

  return NextResponse.json({ success: true, id: null })
}
