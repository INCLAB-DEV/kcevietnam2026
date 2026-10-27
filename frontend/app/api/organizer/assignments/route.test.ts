// OP-005 — 배정 저장 BFF(POST /api/organizer/assignments) 회귀 가드.
//
// ⚠ 이 파일은 backend-proxy 헬퍼(resolveEventContext·backendJson…)를 mock하지 않는다 — **fetch만**
// 가짜 백엔드로 바꾸고 라우트의 실제 경로를 그대로 태운다. 예전 테스트는 장소 해석 헬퍼
// (resolveDefaultVenueId)를 `{ ok: true, value: "venue-1" }`로 고정 mock해, 운영에서 실제로 터진
// 지점(장소가 없는 행사 → 404 no_venue, 9/30)과 오진(항상 같은 테이블 → 409 VENUE_TAKEN, 10/1)을
// 통째로 가렸다(2026-10-01 고객 신고 "배정 저장에 실패했어요"). 이제 BFF는 장소를 고르지 않는다 —
// GET .../venues를 부르지 않고 venue_id 없이 보낸다(장소는 백엔드가 정책대로 정한다).
//
// 함께 잠그는 것:
//   · QA B1/B2 — 시간은 scheduled_start/end가 아니라 slot_ids로(백엔드 슬롯 그리드 검증을 태운다).
//     칸 간격은 행사 설정(slot_minutes·slot_gap_minutes)에서 온다 — 못 읽으면 30분 폴백(45분 아님).
//   · 실패는 백엔드 code·message(·busyRoles)를 그대로 내려준다 — 화면이 원인별 문구를 고른다.
//   · ⚡ 재보충 배치가 중간에 실패하면 이미 저장된 건수(savedCount)를 알린다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Call = { url: string; method: string; body: Record<string, unknown> | undefined }
type Reply = { status: number; body: unknown }

