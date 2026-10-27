// 행사 스코프 divergence 회귀 가드(2026-09-30) — resolveEventContext/resolveEventId가 슈퍼어드민
// 콘솔의 선택 행사 쿠키(nabi_admin_event, lib/admin/events.ts ADMIN_EVENT_COOKIE)를 존중하는지 잠근다.
//
// 배경: 이 write 프록시 헬퍼는 항상 GET /api/admin/events의 items[0](최신 행사)을 썼는데, READ
// 뷰는 쿠키로 선택된 행사를 본다. 행사가 2개 이상이면 운영자가 "보는" 행사와 강제배정이 "착지하는"
// 행사가 갈려 422(slot outside event period)로 튕겼다. 이제 resolveSelectedEvent(admin/events.ts,
// 셸과 같은 선택 로직)로 고른다 — 쿠키 없음·목록에 없는 id는 기존과 똑같이 items[0] 폴백.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  throwOnCookies: false,
}))

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.throwOnCookies) throw new Error("요청 스코프 밖에서 cookies() 호출")
    return {
      get: (name: string) =>
        name === "nabi_admin_event" && state.cookieValue ? { value: state.cookieValue } : undefined,
    }
  },
}))

import * as backendProxy from "./backend-proxy"
import { backendJson, resolveEventContext, resolveEventId, sessionAwareErrorResponse } from "./backend-proxy"

const EVENTS = [
  { id: "ev-1", timezone: "Asia/Seoul", slot_minutes: 30 },
  { id: "ev-2", timezone: "Asia/Ho_Chi_Minh", slot_minutes: 40 },
]

function mockFetch(items: unknown[], settings?: Record<string, unknown>) {
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/settings")) {
      return { ok: true, json: async () => settings ?? {} } as Response
    }
    return { ok: true, json: async () => ({ items }) } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  state.cookieValue = undefined
  state.throwOnCookies = false
})
afterEach(() => vi.restoreAllMocks())

describe("resolveEventContext — 쿠키 인식 행사 해석", () => {
  it("쿠키가 목록에 있는 id를 가리키면 그 행사를 쓴다(items[0]이 아니다)", async () => {
    mockFetch(EVENTS)
    state.cookieValue = "ev-2"

    const result = await resolveEventContext("token")

    expect(result).toEqual({
      ok: true,
      value: { id: "ev-2", timezone: "Asia/Ho_Chi_Minh", slotMinutes: 40, slotGapMinutes: undefined },
    })
  })

  it("쿠키가 목록에 없는 id면 첫 행사로 폴백한다", async () => {
    mockFetch(EVENTS)
    state.cookieValue = "no-such-event"

    const result = await resolveEventContext("token")

    expect(result.ok && result.value.id).toBe("ev-1")
  })

  it("쿠키가 없으면 첫 행사를 쓴다(기존 동작과 동일)", async () => {
    mockFetch(EVENTS)

    const result = await resolveEventContext("token")

    expect(result.ok && result.value.id).toBe("ev-1")
  })

  it("cookies()가 던지면(요청 스코프 밖) 예외가 새지 않고 첫 행사로 폴백한다", async () => {
    mockFetch(EVENTS)
    state.throwOnCookies = true

    const result = await resolveEventContext("token")

    expect(result.ok && result.value.id).toBe("ev-1")
  })

  it("행사 목록이 비어 있으면 기존처럼 no_event를 돌려준다", async () => {
    mockFetch([])

    const result = await resolveEventContext("token")

    expect(result).toEqual({ ok: false, status: 404, error: "no_event" })
  })

  it("withSlotGap을 안 넘기면 settings를 추가로 fetch하지 않는다(opt-in 불변)", async () => {
    mockFetch(EVENTS)

    await resolveEventContext("token")

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it("withSlotGap이 true면 settings를 한 번 더 fetch해 slotGapMinutes를 채운다", async () => {
    mockFetch(EVENTS, { slot_gap_minutes: 5 })

    const result = await resolveEventContext("token", { withSlotGap: true })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(result.ok && result.value.slotGapMinutes).toBe(5)
  })
})

describe("resolveEventId — 쿠키 선택을 그대로 물려받는다", () => {
  it("선택된 행사의 id만 뽑아 돌려준다", async () => {
    mockFetch(EVENTS)
    state.cookieValue = "ev-2"

    const result = await resolveEventId("token")

    expect(result).toEqual({ ok: true, value: "ev-2" })
  })
})

// sessionAwareErrorResponse 실구현 회귀 가드 — assignments·saturation·saturation/confirm 세
// write 라우트 테스트가 그동안 이 헬퍼를 각자 복제한 mock으로 대체해 왔다(vi.mock 전체 대체).
// 그래서 실제 구현이 401에 200을 돌려주거나 error 코드명을 바꿔도 회귀 가드가 계속 통과하는
// 빈 껍데기였다. 여기서 실제 함수를 직접 호출해 매핑을 잠근다.
describe("sessionAwareErrorResponse — upstream 실패 응답 매핑", () => {
  it("401은 session_expired로 통일한다(원래 error 코드는 버린다)", async () => {
    const response = sessionAwareErrorResponse({ status: 401, error: "unauthorized" })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ success: false, error: "session_expired" })
  })

  it("404는 원래 status/error 그대로 통과시킨다(코드 변형 없음)", async () => {
    const response = sessionAwareErrorResponse({ status: 404, error: "no_event" })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ success: false, error: "no_event" })
  })

  it("422도 원래 status/error 그대로 통과시킨다", async () => {
    const response = sessionAwareErrorResponse({ status: 422, error: "slot_outside_event_period" })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ success: false, error: "slot_outside_event_period" })
  })

  // 2026-10-01 — 예전엔 code만 남기고 message를 버려, 화면이 모든 실패를 "네트워크 확인"으로 뭉갰다.
  it("백엔드 message·busyRoles와 호출부의 savedCount를 함께 실어 보낸다", async () => {
    const response = sessionAwareErrorResponse(
      {
        status: 409,
        error: "SLOT_TAKEN",
        message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
        busyRoles: ["buyer"],
      },
      { savedCount: 2 },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "SLOT_TAKEN",
      message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["buyer"],
      savedCount: 2,
    })
  })

  it("401은 message·savedCount가 있어도 session_expired 하나로 통일한다", async () => {
    const response = sessionAwareErrorResponse(
      { status: 401, error: "unauthorized", message: "토큰 만료" },
      { savedCount: 1 },
    )

    expect(await response.json()).toEqual({ success: false, error: "session_expired" })
  })
})

