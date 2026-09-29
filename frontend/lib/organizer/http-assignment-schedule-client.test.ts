import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchAssignmentSchedule, fetchOrganizationSchedule } from "./http-assignment-schedule-client"

// unwrap()의 401 처리 — http-ops-metrics-client.test.ts와 동일 원칙/패턴의 회귀 테스트
// (OP-005 배정 허브도 같은 unwrap 형태를 갖고 있어 같은 버그·같은 수정이 적용된다).

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchAssignmentSchedule — 백엔드 인증 실패 처리", () => {
  it("401이면 raw Error를 던지지 않고 /login으로 redirect한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "인증이 필요합니다" }), { status: 401 })),
    )

    await expect(fetchAssignmentSchedule("stale-token")).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;.*;\/login;/),
    })
  })

  it("401이 아닌 실패(예: 500)는 기존처럼 Error로 전파한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "internal" }), { status: 500 })),
    )

    await expect(fetchAssignmentSchedule("token")).rejects.toThrow(/organizer assignment-schedule read failed/)
  })
})

// 2026-09-17 — OP-003 기업 디테일 일정(master+sub, 관할 검사). 관할 밖·없는 기업은 던지지 않고 값으로.
function routeFetch(scheduleBody: unknown, scheduleStatus = 200) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/api/admin/events")) {
      return new Response(JSON.stringify({ items: [{ id: "evt-1", timezone: "Asia/Ho_Chi_Minh" }] }), { status: 200 })
    }
    return new Response(JSON.stringify(scheduleBody), { status: scheduleStatus })
  })
}

describe("fetchOrganizationSchedule — 관할 조회 결과", () => {
  it("403은 forbidden, 404는 not_found 값으로 돌려준다(오류 화면으로 던지지 않는다)", async () => {
    vi.stubGlobal("fetch", routeFetch({ detail: "이 바이어는 관할 밖입니다" }, 403))
    await expect(fetchOrganizationSchedule("token", "org-x")).resolves.toEqual({ status: "forbidden" })

    vi.stubGlobal("fetch", routeFetch({ detail: "기업을 찾을 수 없습니다" }, 404))
    await expect(fetchOrganizationSchedule("token", "org-x")).resolves.toEqual({ status: "not_found" })
  })

  it("200은 기업 단위 경로를 부르고 그리드 계약으로 매핑한다(행사 타임존 포함)", async () => {
    const fetchSpy = routeFetch({
      exhibitors: [],
      buyers: [],
      dates: [{ id: "2026-10-20", label: "10/20", weekday: "화" }],
      settings: { start_time: "09:00", end_time: "10:00", slot_minutes: 30, slot_gap_minutes: 0, max_meeting_minutes: 90, lunch_start: "00:00", lunch_end: "00:00", min_slots: 10 },
      meetings: [],
      application_order: {},
      unavailable_by_org_id: {},
      contacts_by_org_id: {},
    })
    vi.stubGlobal("fetch", fetchSpy)

    const result = await fetchOrganizationSchedule("token", "org-1")

    expect(fetchSpy.mock.calls.map(([url]) => url).at(-1)).toMatch(/\/api\/admin\/events\/evt-1\/organizations\/org-1\/schedule$/)
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.data.timezone).toBe("Asia/Ho_Chi_Minh")
      expect(result.data.slotTimes).toEqual(["09:00", "09:30"])
    }
  })

  it("권한·존재 외 실패(500)는 던져서 error.tsx가 받는다", async () => {
    vi.stubGlobal("fetch", routeFetch({ detail: "internal" }, 500))
    await expect(fetchOrganizationSchedule("token", "org-1")).rejects.toThrow(/organizations\/\{id\}\/schedule/)
  })
})
