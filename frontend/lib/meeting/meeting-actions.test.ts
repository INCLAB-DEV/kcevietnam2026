import { afterEach, describe, expect, it, vi } from "vitest"
import { acceptMeeting, cancelMeeting, createMeeting, isMeetingHttpMode, rejectMeeting } from "./meeting-actions"

// 미팅 뮤테이션 클라 seam — lib/admin/admin-actions.test.ts와 같은 패턴이되, 모드 게이팅은 이
// 모듈이 아니라 호출부(모달/패널)가 한다(각 컴포넌트 테스트가 검증) — 여기선 요청 조립과 에러
// 매핑만 검증한다.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("실연동 모드 판정", () => {
  it("NEXT_PUBLIC_AUTH_CLIENT=http 일 때만 실연동이다", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    expect(isMeetingHttpMode()).toBe(true)
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "")
    expect(isMeetingHttpMode()).toBe(false)
  })
})

describe("createMeeting — 같은 출처 BFF로 계약을 조립해 보낸다", () => {
  it("venue_type은 호출부가 넘긴 캐노니컬 값 그대로, venue_label도 그대로 실어 보낸다(H-02). date_id는 안 보낸다", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "mtg-1" }), { status: 201 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createMeeting({
      counterpartOrgId: "org-exh",
      slotIds: ["2026-09-16T10:00"],
      venueType: "zone_table",
      venueLabel: "T-01",
      reason: "안녕하세요",
      myRole: "buyer",
    })

    expect(result).toEqual({ success: true })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/meetings")
    expect(init?.method).toBe("POST")
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({
      counterpart_org_id: "org-exh",
      slot_ids: ["2026-09-16T10:00"],
      venue_type: "zone_table",
      venue_label: "T-01",
      request_reason: "안녕하세요",
      my_role: "buyer",
    })
    expect(body.date_id).toBeUndefined()
  })

  it("venueLabel을 안 넘기면 venue_label 필드 자체를 안 보낸다(부스 등 자동 배정 경로)", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "mtg-1" }), { status: 201 }))
    vi.stubGlobal("fetch", fetchSpy)

    await createMeeting({
      counterpartOrgId: "org-exh",
      slotIds: ["2026-09-16T10:00"],
      venueType: "booth",
    })

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(body.venue_label).toBeUndefined()
  })

  it("SLOT_TAKEN 실패는 code/message로 드러난다", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { code: "SLOT_TAKEN", message: "해당 시간에 이미 확정된 미팅이 있습니다." } }), {
          status: 409,
        }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createMeeting({
      counterpartOrgId: "org-exh",
      slotIds: ["2026-09-16T10:00"],
      venueType: "booth",
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("SLOT_TAKEN")
    expect(result.message).toBe("해당 시간에 이미 확정된 미팅이 있습니다.")
  })

  // #11에서 쌍 단위 중복 차단이 폐기되고 (쌍, 시각) 단위 중복만 남았다 —
  // 같은 상대에게 같은 시각으로 두 번 신청할 때만 409 DUPLICATE_APPLICATION이 온다.
  it("DUPLICATE_APPLICATION은 existing_meeting_id를 실어 되돌려준다", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              code: "DUPLICATE_APPLICATION",
              message: "같은 시간으로 이미 신청한 미팅이 있습니다.",
              existing_meeting_id: "mtg-existing",
            },
          }),
          { status: 409 },
        ),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createMeeting({ counterpartOrgId: "org-exh", slotIds: ["x"], venueType: "booth" })

    expect(result.errorCode).toBe("DUPLICATE_APPLICATION")
    expect(result.existingMeetingId).toBe("mtg-existing")
  })
})

describe("accept/reject/cancel — 경로·바디", () => {
  it("accept는 바디 없이 POST /api/meetings/{id}/accept", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await acceptMeeting("mtg-1")

    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/meetings/mtg-1/accept")
    expect(init?.method).toBe("POST")
    expect(init?.body).toBeUndefined()
  })

  it("reject는 reason_code/reason_text를 실어 보낸다", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await rejectMeeting("mtg-1", "other", "일정이 안 맞아요")

    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/meetings/mtg-1/reject")
    expect(JSON.parse(init?.body as string)).toEqual({
      reason_code: "other",
      reason_text: "일정이 안 맞아요",
    })
  })

  it("cancel도 같은 형태로 /cancel에 보낸다", async () => {
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await cancelMeeting("mtg-1", "schedule_conflict")

    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/meetings/mtg-1/cancel")
    expect(JSON.parse(init?.body as string)).toEqual({
      reason_code: "schedule_conflict",
      reason_text: undefined,
    })
  })
})
