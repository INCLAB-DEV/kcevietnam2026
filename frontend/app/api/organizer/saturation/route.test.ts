// 세션 만료 표면화(2026-09-30) — upstream(GET /api/admin/events, resolveEventContext) 401은
// session_expired로 통일해 내려준다. assignments 라우트와 같은 회귀 가드(그쪽 route.test.ts 참고).
// mock 모드(SESSION_COOKIE 없음)는 건드리지 않는다 — 이 파일은 실세션 401 분기만 잠근다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string,
  eventResult: null as { ok: false; status: number; error: string } | null,
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({ role: "organizer" }),
}))
// sessionAwareErrorResponse는 오버라이드하지 않는다 — importOriginal로 실제 구현을 그대로 써서
// "행사 조회가 401이면 session_expired로 응답한다" 케이스가 진짜 헬퍼를 경유하게 한다(복제 mock이
// 헬퍼가 깨져도 계속 통과하던 회귀 가드 빈 껍데기 문제, backend-proxy.test.ts 참고).
vi.mock("@/lib/organizer/backend-proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizer/backend-proxy")>()),
  resolveEventContext: async () =>
    state.eventResult ?? { ok: true, value: { id: "ev-1", timezone: "Asia/Ho_Chi_Minh" } },
  backendJson: async () => ({
    ok: true,
    value: {
      id: "run-1",
      event_id: "ev-1",
      run_number: 1,
      min_guaranteed_slots: 0,
      status: "draft",
      created_at: "2026-10-20T00:00:00Z",
      confirmed_at: null,
      items: [],
    },
  }),
}))

import { POST } from "./route"

function body() {
  return {
    settings: {
      startTime: "09:00",
      endTime: "18:00",
      slotMinutes: 30,
      slotGapMinutes: 0,
      lunchStart: "12:00",
      lunchEnd: "13:00",
      minSlots: 0,
      maxMeetingMinutes: 90,
    },
    assignMinutes: 30,
    runNumber: 1,
    now: { date: "2026-10-20", time: "09:00" },
  }
}

async function post() {
  return POST(
    new Request("http://localhost/api/organizer/saturation", {
      method: "POST",
      body: JSON.stringify(body()),
    }),
  )
}

describe("POST /api/organizer/saturation — 세션 만료", () => {
  beforeEach(() => {
    state.token = "session-token"
    state.eventResult = null
  })
  afterEach(() => vi.clearAllMocks())

  it("정상 세션이면 200으로 draft를 돌려준다", async () => {
    const response = await post()
    expect(response.status).toBe(200)
  })

  it("행사 조회가 401이면 session_expired로 응답한다", async () => {
    state.eventResult = { ok: false, status: 401, error: "unauthorized" }
    const response = await post()
    expect(response.status).toBe(401)
    const responseBody = await response.json()
    expect(responseBody).toEqual({ success: false, error: "session_expired" })
  })
})
