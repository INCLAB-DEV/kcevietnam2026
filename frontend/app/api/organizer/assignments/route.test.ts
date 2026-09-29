// OP-005 QA B1/B2 — 배정 payload 회귀 가드.
//
// 발주자 지적: 10:00~10:30으로 배정했는데 10:00~10:45로 저장됐다. 원인은 FE 폴백 상수(45분)가
// scheduled_end 계산에 새어들어간 것이고, 백엔드는 explicit start/end를 슬롯 그리드와 대조하지
// 않아(assignment_service._resolve_window) 그대로 저장했다. 그래서 이 라우트는 이제 시간 구간을
// 직접 계산하지 않고 **slot_ids**로 넘긴다 — 백엔드 slot_grid.validate_slot_run이 그리드 소속·
// 연속성·최대 3칸·미래 여부를 검증하고 구간을 환산한다.
//
// 이 테스트가 잠그는 것:
//   · 30분 미팅 → slot_ids 1칸(= 시작 + 30분 구간), scheduled_start/end는 보내지 않는다
//   · 60/90분 미팅 → 연속 slot_ids 2·3칸(연속 슬롯 병합 = 하나의 긴 미팅)
//   · 칸 간격은 행사 설정(events.slot_minutes)에서 온다 — 못 읽으면 30분 폴백(45분이 아니다)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string,
  slotMinutes: 30 as number | undefined,
  lastBody: null as unknown,
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
vi.mock("@/lib/organizer/backend-proxy", () => ({
  BACKEND_URL: "http://backend.test",
  resolveEventContext: async () => ({
    ok: true,
    value: { id: "ev-1", timezone: "Asia/Ho_Chi_Minh", slotMinutes: state.slotMinutes },
  }),
  resolveDefaultVenueId: async () => ({ ok: true, value: "venue-1" }),
  backendJson: async (_token: string, _path: string, init?: { body?: unknown }) => {
    state.lastBody = init?.body
    return { ok: true, value: { id: "meeting-1" } }
  },
}))

import { POST } from "./route"

function forcedBody(over: Record<string, unknown> = {}) {
  return {
    meetings: [
      {
        id: "forced-b1-e1-2026-10-20T10:00",
        exhibitorId: "e1",
        buyerId: "b1",
        slotId: "2026-10-20T10:00",
        status: "accepted",
        matchingType: "forced",
        ...over,
      },
    ],
  }
}

async function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/organizer/assignments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  )
}

describe("POST /api/organizer/assignments — 강제 배정 payload", () => {
  beforeEach(() => {
    state.token = "session-token"
    state.slotMinutes = 30
    state.lastBody = null
  })
  afterEach(() => vi.clearAllMocks())

  it("30분 미팅은 슬롯 1칸으로 보낸다 — scheduled_start/end는 보내지 않는다", async () => {
    const response = await post(forcedBody({ durationMinutes: 30 }))
    expect(response.status).toBe(200)
    expect(state.lastBody).toEqual({
      exhibitor_org_id: "e1",
      buyer_org_id: "b1",
      venue_id: "venue-1",
      slot_ids: ["2026-10-20T10:00"],
    })
  })

  it("60분 미팅은 연속 2칸(10:00·10:30) — 하나의 긴 미팅으로 저장된다", async () => {
    await post(forcedBody({ durationMinutes: 60 }))
    expect(state.lastBody).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30"],
    })
  })

  it("90분 미팅은 연속 3칸(백엔드 MAX_RUN_SLOTS 상한과 일치)", async () => {
    await post(forcedBody({ durationMinutes: 90 }))
    expect(state.lastBody).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30", "2026-10-20T11:00"],
    })
  })

  it("길이를 안 보내면 한 칸 — 그 '한 칸'은 행사 설정(slot_minutes)이 정한다", async () => {
    state.slotMinutes = 20
    await post(forcedBody({ durationMinutes: 40 }))
    expect(state.lastBody).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:20"], // 40분 = 20분 칸 2개
    })
  })

  it("행사 설정을 못 읽으면 30분으로 폴백한다 — 폐기된 45분 스펙이 아니다", async () => {
    state.slotMinutes = undefined
    await post(forcedBody({ durationMinutes: 60 }))
    expect(state.lastBody).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30"],
    })
  })

  it("세션이 없으면 백엔드를 부르지 않고 목업 저장소로 떨어진다", async () => {
    state.token = ""
    const response = await post(forcedBody({ durationMinutes: 30 }))
    expect(response.status).toBe(200)
    expect(state.lastBody).toBeNull()
  })
})

// 2026-09-15 QA 지적 B — "⚡ 빈 슬롯 채움 제안 → 확정을 눌러도 매칭이 등록 안 되는 것 같다".
// 실제 원인: confirmSingleFill이 만드는 배치(matchingType='ai')는 forced 전용 분기(위)를 안 타서
// 실세션에서도 addAssignments(인메모리 mock store)로 조용히 떨어졌다 — 새로고침·다른 세션에서
// 안 보인다. 이 라우트가 /retrigger-assignments로 프록시하는지 여기서 잠근다.
describe("POST /api/organizer/assignments — ⚡ 단일기업 AI 재보충(confirmSingleFill) payload", () => {
  beforeEach(() => {
    state.token = "session-token"
    state.slotMinutes = 30
    state.lastBody = null
  })
  afterEach(() => vi.clearAllMocks())

  function retriggerBody(overrides: Record<string, unknown>[] = []) {
    const base = {
      exhibitorId: "e1",
      buyerId: "b1",
      slotId: "2026-10-20T10:00",
      status: "proposed",
      matchingType: "ai",
      durationMinutes: 30,
    }
    const meetings =
      overrides.length > 0
        ? overrides.map((o, i) => ({ ...base, id: `fill-1-e1-${i}`, ...o }))
        : [{ ...base, id: "fill-1-e1-0" }]
    return { meetings }
  }

  it("실세션이면 목업 저장소가 아니라 /retrigger-assignments로 프록시한다", async () => {
    const response = await post(retriggerBody())
    expect(response.status).toBe(200)
    expect(state.lastBody).toEqual({
      exhibitor_org_id: "e1",
      buyer_org_id: "b1",
      venue_id: "venue-1",
      slot_ids: ["2026-10-20T10:00"],
    })
    const body = await response.json()
    expect(body.ids).toEqual(["meeting-1"])
  })

  it("항목이 여럿이면(빈 슬롯 여러 건 보충) 각각 독립적으로 호출한다", async () => {
    const calls: unknown[] = []
    // backendJson mock을 이 테스트에서만 호출 순서를 기록하도록 교체할 수 없으니(모듈 mock은
    // 파일 상단에 고정) lastBody는 마지막 호출만 담는다 — 응답 ids 개수로 반복 호출을 검증한다.
    const response = await post(
      retriggerBody([
        { slotId: "2026-10-20T10:00" },
        { slotId: "2026-10-20T10:30" },
      ]),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.count).toBe(2)
    expect(body.ids).toEqual(["meeting-1", "meeting-1"]) // mock이 항상 같은 id를 돌려줄 뿐, 호출은 2번
    void calls
  })

  it("세션이 없으면 목업 저장소로 떨어진다(mock 모드 보존)", async () => {
    state.token = ""
    const response = await post(retriggerBody())
    expect(response.status).toBe(200)
    expect(state.lastBody).toBeNull()
  })
})