const state = vi.hoisted(() => ({
  token: "session-token" as string,
  events: [] as Record<string, unknown>[],
  eventsStatus: 200,
  settings: {} as Record<string, unknown>,
  // GET .../venues가 돌려줄 값 — BFF가 이걸 부르면 안 된다(부르면 calls에 남는다).
  venues: [] as Record<string, unknown>[],
  // forced/retrigger POST 응답 큐(비면 201 성공).
  replies: [] as Reply[],
  calls: [] as Call[],
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

import { POST } from "./route"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// 가짜 FastAPI — URL로 엔드포인트를 가른다. 모든 호출을 calls에 남긴다.
function installBackend() {
  let seq = 0
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    state.calls.push({ url, method: init?.method ?? "GET", body })
    if (url.endsWith("/api/admin/events")) {
      return state.eventsStatus === 200
        ? jsonResponse(200, { items: state.events })
        : jsonResponse(state.eventsStatus, { detail: "unauthorized" })
    }
    if (url.endsWith("/settings")) return jsonResponse(200, state.settings)
    if (url.endsWith("/venues")) return jsonResponse(200, state.venues)
    if (url.endsWith("/forced-assignments") || url.endsWith("/retrigger-assignments")) {
      const reply = state.replies.shift()
      if (reply) return jsonResponse(reply.status, reply.body)
      seq += 1
      return jsonResponse(201, { id: `meeting-${seq}` })
    }
    return jsonResponse(404, { detail: "unexpected path" })
  }) as unknown as typeof fetch
}

const assignmentPosts = () =>
  state.calls.filter(
    (c) => c.url.endsWith("/forced-assignments") || c.url.endsWith("/retrigger-assignments"),
  )
const venueLookups = () => state.calls.filter((c) => c.url.endsWith("/venues"))

function forcedMeeting(over: Record<string, unknown> = {}) {
  return {
    id: "forced-b1-e1-2026-10-20T10:00",
    exhibitorId: "e1",
    buyerId: "b1",
    slotId: "2026-10-20T10:00",
    status: "accepted",
    matchingType: "forced",
    ...over,
  }
}

function retriggerMeetings(overrides: Record<string, unknown>[] = [{}]) {
  return overrides.map((o, i) => ({
    id: `fill-1-${i}`,
    exhibitorId: "e1",
    buyerId: "b1",
    slotId: "2026-10-20T10:00",
    status: "proposed",
    matchingType: "ai",
    durationMinutes: 30,
    ...o,
  }))
}

async function post(meetings: unknown[]) {
  return POST(
    new Request("http://localhost/api/organizer/assignments", {
      method: "POST",
      body: JSON.stringify({ meetings }),
    }),
  )
}

beforeEach(() => {
  state.token = "session-token"
  state.events = [{ id: "ev-1", timezone: "Asia/Ho_Chi_Minh", slot_minutes: 30 }]
  state.eventsStatus = 200
  state.settings = { slot_gap_minutes: 0 }
  state.venues = []
  state.replies = []
  state.calls = []
  installBackend()
})
afterEach(() => vi.restoreAllMocks())

describe("POST /api/organizer/assignments — 장소는 BFF가 고르지 않는다(2026-10-01)", () => {
  it("[9/30 재현] 장소가 하나도 없는 부스 전용 행사에서도 백엔드까지 간다 — 404 no_venue로 끊지 않는다", async () => {
    state.venues = [] // 신고 당시: enabled_venue_types={booth}, meeting_venues 0행

    const response = await post([forcedMeeting({ durationMinutes: 30 })])

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, ids: ["meeting-1"] })
    expect(venueLookups()).toHaveLength(0)
    expect(assignmentPosts()).toHaveLength(1)
    expect(assignmentPosts()[0].url).toMatch(/\/api\/admin\/events\/ev-1\/forced-assignments$/)
    expect(assignmentPosts()[0].body).not.toHaveProperty("venue_id")
  })

  it("[10/1 재현] 같은 시각 서로 다른 참가사 쌍 2건 — 어느 쪽에도 같은 테이블(INC)을 박아 보내지 않는다", async () => {
    state.venues = [{ id: "venue-inc", venue_type: "zone_table", label: "INC" }]

    const first = await post([forcedMeeting({ id: "f-1", slotId: "2026-10-20T13:00" })])
    const second = await post([
      forcedMeeting({ id: "f-2", exhibitorId: "e2", buyerId: "b2", slotId: "2026-10-20T13:00" }),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(venueLookups()).toHaveLength(0)
    expect(assignmentPosts().map((c) => c.body)).toEqual([
      { exhibitor_org_id: "e1", buyer_org_id: "b1", slot_ids: ["2026-10-20T13:00"] },
      { exhibitor_org_id: "e2", buyer_org_id: "b2", slot_ids: ["2026-10-20T13:00"] },
    ])
  })
})

describe("POST /api/organizer/assignments — 강제 배정 payload(QA B1/B2)", () => {
  it("30분 미팅은 슬롯 1칸으로 보낸다 — scheduled_start/end·venue_id는 보내지 않는다", async () => {
    const response = await post([forcedMeeting({ durationMinutes: 30 })])
    expect(response.status).toBe(200)
    expect(assignmentPosts()[0].body).toEqual({
      exhibitor_org_id: "e1",
      buyer_org_id: "b1",
      slot_ids: ["2026-10-20T10:00"],
    })
  })

  it("60분 미팅은 연속 2칸(10:00·10:30) — 하나의 긴 미팅으로 저장된다", async () => {
    await post([forcedMeeting({ durationMinutes: 60 })])
    expect(assignmentPosts()[0].body).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30"],
    })
  })

  it("90분 미팅은 연속 3칸", async () => {
    await post([forcedMeeting({ durationMinutes: 90 })])
    expect(assignmentPosts()[0].body).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30", "2026-10-20T11:00"],
    })
  })

  it("칸 길이는 행사 설정(slot_minutes)이 정한다", async () => {
    state.events = [{ id: "ev-1", timezone: "Asia/Seoul", slot_minutes: 20 }]
    await post([forcedMeeting({ durationMinutes: 40 })])
    expect(assignmentPosts()[0].body).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:20"], // 40분 = 20분 칸 2개
    })
  })

  it("운영 격자(40분 + 텀 5분) — 85분 미팅은 13:00·13:45 두 칸(텀은 행사 설정에서 읽는다)", async () => {
    state.events = [{ id: "ev-1", timezone: "Asia/Seoul", slot_minutes: 40 }]
    state.settings = { slot_gap_minutes: 5 }
    await post([forcedMeeting({ slotId: "2026-10-20T13:00", durationMinutes: 85 })])
    expect(assignmentPosts()[0].body).toEqual({
      exhibitor_org_id: "e1",
      buyer_org_id: "b1",
      slot_ids: ["2026-10-20T13:00", "2026-10-20T13:45"],
    })
  })

  it("행사 설정을 못 읽으면 30분으로 폴백한다 — 폐기된 45분 스펙이 아니다", async () => {
    state.events = [{ id: "ev-1", timezone: "Asia/Seoul" }]
    await post([forcedMeeting({ durationMinutes: 60 })])
    expect(assignmentPosts()[0].body).toMatchObject({
      slot_ids: ["2026-10-20T10:00", "2026-10-20T10:30"],
    })
  })

  it("세션이 없으면 백엔드를 부르지 않고 목업 저장소로 떨어진다", async () => {
    state.token = ""
    const response = await post([forcedMeeting({ durationMinutes: 30 })])
    expect(response.status).toBe(200)
    expect(state.calls).toHaveLength(0)
  })

  // 세션 만료 표면화(2026-09-30) — upstream이 401이면(쿠키는 있지만 만료된 운영자 세션) 일반 에러가
  // 아니라 session_expired로 통일해 내려준다(화면이 재로그인으로 보낸다).
  it("행사 조회가 401이면 session_expired로 응답한다", async () => {
    state.eventsStatus = 401
    const response = await post([forcedMeeting({ durationMinutes: 30 })])
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ success: false, error: "session_expired" })
  })
})

