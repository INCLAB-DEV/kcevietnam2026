import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchMeetingAvailability, toMeetingAvailability, toMeetingRecord } from "./http-meetings-client"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"

const { cookiesMock } = vi.hoisted(() => ({ cookiesMock: vi.fn() }))

vi.mock("next/headers", () => ({ cookies: cookiesMock }))

afterEach(() => {
  vi.unstubAllGlobals()
  cookiesMock.mockReset()
})

// 실 백엔드(FastAPI /api/meetings/*)가 내려주는 확정 응답 페이로드로 매핑을 고정하는 계약 테스트 —
// 백엔드 응답 형상이 바뀌면 여기가 먼저 깨진다(화면까지 가기 전에). lib/admin/http-client.test.ts와
// 같은 패턴.

describe("MeetingOut → MeetingRecord", () => {
  const BASE = {
    id: "mtg-1",
    status: "proposed",
    scheduled_start: "2026-09-16T10:00:00+09:00",
    scheduled_end: "2026-09-16T10:30:00+09:00",
    duration_minutes: 30,
    exhibitor_org_id: "org-exh",
    buyer_org_id: "org-buyer",
    requested_by: "buyer" as const,
    requested_by_org_id: "org-buyer",
    counterpart_name: "한빛디펜스",
    venue_type: "booth",
    venue_label: "7홀 A-12",
    has_review: false,
    attended: null,
    request_reason: "협력 논의",
  }

  it("실 응답을 MeetingRecord로 매핑한다(request_reason 포함, H-03)", () => {
    const rec = toMeetingRecord(BASE)
    expect(rec).toEqual<MeetingRecord>({
      id: "mtg-1",
      status: "proposed",
      hasReview: false,
      attended: undefined,
      scheduledAt: "2026-09-16T10:00:00+09:00",
      durationMinutes: 30,
      buyerOrgId: "org-buyer",
      exhibitorOrgId: "org-exh",
      requestedByOrgId: "org-buyer",
      requestedBy: "buyer",
      counterpartName: "한빛디펜스",
      venue: "7홀 A-12",
      requestReason: "협력 논의",
    })
  })

  it("venue_label이 없으면 venue_type의 표시용 기본 라벨로 폴백한다", () => {
    const rec = toMeetingRecord({ ...BASE, venue_label: null, venue_type: "zone_table" })
    expect(rec?.venue).toBe("비즈매칭존 테이블")
  })

  it("장소 정보가 아예 없으면 빈 문자열", () => {
    const rec = toMeetingRecord({ ...BASE, venue_label: null, venue_type: null })
    expect(rec?.venue).toBe("")
  })

  it("requested_by_org_id가 null이면 운영자 배정으로 넓혀 그대로 전달한다(null 유지)", () => {
    const rec = toMeetingRecord({ ...BASE, requested_by: "organizer", requested_by_org_id: null })
    expect(rec?.requestedByOrgId).toBeNull()
    expect(rec?.requestedBy).toBe("organizer")
  })

  it("scheduled_start가 없으면(계약상 이론적 케이스) null을 반환해 호출부가 걸러낸다", () => {
    expect(toMeetingRecord({ ...BASE, scheduled_start: null })).toBeNull()
  })

  it("attended:true/false는 그대로, null은 undefined(participation 무의미)로 넓힌다", () => {
    expect(toMeetingRecord({ ...BASE, attended: false })?.attended).toBe(false)
    expect(toMeetingRecord({ ...BASE, attended: true })?.attended).toBe(true)
    expect(toMeetingRecord({ ...BASE, attended: null })?.attended).toBeUndefined()
  })
})

describe("AvailabilityOut → MeetingAvailability", () => {
  it("캐노니컬 장소 어휘를 모달 UI 계약(VenueKind)으로, numbers[].value를 id/label로 매핑한다", () => {
    const availability = toMeetingAvailability({
      dates: [
        {
          id: "2026-09-16",
          label: "9/16",
          weekday: "수",
          morning: [{ id: "2026-09-16T09:00", time: "09:00", available: true }],
          afternoon: [],
        },
      ],
      venues: [
        { kind: "booth", name: "참가사 부스", description: "부스 설명", badge: { text: "가능", tone: "available" } },
        {
          kind: "zone_table",
          name: "비즈매칭존 테이블",
          description: "테이블 설명",
          badge: { text: "잔여 1석", tone: "limited" },
          numbers: [{ value: "T-01", available: true }],
        },
      ],
      draft_reason: "AI 초안",
      acceptance_mode: "pending",
      slot_minutes: 40,
      slot_gap_minutes: 5,
      max_meeting_minutes: 90,
      timezone: "Asia/Seoul",
    })
    expect(availability.draftReason).toBe("AI 초안")
    expect(availability.acceptanceMode).toBe("pending")
    expect(availability.dates[0].morning[0]).toEqual({ id: "2026-09-16T09:00", time: "09:00", available: true })
    expect(availability.venues[0].kind).toBe("booth")
    expect(availability.venues[1].kind).toBe("table") // zone_table → table(모달 UI 계약)
    expect(availability.venues[1].numbers).toEqual([{ id: "T-01", label: "T-01", available: true }])
    // 격자 모양 세 축(mt003gap0001)이 그대로 전달돼야 모달의 종료 시각·연속 상한 계산이 맞는다.
    expect(availability.slotMinutes).toBe(40)
    expect(availability.slotGapMinutes).toBe(5)
    expect(availability.maxMeetingMinutes).toBe(90)
  })

  it("forwards the current locale to the FastAPI availability endpoint", async () => {
    cookiesMock.mockResolvedValue({ get: () => undefined })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        dates: [],
        venues: [],
        draft_reason: "draft",
        acceptance_mode: "pending",
        slot_minutes: 30,
        timezone: "Asia/Seoul",
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await fetchMeetingAvailability("counterpart-1", "buyer", "en")

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/meetings/availability?counterpart_org_id=counterpart-1&my_role=buyer&locale=en"
    )
  })
})