describe("backendJson — 백엔드 에러 바디 해석", () => {
  function mockErrorFetch(status: number, body: unknown) {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => body,
    })) as unknown as typeof fetch
  }

  it("MeetingError 바디({detail:{code,message,busy_roles}})의 이유를 버리지 않는다", async () => {
    mockErrorFetch(409, {
      detail: {
        code: "SLOT_TAKEN",
        message: "참가사가 해당 시간에 이미 확정된 미팅이 있습니다.",
        busy_roles: ["exhibitor"],
      },
    })

    expect(await backendJson("token", "/x")).toEqual({
      ok: false,
      status: 409,
      error: "SLOT_TAKEN",
      code: "SLOT_TAKEN",
      message: "참가사가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["exhibitor"],
    })
  })

  // code는 구조화된 detail에만 있다 — 문자열 detail이 우연히 코드처럼 생겨도 code로 보이지 않는다.
  it("문자열 detail(HTTPException)은 기존처럼 그 문자열이 error이고, 화면용 message로도 싣는다(code는 없다)", async () => {
    mockErrorFetch(403, { detail: "이 행사의 운영자(master) 권한이 필요합니다." })

    expect(await backendJson("token", "/x")).toEqual({
      ok: false,
      status: 403,
      error: "이 행사의 운영자(master) 권한이 필요합니다.",
      message: "이 행사의 운영자(master) 권한이 필요합니다.",
    })
  })

  it("바디를 못 읽으면 http_{status} — message를 지어내지 않는다", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json")
      },
    })) as unknown as typeof fetch

    expect(await backendJson("token", "/x")).toEqual({ ok: false, status: 502, error: "http_502" })
  })
})

// 2026-10-01 — 장소는 BFF가 고르지 않는다(백엔드 단일 결정). 예전 헬퍼가 되살아나면 9/30(no_venue)·
// 10/1(같은 테이블 고정) 사고가 그대로 재발한다.
describe("장소 사전 선택 헬퍼 제거", () => {
  it("resolveDefaultVenueId는 더 이상 export되지 않는다", () => {
    expect("resolveDefaultVenueId" in backendProxy).toBe(false)
  })
})
