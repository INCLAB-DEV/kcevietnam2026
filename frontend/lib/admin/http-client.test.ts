import { describe, expect, it } from "vitest"
import { BUSINESS_FIELD_LABELS, labelsFor } from "@/lib/bm/fields"
import {
  toAdminEvent,
  toAdminEventSettings,
  toAdminMeeting,
  toAdminOrganization,
  toAdminVenue,
} from "./http-client"

// 실 백엔드(FastAPI /api/admin/*)가 내려주는 확정 응답 페이로드로 매핑을 고정하는 계약 테스트 —
// 백엔드 응답 형상이 바뀌면 여기가 먼저 깨진다(화면까지 가기 전에).

describe("백엔드 응답 → 콘솔 타입 매핑", () => {
  // 실제 GET /api/admin/events 응답 1건(데모 행사 시드 기준).
  const REAL_EVENT_PAYLOAD = {
    id: "00000000-0000-0000-0000-0000000000de",
    name: "KADEX with DX Korea 2026",
    name_en: "KADEX with DX Korea 2026",
    slug: "dx-korea-2026",
    venue_name: "KINTEX",
    exhibition_start: "2026-09-16",
    exhibition_end: "2026-09-18",
    application_start: "2026-08-26",
    application_end: "2026-09-11",
    slot_minutes: 30,
    enabled_venue_types: ["booth", "zone_table", "business_room"],
    allow_same_role_discovery: false,
  }

  it("행사 응답을 AdminEvent로 매핑한다", () => {
    const event = toAdminEvent(REAL_EVENT_PAYLOAD)
    expect(event.id).toBe("00000000-0000-0000-0000-0000000000de")
    expect(event.name).toBe("KADEX with DX Korea 2026")
    expect(event.venue_name).toBe("KINTEX")
    expect(event.application_start).toBe("2026-08-26")
    expect(event.application_end).toBe("2026-09-11")
  })

  it("null이 올 수 있는 필드는 빈 문자열로 접는다(폼 기본값)", () => {
    const event = toAdminEvent({ ...REAL_EVENT_PAYLOAD, venue_name: null, exhibition_start: null })
    expect(event.venue_name).toBe("")
    expect(event.exhibition_start).toBe("")
  })

  // 실제 GET /api/admin/events/{id}/organizations 응답의 items[] 원소 형상.
  it("기업 목록 행을 역할 판정과 기본값으로 매핑한다", () => {
    const row = toAdminOrganization(
      {
        id: "org-1",
        name_ko: "테스트기업",
        name_en: null,
        is_exhibitor: true,
        is_buyer: false,
        application_status: "registered",
      },
      REAL_EVENT_PAYLOAD.id,
    )
    expect(row.role).toBe("exhibitor")
    expect(row.event_id).toBe(REAL_EVENT_PAYLOAD.id)
    expect(row.name_ko).toBe("테스트기업")
    expect(row.proxy_written).toBe(false)
    expect(row.unavailable_slots).toEqual([])
  })

  it("admin 목록의 미팅 수·대리작성·분류 코드를 버리지 않는다", () => {
    const row = toAdminOrganization({
      id: "org-enriched",
      name_ko: "합성참가사",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "registered",
      match_count: 7,
      proxy_written_by_organizer_id: "organizer-id",
      content_category: "broadcasting",
      exhibition_categories: ["game_production", "content_production"],
    }, "event-id")

    expect(row.meeting_count).toBe(7)
    expect(row.proxy_written).toBe(true)
    expect(row.business_field_codes).toEqual(["game_production", "content_production"])
    expect(row.content_category).toBe("broadcasting")
  })

  // 회귀(H8, 2026-09-12): unavailable-slots PATCH는 항상 정상 저장됐지만, 이 값을 되돌려줄 GET이
  // 없어 목록 매핑이 항상 []로 굳어 있었다 — "새로고침하면 안 남아 있는" 것처럼 보인 원인.
  it("불가 슬롯 조회 결과를 3번째 인자로 받아 매핑에 반영한다(H8)", () => {
    const row = toAdminOrganization(
      {
        id: "org-1",
        name_ko: "테스트기업",
        name_en: null,
        is_exhibitor: true,
        is_buyer: false,
        application_status: "registered",
      },
      "evt-x",
      ["2026-09-16T09:00", "2026-09-16T09:30"],
    )
    expect(row.unavailable_slots).toEqual(["2026-09-16T09:00", "2026-09-16T09:30"])
  })

  // 회귀(H3, 2026-09-12): 목록 API는 이미 담당자·국가·품목·부스·등록주체를 내려주는데(app.admin.
  // service.list_organizations LEFT JOIN 확장) 이 매핑이 전부 null로 버려 화면·엑셀이 "-"만
  // 보여주던 버그. organizer 콘솔(http-members-client.ts)과 같은 필드를 같은 방식으로 채운다.
  it("담당자·국가·품목·부스·등록주체를 목록 응답에서 채운다(참가사)", () => {
    const row = toAdminOrganization(
      {
        id: "org-3",
        name_ko: "게임기업",
        name_en: null,
        is_exhibitor: true,
        is_buyer: false,
        application_status: "approved",
        created_by_organizer_id: "operator-1",
        contact_name: "김대표",
        contact_email: "rep@game.example",
        contact_phone: "02-1111-2222",
        booth_hall: "9",
        booth_pavilion: "게임관",
        booth_location: "A-101",
        exhibition_categories: ["game_production"],
      },
      "evt-x",
    )
    expect(row.contact_name).toBe("김대표")
    expect(row.contact_email).toBe("rep@game.example")
    expect(row.contact_phone).toBe("02-1111-2222")
    expect(row.booth_label).toBe("9 · 게임관 · A-101")
    expect(row.registered_by).toBe("운영자 등록")
    expect(row.category).toBe(labelsFor(BUSINESS_FIELD_LABELS, ["game_production"]).join(", "))
  })

  it("담당자·국가·품목을 목록 응답에서 채운다(바이어) + 직접 등록은 등록주체가 구분된다", () => {
    const row = toAdminOrganization(
      {
        id: "org-4",
        name_ko: "1등회사inc",
        name_en: null,
        is_exhibitor: false,
        is_buyer: true,
        application_status: "approved",
        created_by_organizer_id: null,
        contact_name: "Jane Doe",
        contact_email: "qwer@qwer.com",
        contact_phone: "024-000-0000",
        country: "vietnam",
        interest_categories: ["content_production"],
      },
      "evt-x",
    )
    expect(row.country).toBe("vietnam")
    expect(row.contact_name).toBe("Jane Doe")
    expect(row.booth_label).toBeNull() // 바이어는 부스가 없다
    expect(row.registered_by).toBe("직접 등록")
    expect(row.category).toBe(labelsFor(BUSINESS_FIELD_LABELS, ["content_production"]).join(", "))
  })

  it("이름 없는 기업도 빈 화면이 되지 않게 폴백한다", () => {
    const row = toAdminOrganization(
      { id: "org-2", name_ko: null, name_en: "Fallback Inc", is_exhibitor: false, is_buyer: true, application_status: "submitted" },
      "evt-x",
    )
    expect(row.name_ko).toBe("Fallback Inc")
    expect(row.role).toBe("buyer")
  })

  // 실제 GET /api/admin/events/{id}/meetings 응답의 items[] 원소 형상.
  it("미팅 행을 콘솔 상태·시각으로 매핑한다", () => {
    const orgNames = new Map([["org-e", "참가사㈜"], ["org-b", "바이어㈜"]])
    const meeting = toAdminMeeting(
      {
        id: "mtg-1",
        exhibitor_org_id: "org-e",
        buyer_org_id: "org-b",
        status: "accepted",
        matching_type: "open",
        scheduled_start: "2026-09-16T10:00:00+09:00",
        scheduled_end: "2026-09-16T10:30:00+09:00",
        venue_id: null,
      },
      REAL_EVENT_PAYLOAD.id,
      orgNames,
      30,
      "Asia/Seoul",
    )
    expect(meeting.status).toBe("scheduled") // proposed/accepted → 예정
    expect(meeting.date).toBe("2026-09-16")
    expect(meeting.start_time).toBe("10:00")
    expect(meeting.slot_minutes).toBe(30) // 시작·종료 실측
    expect(meeting.exhibitor_name).toBe("참가사㈜")
    expect(meeting.buyer_name).toBe("바이어㈜")
    expect(meeting.matching_type).toBe("open")
  })

  // N3 회귀 — 백엔드가 LEFT JOIN으로 venue_type/venue_label을 이미 내려주는데(MeetingListItem),
  // 매핑이 이를 무시하고 "booth"로 하드코딩해 /admin/meetings 장소 컬럼이 zone_table 미팅도 전부
  // "부스"로 보였다(.e2e-artifacts/e2e-verify-round.md N3). 실제 값을 그대로 싣는다.
  it("zone_table 미팅은 실제 장소 유형·라벨(T-01)로 매핑한다", () => {
    const meeting = toAdminMeeting(
      {
        id: "mtg-2",
        exhibitor_org_id: "org-e",
        buyer_org_id: "org-b",
        status: "accepted",
        matching_type: "open",
        scheduled_start: "2026-10-21T14:00:00+09:00",
        venue_id: "venue-1",
        venue_type: "zone_table",
        venue_label: "T-01",
      },
      "evt",
      new Map(),
      30,
      "Asia/Seoul",
    )
    expect(meeting.venue_type).toBe("zone_table")
    expect(meeting.venue_label).toBe("T-01")
  })

  it("장소 미배정(venue_id 없음) 미팅은 여전히 부스로 기본 표시한다", () => {
    const meeting = toAdminMeeting(
      { id: "mtg-3", exhibitor_org_id: "org-e", buyer_org_id: "org-b", status: "accepted", matching_type: "open", venue_id: null },
      "evt",
      new Map(),
      30,
      "Asia/Seoul",
    )
    expect(meeting.venue_type).toBe("booth")
    expect(meeting.venue_label).toBeNull()
  })

  // 강제/포화 배정 배지(components/admin/shared.tsx MatchingTypeBadge)의 근거 데이터 — matching_type이
  // 그대로 실려야 배지가 뜬다.
  it("강제·포화 배정 미팅은 matching_type을 그대로 싣는다", () => {
    const orgNames = new Map<string, string>()
    const forced = toAdminMeeting(
      { id: "m4", exhibitor_org_id: "e", buyer_org_id: "b", status: "accepted", matching_type: "forced" },
      "evt",
      orgNames,
      30,
      "Asia/Ho_Chi_Minh",
    )
    expect(forced.matching_type).toBe("forced")

    const saturation = toAdminMeeting(
      { id: "m5", exhibitor_org_id: "e", buyer_org_id: "b", status: "accepted", matching_type: "ai" },
      "evt",
      orgNames,
      30,
      "Asia/Ho_Chi_Minh",
    )
    expect(saturation.matching_type).toBe("ai")
  })

  it("제안·거절 미팅은 콘솔 상태집합으로 근사 매핑한다", () => {
    const orgNames = new Map<string, string>()
    const proposed = toAdminMeeting(
      { id: "m2", exhibitor_org_id: "e", buyer_org_id: "b", status: "proposed", matching_type: "ai" },
      "evt",
      orgNames,
      30,
      "Asia/Ho_Chi_Minh",
    )
    expect(proposed.status).toBe("scheduled")

    const rejected = toAdminMeeting(
      { id: "m3", exhibitor_org_id: "e", buyer_org_id: "b", status: "rejected", matching_type: "ai" },
      "evt",
      orgNames,
      30,
      "Asia/Ho_Chi_Minh",
    )
    expect(rejected.status).toBe("cancelled")
    expect(rejected.date).toBe("") // 미배정 미팅은 시각 없음
  })

  // 실제 GET /api/admin/events/{id}/venues 응답 원소 형상(VenueOut) — booth는 이 목록에 아예
  // 안 내려온다(백엔드가 zone_table·business_room만 필터링).
  it("장소 행을 그대로 매핑한다(필드가 이미 1:1)", () => {
    const venue = toAdminVenue({
      id: "vn-1",
      event_id: "evt-1",
      venue_type: "zone_table",
      label: "T-01",
      meeting_count: 3,
    })
    expect(venue).toEqual({
      id: "vn-1",
      event_id: "evt-1",
      venue_type: "zone_table",
      label: "T-01",
      meeting_count: 3,
    })
  })

  // 실제 GET /api/admin/events/{id}/settings 응답(EventSettingsOut) — 참가자 알림 메일(nt004mail0001)까지.
  describe("행사 설정 — 참가자 알림 메일", () => {
    const REAL_SETTINGS_PAYLOAD = {
      event_id: "evt-1",
      slot_minutes: 40 as const,
      enabled_venue_types: ["booth" as const],
      allow_same_role_discovery: false,
      operating_start: "10:00:00",
      operating_end: "18:10:00",
      lunch_start: "12:10:00",
      lunch_end: "13:00:00",
      min_guaranteed_slots: 10,
      slot_gap_minutes: 5,
      max_meeting_minutes: 90,
      participant_menu: "meetings_only",
    }

    it("서버 값을 그대로 옮긴다(꺼짐/켜짐)", () => {
      expect(
        toAdminEventSettings({ ...REAL_SETTINGS_PAYLOAD, participant_email_enabled: false })
          .participant_email_enabled,
      ).toBe(false)
      expect(
        toAdminEventSettings({ ...REAL_SETTINGS_PAYLOAD, participant_email_enabled: true })
          .participant_email_enabled,
      ).toBe(true)
    })

    it("값을 알 수 없으면(필드 없음·불리언이 아님) 기본값(꺼짐)으로 읽는다", () => {
      expect(toAdminEventSettings(REAL_SETTINGS_PAYLOAD).participant_email_enabled).toBe(false)
      expect(
        toAdminEventSettings({ ...REAL_SETTINGS_PAYLOAD, participant_email_enabled: null })
          .participant_email_enabled,
      ).toBe(false)
    })
  })
})
