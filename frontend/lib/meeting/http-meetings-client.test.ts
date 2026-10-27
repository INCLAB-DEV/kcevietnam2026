import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fetchMeetingAvailability,
  fetchMeetingById,
  fetchMyMeetings,
  toMeetingAvailability,
  toMeetingRecord as toMeetingRecordWith,
} from "./http-meetings-client"
import { koTranslator } from "@/lib/i18n/ko-translator"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"

// 장소 유형 라벨러는 toMeetingRecord의 필수 인자다(문구는 messages의 meeting.venueType). 아래 단정은
// 한국어 라벨 기준이라 ko 카탈로그에 물린 라벨러를 고정해 넘긴다.
const koVenueTypeT = koTranslator("meeting.venueType")
const toMeetingRecord = (m: Parameters<typeof toMeetingRecordWith>[0]) =>
  toMeetingRecordWith(m, (venueType) => koVenueTypeT(venueType))

const { cookiesMock, getLocaleMock } = vi.hoisted(() => ({ cookiesMock: vi.fn(), getLocaleMock: vi.fn() }))

vi.mock("next/headers", () => ({ cookies: cookiesMock }))
// 목록·단건 조회는 요청의 화면 로케일(next-intl)을 읽는다 — 테스트에서는 값만 갈아끼운다. 장소 유형 번역기는
// 여기서 보는 대상이 아니라 키를 그대로 돌려주는 것으로 충분하다.
vi.mock("next-intl/server", () => ({
  getLocale: getLocaleMock,
  getTranslations: async () => Object.assign((key: string) => key, { has: () => true }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  cookiesMock.mockReset()
  getLocaleMock.mockReset()
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
          badge: { text: "불가능", tone: "unavailable" },
          numbers: [{ value: "T-01", available: true }],
          selectable: false,
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
    // 예약을 받지 않는 장소는 selectable=false로 그대로 전달된다(화면이 disabled로 그린다).
    expect(availability.venues[1].selectable).toBe(false)
    // 필드가 없는 구버전 응답은 "고를 수 있다"로 본다 — 없는 정책으로 화면을 잠그지 않는다.
    expect(availability.venues[0].selectable).toBe(true)
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

// 목록·단건의 상대 기업명과 장소 라벨은 백엔드가 `?locale=`을 보고 고른다(en이면 name_en·"Hall 7 A-12").
// 이 쿼리가 빠지면 백엔드는 ko로 답하고, en 화면의 미팅 카드에 국문 기업명과 "7홀 A-12"가 조용히 돌아온다.
describe("미팅 목록·단건 조회 — 화면 로케일 전달", () => {
  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const urlOf = (fetchMock: ReturnType<typeof vi.fn>, index: number) => String(fetchMock.mock.calls[index]?.[0])

  it("en 화면이면 목록과 단건 조회 모두 locale=en을 실어 보낸다", async () => {
    getLocaleMock.mockResolvedValue("en")
    cookiesMock.mockResolvedValue({ get: () => ({ value: "token" }) })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [], total: 0, limit: 100, offset: 0 }))
      .mockResolvedValueOnce(okJson({ id: "mtg-1", status: "proposed", scheduled_start: null }))
    vi.stubGlobal("fetch", fetchMock)

    await fetchMyMeetings()
    await fetchMeetingById("mtg-1")

    expect(urlOf(fetchMock, 0)).toMatch(/\/api\/meetings\?limit=100&locale=en$/)
    expect(urlOf(fetchMock, 1)).toMatch(/\/api\/meetings\/mtg-1\?locale=en$/)
  })

  it("한국어 화면은 locale=ko, 지원하지 않는 값도 ko로 접어 보낸다", async () => {
    cookiesMock.mockResolvedValue({ get: () => ({ value: "token" }) })
    const fetchMock = vi.fn().mockResolvedValue(okJson({ items: [], total: 0, limit: 100, offset: 0 }))
    vi.stubGlobal("fetch", fetchMock)

    getLocaleMock.mockResolvedValue("ko")
    await fetchMyMeetings()
    getLocaleMock.mockResolvedValue("fr")
    await fetchMyMeetings()

    expect(urlOf(fetchMock, 0)).toMatch(/\?limit=100&locale=ko$/)
    expect(urlOf(fetchMock, 1)).toMatch(/\?limit=100&locale=ko$/)
  })
})
