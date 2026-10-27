// OP-002 — 행사 운영 콘솔(/organizer/members)의 신청서 읽기(GET)·쓰기(PATCH). status/route.ts·
// [memberId]/route.ts(형제 라우트)와 동일한 실연동 원칙. 관리자 콘솔(/admin/organizations)과 **같은
// 백엔드 엔드포인트**를 쓴다 — GET .../organizations/{id}, PATCH .../profile(직접 수정),
// POST .../proxy-profile(대리작성). 새 API를 만들지 않는다.
//
// mode 선택(edit vs proxy)은 관리자 콘솔과 같은 규칙이다: application_status가 "registered"(미신청)면
// 대리작성(proxy-profile — master는 승인/sub는 제출로 **상태가 바뀐다**), 그 밖의 상태는 직접 수정
// (profile — 상태 불변). 클라가 정해 보낸다.
//
// body의 patch는 호출부가 만든 백엔드 patch 본문(snake_case) 그대로 통과시킨다 — 두 호출부가 있다:
//   · 신청서 편집 패널(lib/organizer/application-transport.ts) — 참가자 클라이언트의 본문 변환으로 만든
//     구획 전체 페이로드(mode="edit"). 관리자 콘솔과 같은 어댑터(lib/operator/application-client)를 쓴다.
//   · 미신청 행의 간이 대리작성(lib/organizer/member-profile-patch.ts, mode="proxy").
// 여기선 재검증하지 않는다(PATCH profile류 라우트 공통 원칙 — FastAPI extra="forbid"가 최종 방어선).
// 성공 응답에는 백엔드가 돌려준 **저장된 프로필**을 함께 싣는다(profile) — 패널이 보낸 값이 아니라
// 서버가 저장한 값으로 화면을 다시 그리게 한다.
//
// GET은 그 패널의 읽기 짝이다: 패널을 열 때마다 운영자 상세(GET .../organizations/{id} —
// OrganizationDetail, 프로필은 참가자 API와 같은 응답 모델)를 그대로 내려준다. 행사는 PATCH와 같은
// 규칙(lib/organizer/backend-proxy.ts resolveEventId — 선택된 행사)으로 고른다. 참가사면 미팅 불가 시간
// 격자의 축(행사 기간 × 하루 슬롯)도 함께 만들어 준다 — 이 콘솔의 명단 화면은 행사 설정을 들고 있지 않다.

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { backendJson, resolveEventId } from "@/lib/organizer/backend-proxy"
import {
  buildUnavailableSlotGrid,
  type SlotGridEventInput,
  type SlotGridSettingsInput,
  type UnavailableSlotGrid,
} from "@/lib/operator/slot-grid"

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  role: z.enum(["exhibitor", "buyer"]),
  // 두 모드 모두 호출부가 있다(죽은 분기가 아니다):
  //   "edit"  → PATCH .../profile       — 신청서 편집 패널의 전송(lib/organizer/application-transport.ts)
  //   "proxy" → POST .../proxy-profile  — 미신청 행의 간이 대리작성(lib/organizer/member-actions.patchMemberProfile)
  mode: z.enum(["edit", "proxy"]),
  patch: z.record(z.string(), z.unknown()),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const { memberId } = await params

  if (!token) {
    // mock 모드(dev 스위처) — 읽어 올 실 저장소가 없다. 권한만 확인하고 "없다"고 답한다(지어낸 신청서를
    // 내려주지 않는다 — 목업 화면은 클라가 인메모리 전송을 쓰므로 이 경로를 부르지 않는다).
    const guard = await resolveRequestGuard()
    if (!guard.authenticated) {
      return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
    }
    const session = await resolveRequestSession()
    if (session.role !== "organizer") {
      return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
    }
    return NextResponse.json({ success: false, error: "mock_session" }, { status: 404 })
  }

  const eventResult = await resolveEventId(token)
  if (!eventResult.ok) {
    return NextResponse.json({ success: false, error: eventResult.error }, { status: eventResult.status })
  }
  const eventPath = `/api/admin/events/${encodeURIComponent(eventResult.value)}`

  // 관할 밖 바이어는 백엔드가 403으로 막는다(check_jurisdiction) — 상태·사유를 그대로 통과시킨다.
  const detail = await backendJson<{ is_exhibitor?: boolean }>(
    token,
    `${eventPath}/organizations/${encodeURIComponent(memberId)}`,
  )
  if (!detail.ok) {
    return NextResponse.json({ success: false, error: detail.error }, { status: detail.status })
  }

  // 미팅 불가 시간 격자(참가사만). 행사·설정을 못 읽어도 신청서 조회는 막지 않는다 — 격자만 null로 두면
  // 패널이 "격자를 만들 수 없다"고 안내한다.
  let slotGrid: UnavailableSlotGrid | null = null
  if (detail.value.is_exhibitor) {
    const [event, settings] = await Promise.all([
      backendJson<SlotGridEventInput>(token, eventPath),
      backendJson<SlotGridSettingsInput>(token, `${eventPath}/settings`),
    ])
    slotGrid = buildUnavailableSlotGrid(
      event.ok ? event.value : null,
      settings.ok ? settings.value : null,
    )
  }

  return NextResponse.json({ success: true, id: memberId, detail: detail.value, slotGrid })
}

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
  // profile = 백엔드가 돌려준 저장된 프로필(BuyerProfileResponse/ExhibitorProfileResponse).
  return NextResponse.json({ success: true, id: memberId, profile: result.value })
}