describe("POST /api/organizer/assignments — 백엔드 실패 이유를 그대로 전달한다", () => {
  it("VENUE_TAKEN은 status·code·message를 그대로 내려준다(이유를 버리지 않는다)", async () => {
    state.replies = [
      {
        status: 409,
        body: {
          detail: {
            code: "VENUE_TAKEN",
            message: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
          },
        },
      },
    ]

    const response = await post([forcedMeeting()])

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "VENUE_TAKEN",
      message: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
    })
  })

  it("SLOT_TAKEN은 막힌 쪽(busy_roles)을 busyRoles로 함께 내려준다", async () => {
    state.replies = [
      {
        status: 409,
        body: {
          detail: {
            code: "SLOT_TAKEN",
            message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
            busy_roles: ["buyer"],
          },
        },
      },
    ]

    const response = await post([forcedMeeting()])

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "SLOT_TAKEN",
      message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["buyer"],
    })
  })

  it("FastAPI 자동 검증 실패(detail 배열)는 http_422로 — 지어낸 message는 없다", async () => {
    state.replies = [{ status: 422, body: { detail: [{ type: "missing", loc: ["body", "x"] }] } }]

    const response = await post([forcedMeeting()])

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, error: "http_422" })
  })
})

// 2026-09-15 QA 지적 B — "⚡ 빈 슬롯 채움 제안 → 확정을 눌러도 매칭이 등록 안 되는 것 같다". confirmSingleFill
// 배치(matchingType='ai')가 실세션에서 /retrigger-assignments로 프록시되는지 잠근다.
describe("POST /api/organizer/assignments — ⚡ 단일기업 AI 재보충(confirmSingleFill)", () => {
  it("실세션이면 목업 저장소가 아니라 /retrigger-assignments로 프록시한다(venue_id 없이)", async () => {
    const response = await post(retriggerMeetings())
    expect(response.status).toBe(200)
    expect(venueLookups()).toHaveLength(0)
    expect(assignmentPosts()).toHaveLength(1)
    expect(assignmentPosts()[0].url).toMatch(/\/retrigger-assignments$/)
    expect(assignmentPosts()[0].body).toEqual({
      exhibitor_org_id: "e1",
      buyer_org_id: "b1",
      slot_ids: ["2026-10-20T10:00"],
    })
    expect((await response.json()).ids).toEqual(["meeting-1"])
  })

  it("항목이 여럿이면(빈 슬롯 여러 건 보충) 각각 독립적으로 호출한다", async () => {
    const response = await post(
      retriggerMeetings([{ slotId: "2026-10-20T10:00" }, { slotId: "2026-10-20T10:30", buyerId: "b2" }]),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.count).toBe(2)
    expect(body.ids).toEqual(["meeting-1", "meeting-2"])
    expect(assignmentPosts().map((c) => c.body?.slot_ids)).toEqual([
      ["2026-10-20T10:00"],
      ["2026-10-20T10:30"],
    ])
  })

  it("중간 항목이 실패하면 거기서 멈추고, 앞서 이미 저장된 건수(savedCount)와 이유를 내려준다", async () => {
    state.replies = [
      { status: 201, body: { id: "meeting-saved" } },
      {
        status: 409,
        body: {
          detail: {
            code: "SLOT_TAKEN",
            message: "참가사가 해당 시간에 이미 확정된 미팅이 있습니다.",
            busy_roles: ["exhibitor"],
          },
        },
      },
    ]

    const response = await post(
      retriggerMeetings([
        { slotId: "2026-10-20T10:00" },
        { slotId: "2026-10-20T10:30", buyerId: "b2" },
        { slotId: "2026-10-20T11:00", buyerId: "b3" },
      ]),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "SLOT_TAKEN",
      message: "참가사가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["exhibitor"],
      savedCount: 1,
    })
    expect(assignmentPosts()).toHaveLength(2) // 실패한 곳에서 멈춘다 — 세 번째는 보내지 않는다
  })

  it("세션이 없으면 목업 저장소로 떨어진다(mock 모드 보존)", async () => {
    state.token = ""
    const response = await post(retriggerMeetings())
    expect(response.status).toBe(200)
    expect(state.calls).toHaveLength(0)
  })
})
