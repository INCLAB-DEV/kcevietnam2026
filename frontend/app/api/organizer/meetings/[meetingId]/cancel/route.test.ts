// QA 3차 #1 — 운영자 전용 미팅 취소 BFF. 참가자용 /api/meetings/{id}/cancel은 미팅 당사자만
// 통과해 운영자가 취소하면 403이 났다. 이 라우트는 실세션이면 FastAPI 어드민 취소 엔드포인트
// (require_event_master)로 프록시한다 — app/api/organizer/assignments/route.test.ts와 같은 패턴.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string,
  role: "organizer" as string,
  permissionLevel: "master" as string,
  eventOk: true,
  lastPath: null as string | null,
  lastBody: null as unknown,
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({ role: state.role, permissionLevel: state.permissionLevel }),
}))
vi.mock("@/lib/organizer/backend-proxy", () => ({
  resolveEventContext: async () =>
    state.eventOk
      ? { ok: true, value: { id: "ev-1", timezone: "Asia/Ho_Chi_Minh" } }
      : { ok: false, status: 404, error: "no_event" },
  backendJson: async (_token: string, path: string, init?: { body?: unknown }) => {
    state.lastPath = path
    state.lastBody = init?.body
    return { ok: true, value: { id: "mtg-1", status: "cancelled" } }
  },
}))

import { POST } from "./route"

async function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/organizer/meetings/mtg-1/cancel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ meetingId: "mtg-1" }) },
  )
}

describe("POST /api/organizer/meetings/[meetingId]/cancel", () => {
  beforeEach(() => {
    state.token = "session-token"
    state.role = "organizer"
    state.permissionLevel = "master"
    state.eventOk = true
    state.lastPath = null
    state.lastBody = null
  })
  afterEach(() => vi.clearAllMocks())

  it("실세션이면 행사 스코프 admin 취소 엔드포인트로 프록시한다", async () => {
    const res = await post({ reason_code: "schedule_conflict", reason_text: "장비 고장" })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, id: "mtg-1", status: "cancelled" })
    expect(state.lastPath).toBe("/api/admin/events/ev-1/meetings/mtg-1/cancel")
    expect(state.lastBody).toEqual({ reason_code: "schedule_conflict", reason_text: "장비 고장" })
  })

  it("사유 없이도 취소할 수 있다(둘 다 선택 필드)", async () => {
    const res = await post({})
    expect(res.status).toBe(200)
    expect(state.lastBody).toEqual({})
  })

  it("행사 조회가 실패하면 그 상태코드를 그대로 전달한다", async () => {
    state.eventOk = false
    const res = await post({})
    expect(res.status).toBe(404)
  })

  it("mock 모드(세션 쿠키 없음) — organizer가 아니면 403, master가 아니면 403", async () => {
    state.token = ""
    state.role = "buyer"
    let res = await post({})
    expect(res.status).toBe(403)

    state.role = "organizer"
    state.permissionLevel = "sub"
    res = await post({})
    expect(res.status).toBe(403)
  })

  it("mock 모드에서 organizer master면 성공(서버 영속 없음, 낙관적 갱신에 위임)", async () => {
    state.token = ""
    state.role = "organizer"
    state.permissionLevel = "master"
    const res = await post({})
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, id: "mtg-1", status: "cancelled" })
    expect(state.lastPath).toBeNull() // 백엔드를 부르지 않았다
  })
})
