// 배정 쓰기 클라 → BFF 호출 결과 해석. 2026-10-01 고객 신고 "배정 저장에 실패했어요 · 네트워크 확인 후
// 다시 시도해 주세요"의 한 축 — 실패 이유(code·message·busyRoles)가 화면까지 오는지, 그리고 "network"는
// fetch 자체가 던졌을 때만 붙는지(서버가 이유를 들고 거절한 건 네트워크 실패가 아니다) 잠근다.

import { afterEach, describe, expect, it, vi } from "vitest"
import { postAssignments, postSaturationConfirm, postSaturationRun } from "./assignment-actions"
import type { AssignmentMeeting } from "./forced-assignment"

const meeting = {
  id: "forced-b1-e1-slot",
  exhibitorId: "e1",
  buyerId: "b1",
  slotId: "2026-10-20T10:00",
  status: "accepted",
  matchingType: "forced",
} as AssignmentMeeting

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn(async () =>
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
  ) as unknown as typeof fetch
}

afterEach(() => vi.restoreAllMocks())

describe("postAssignments — 실패 해석", () => {
  it("2xx면 성공", async () => {
    mockFetch(200, { success: true, ids: ["m-1"] })
    expect(await postAssignments([meeting])).toEqual({ success: true })
  })

  it("BFF가 내려준 code·message·busyRoles·savedCount를 그대로 싣는다(모르는 역할 값은 버린다)", async () => {
    mockFetch(409, {
      success: false,
      error: "SLOT_TAKEN",
      message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["buyer", "organizer"],
      savedCount: 2,
    })

    expect(await postAssignments([meeting])).toEqual({
      success: false,
      error: "SLOT_TAKEN",
      message: "바이어가 해당 시간에 이미 확정된 미팅이 있습니다.",
      busyRoles: ["buyer"],
      savedCount: 2,
    })
  })

  it("fetch 자체가 던지면 — 그때만 network", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch

    expect(await postAssignments([meeting])).toEqual({ success: false, error: "network" })
  })

  it("서버가 JSON이 아닌 오류를 주면 server_error — network가 아니다", async () => {
    mockFetch(500, "<html>Internal Server Error</html>")

    expect(await postAssignments([meeting])).toEqual({ success: false, error: "server_error" })
  })
})

describe("포화배정 실행·확정 — 같은 실패 해석", () => {
  it("postSaturationRun은 백엔드 이유를 싣는다", async () => {
    mockFetch(409, {
      success: false,
      error: "EVENT_SCHEDULE_UNSET",
      message: "행사 운영시간이 설정되지 않아 미팅 슬롯을 만들 수 없습니다(운영자 설정 필요).",
    })

    expect(
      await postSaturationRun({
        settings: {
          startTime: "10:00",
          endTime: "18:10",
          slotMinutes: 40,
          slotGapMinutes: 5,
          lunchStart: "12:10",
          lunchEnd: "13:00",
          minSlots: 10,
          maxMeetingMinutes: 90,
        },
        assignMinutes: 40,
        runNumber: 1,
        now: { date: "2026-10-01", time: "09:00" },
      }),
    ).toEqual({
      success: false,
      error: "EVENT_SCHEDULE_UNSET",
      message: "행사 운영시간이 설정되지 않아 미팅 슬롯을 만들 수 없습니다(운영자 설정 필요).",
    })
  })

  it("postSaturationConfirm 실패도 code·message를 싣는다", async () => {
    mockFetch(409, { success: false, error: "RUN_NOT_DRAFT", message: "이미 'confirmed' 상태인 run입니다." })

    expect(await postSaturationConfirm([meeting])).toEqual({
      success: false,
      error: "RUN_NOT_DRAFT",
      message: "이미 'confirmed' 상태인 run입니다.",
    })
  })
})
