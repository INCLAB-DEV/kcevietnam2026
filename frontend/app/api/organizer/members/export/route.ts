// OP-002: 브라우저 필터를 전달하되 행사 ID·Bearer는 서버 세션에서만 결정한다.
import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { BACKEND_URL, resolveEventId } from "@/lib/organizer/backend-proxy"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return NextResponse.json({ error: "no_session" }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json(
      { error: eventResult.error },
      { status: eventResult.status }
    )
  }
  try {
    const upstream = await fetch(
      `${BACKEND_URL}/api/admin/export/organizations.xlsx?event_id=${encodeURIComponent(eventResult.value)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }
    )
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
      },
    })
  } catch {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 })
  }
}
