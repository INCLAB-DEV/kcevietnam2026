import { afterEach, describe, expect, it, vi } from "vitest"
import { cancelAssignedMeeting } from "./meeting-actions"

// 운영자 전용 취소 seam — lib/meeting/meeting-actions.test.ts와 같은 패턴. 참가자 취소
// (/api/meetings/{id}/cancel)와 다른 경로(/api/organizer/meetings/{id}/cancel)로 보내는지가
// 이 모듈의 핵심 계약(QA 3차 #1 — 운영자가 참가자 경로를 쓰면 403이 나던 문제의 수정).

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("cancelAssignedMeeting — 운영자 전용 BFF로 보낸다", () => {
  it("참가자 경로(/api/meetings)가 아니라 /api/organizer/meetings/{id}/cancel로 POST한다", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await cancelAssignedMeeting("mtg-1", "schedule_conflict", "장비 고장")

    expect(result).toEqual({ success: true })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/organizer/meetings/mtg-1/cancel")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(init?.body as string)).toEqual({
      reason_code: "schedule_conflict",
      reason_text: "장비 고장",
    })
  })

  it("실패하면 백엔드 detail(code/message)을 그대로 돌려준다", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { code: "FORBIDDEN", message: "권한이 없어요" } }), {
          status: 403,
        }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await cancelAssignedMeeting("mtg-1", "other")

    expect(result).toEqual({
      success: false,
      errorCode: "FORBIDDEN",
      message: "권한이 없어요",
      existingMeetingId: undefined,
    })
  })
})
