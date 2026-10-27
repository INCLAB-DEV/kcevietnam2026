// 세션 만료 표면화(2026-09-30) — upstream(resolveEventId·confirm 호출) 401은 session_expired로
// 통일해 내려준다. assignments 라우트와 같은 회귀 가드(그쪽 route.test.ts 참고). mock 모드
// (SESSION_COOKIE 없음)는 건드리지 않는다 — 이 파일은 실세션 401 분기만 잠근다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string,
  eventResult: null as { ok: false; status: number; error: string } | null,
  confirmResult: null as { ok: false; status: number; error: string } | null,
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
// "행사 조회/confirm 호출이 401이면 session_expired로 응답한다" 케이스가 진짜 헬퍼를 경유하게
// 한다(복제 mock이 헬퍼가 깨져도 계속 통과하던 회귀 가드 빈 껍데기 문제, backend-proxy.test.ts 참고).
vi.mock("@/lib/organizer/backend-proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizer/backend-proxy")>()),
  resolveEventId: async () => state.eventResult ?? { ok: true, value: "ev-1" },
  backendJson: async () =>
    state.confirmResult ?? {
      ok: true,
      value: { confirmed_count: 1, skipped_count: 0, items: [] },
    },
}))

import { POST } from "./route"

function body() {
  return {
    draftAssignments: [
      {
        id: "draft-1",
        exhibitorId: "e1",
        buyerId: "b1",
        slotId: "2026-10-20T10:00",
        status: "accepted",
        matchingType: "ai",
        runId: "run-1",
      },
    ],
  }
}

async function post() {
  return POST(
    new Request("http://localhost/api/organizer/saturation/confirm", {
      method: "POST",
      body: JSON.stringify(body()),
    }),
  )
}

describe("POST /api/organizer/saturation/confirm — 세션 만료", () => {
  beforeEach(() => {
    state.token = "session-token"
    state.eventResult = null
    state.confirmResult = null
  })
  afterEach(() => vi.clearAllMocks())

  it("정상 세션이면 200으로 확정 결과를 돌려준다", async () => {
    const response = await post()
    expect(response.status).toBe(200)
  })

  it("행사 조회가 401이면 session_expired로 응답한다", async () => {
    state.eventResult = { ok: false, status: 401, error: "unauthorized" }
    const response = await post()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ success: false, error: "session_expired" })
  })

  it("confirm 호출 자체가 401이면 session_expired로 응답한다", async () => {
    state.confirmResult = { ok: false, status: 401, error: "unauthorized" }
    const response = await post()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ success: false, error: "session_expired" })
  })
})
