import { describe, expect, it, vi } from "vitest"
import { getEventSettingsSafe } from "./server"
import type { AdminReadClient } from "./server"
import type { AdminEventSettings } from "./types"
import { VIETNAM_EVENT_ID } from "./admin-mock"

// getEventSettingsSafe — /admin/events가 등록된 모든 행사를 순회하며 설정을 붙일 때 쓰는 내성
// 래퍼. 개별 행사 조회 실패(예: 아직 이 계정 권한으로 안 잡힌 행사 → 403)가 Promise.all 전체를
// reject시켜 페이지를 통째로 500 내리던 결함의 회귀 테스트.
//
// 실 client(httpAdminReadClient)는 next/headers의 cookies()를 요구해 이 테스트 환경에선 못 태우니
// AdminReadClient 계약만 만족하는 가짜 client를 주입한다(함수 시그니처 자체가 그 주입 지점).
function fakeClient(overrides: Partial<AdminReadClient>): AdminReadClient {
  const notImplemented = async () => {
    throw new Error("이 테스트에서 쓰지 않는 메서드")
  }
  return {
    getEvents: notImplemented,
    getEventSettings: notImplemented,
    getOrganizations: notImplemented,
    getOrgProfiles: notImplemented,
    getMeetings: notImplemented,
    getNotifications: notImplemented,
    getInterpreters: notImplemented,
    getVenues: notImplemented,
    getOrganizers: notImplemented,
    getDashboard: notImplemented,
    ...overrides,
  }
}

const SETTINGS: AdminEventSettings = {
  event_id: VIETNAM_EVENT_ID,
  slot_minutes: 30,
  enabled_venue_types: ["booth"],
  allow_same_role_discovery: false,
  operating_start: "09:00",
  operating_end: "18:00",
  lunch_start: "12:00",
  lunch_end: "13:00",
  min_guaranteed_slots: 10,
  slot_gap_minutes: 0,
  max_meeting_minutes: 90,
  participant_menu: "meetings_only",
  participant_email_enabled: true,
}

describe("getEventSettingsSafe — 행사별 설정 조회의 부분 실패 내성", () => {
  it("성공하면 그대로 돌려준다", async () => {
    const client = fakeClient({ getEventSettings: async () => SETTINGS })
    await expect(getEventSettingsSafe(VIETNAM_EVENT_ID, client)).resolves.toEqual(SETTINGS)
  })

  it("개별 행사 조회가 실패해도(403 등) 던지지 않고 null로 강등한다", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const client = fakeClient({
      getEventSettings: async () => {
        throw new Error("admin read failed: GET /events/x/settings (403)")
      },
    })
    await expect(getEventSettingsSafe(VIETNAM_EVENT_ID, client)).resolves.toBeNull()
    consoleError.mockRestore()
  })

  it("행사가 여럿이고 그중 하나만 실패해도 나머지는 살아남는다 — /admin/events 500 회귀 방지", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const okClient = fakeClient({ getEventSettings: async () => SETTINGS })
    const failClient = fakeClient({
      getEventSettings: async () => {
        throw new Error("403")
      },
    })

    const results = await Promise.all([
      getEventSettingsSafe("evt-ok-1", okClient),
      getEventSettingsSafe("evt-fail", failClient),
      getEventSettingsSafe("evt-ok-2", okClient),
    ])

    expect(results).toEqual([SETTINGS, null, SETTINGS])
    consoleError.mockRestore()
  })
})
