// 명단 업로드 BFF(POST, multipart) — 두 콘솔(/admin/organizations·/organizer/members)의 **유일한** 업로드
// 경로다(클라이언트 lib/roster/upload.ts, 다이얼로그 components/roster/roster-upload.tsx). FastAPI
// POST /api/admin/import/roster?event_id=...(backend/app/roster/router.py import_members)로 넘긴다.
//
// 예전엔 운영자 콘솔은 이 라우트(파일만 전달, 목업 모드는 가짜 성공), 어드민 콘솔은 catch-all
// (app/api/admin/[...path])로 따로 올려 템플릿·파서 별칭·결과 처리가 서로 어긋났다 — 하나로 합쳤다.
//
// · 인증: httpOnly 세션 쿠키를 서버에서 읽어 Bearer로 붙인다(클라 JS는 토큰을 만지지 않는다). 세션이
//   없으면 401(no_session) — 목업 모드의 가짜 성공은 없앴다(실 적재 없이 성공처럼 보이던 경로).
// · 행사: ?event_id=가 오면 **이 운영자의 행사 목록 안에 있을 때만** 쓴다(어드민 콘솔의 선택 행사).
//   없으면 운영자의 첫 행사(운영자 콘솔 — 명단 조회와 같은 해석, lib/organizer/backend-proxy).
// · 권한의 권위는 FastAPI(require_event_operator: 이 행사의 master·sub, sub는 관할)다.
// · multipart 본문은 다시 조립하지 않고 원문 그대로(content-type의 boundary 포함) 넘긴다 — 수 MB 파일을
//   재인코딩하지 않고, 필드 해석(file·password·dry_run·row_report·default_role, 빈 비밀번호 = 미입력)은
//   FastAPI 한 곳에서만 한다. 공통 비밀번호가 든 본문을 여기서 읽어 로그·저장하지 않는다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { BACKEND_URL, backendJson } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

// FastAPI detail → 화면이 가를 에러 코드. 문자열(파서 안내 등)은 그대로, {code}는 코드, 검증 배열은 상태코드.
function errorFromDetail(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail
  if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
    const code = (detail as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return `http_${status}`
}

async function resolveUploadEventId(
  token: string,
  requested: string | null,
): Promise<{ ok: true; value: string } | { ok: false; status: number; error: string }> {
  const events = await backendJson<{ items?: { id: string }[] }>(token, "/api/admin/events")
  if (!events.ok) return events
  const items = events.value.items ?? []
  if (requested) {
    return items.some((e) => e.id === requested)
      ? { ok: true, value: requested }
      : { ok: false, status: 403, error: "unknown_event" }
  }
  const first = items[0]
  return first ? { ok: true, value: first.id } : { ok: false, status: 404, error: "no_event" }
}

export async function POST(request: Request) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.json({ success: false, error: "no_session" }, { status: 401 })
  }

  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return NextResponse.json({ success: false, error: "no_file" }, { status: 400 })
  }

  let eventResult: Awaited<ReturnType<typeof resolveUploadEventId>>
  try {
    eventResult = await resolveUploadEventId(token, new URL(request.url).searchParams.get("event_id"))
  } catch {
    return NextResponse.json({ success: false, error: "upstream_unavailable" }, { status: 502 })
  }
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }

  let upstream: Response
  try {
    upstream = await fetch(
      `${BACKEND_URL}/api/admin/import/roster?event_id=${encodeURIComponent(eventResult.value)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body: await request.arrayBuffer(),
        cache: "no-store",
      },
    )
  } catch {
    return NextResponse.json({ success: false, error: "upstream_unavailable" }, { status: 502 })
  }
  const data = (await upstream.json().catch(() => null)) as { detail?: unknown } | null
  if (!upstream.ok) {
    return NextResponse.json(
      { success: false, error: errorFromDetail(data?.detail, upstream.status) },
      { status: upstream.status },
    )
  }
  return NextResponse.json({ success: true, result: data })
}
