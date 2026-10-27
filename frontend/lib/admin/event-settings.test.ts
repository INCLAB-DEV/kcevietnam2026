import { describe, expect, it } from "vitest"
import {
  changedSettingsFields,
  countMisalignedSlots,
  rebaseSettingsDraft,
  settingsPatchOf,
  isEventDate,
  isParticipantMenu,
  isSlotMinutes,
  isVenueType,
  toggleVenueType,
  validateEvent,
  validateEventSettings,
} from "./event-settings"
import { SLOT_MINUTES_OPTIONS, VENUE_TYPES, type AdminEvent, type AdminEventSettings } from "./types"

// 검증기가 둘인 이유는 엔드포인트가 둘이기 때문이다:
//   validateEventSettings → PATCH /events/{id}/settings (슬롯 길이·장소유형·동일역할)
//   validateEvent         → PATCH /events/{id}          (이름·장소·전시기간·신청기간)

const SETTINGS: AdminEventSettings = {
  event_id: "evt-test",
  slot_minutes: 30,
  enabled_venue_types: ["booth", "zone_table"],
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

const EVENT: Omit<AdminEvent, "id"> = {
  name: "테스트 전시 2026",
  name_en: "Test Expo 2026",
  venue_name: "테스트 전시장",
  exhibition_start: "2026-09-16",
  exhibition_end: "2026-09-18",
  application_start: "2026-08-26",
  application_end: "2026-09-11",
  timezone: "Asia/Ho_Chi_Minh",
}

describe("slot_minutes 검증", () => {
  it("허용값은 10 / 20 / 30 / 40 / 60 뿐이다", () => {
    expect(SLOT_MINUTES_OPTIONS).toEqual([10, 20, 30, 40, 60])
    for (const v of SLOT_MINUTES_OPTIONS) expect(isSlotMinutes(v)).toBe(true)
  })

  it("허용값 밖의 숫자·타입은 거른다", () => {
    for (const v of [0, 15, 45, 90, -30, 30.5, "30", null, undefined]) {
      expect(isSlotMinutes(v)).toBe(false)
    }
  })

  it("허용값으로 바꾸면 통과한다", () => {
    for (const v of SLOT_MINUTES_OPTIONS) {
      const result = validateEventSettings(SETTINGS, { slot_minutes: v })
      expect(result.valid).toBe(true)
      if (result.valid) expect(result.settings.slot_minutes).toBe(v)
    }
  })

  it("허용값 밖이면 slot-minutes-invalid 로 막는다", () => {
    // 타입 시스템 밖(런타임 유입: API 응답·폼 파싱)을 가정한 캐스팅.
    const result = validateEventSettings(SETTINGS, {
      slot_minutes: 45 as unknown as AdminEventSettings["slot_minutes"],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("slot-minutes-invalid")
  })
})

describe("장소 유형 정책 (enabled_venue_types)", () => {
  it("백엔드 확정 문자열 값을 쓴다 — booth / zone_table / business_room", () => {
    expect(VENUE_TYPES).toEqual(["booth", "zone_table", "business_room"])
    for (const v of VENUE_TYPES) expect(isVenueType(v)).toBe(true)
    expect(isVenueType("matching_zone")).toBe(false)
  })

  it("전부 끄면 막는다 — 장소 없는 미팅은 배정할 수 없다", () => {
    const result = validateEventSettings(SETTINGS, { enabled_venue_types: [] })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("venue-types-empty")
  })

  it("부스만 켠 설정(해외 행사)은 유효하다", () => {
    const result = validateEventSettings(SETTINGS, { enabled_venue_types: ["booth"] })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.settings.enabled_venue_types).toEqual(["booth"])
  })

  it("저장 시 순서를 정규화하고 중복을 제거한다", () => {
    const result = validateEventSettings(SETTINGS, {
      enabled_venue_types: ["business_room", "booth", "booth"],
    })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.settings.enabled_venue_types).toEqual(["booth", "business_room"])
  })

  it("토글은 마지막 1개를 끄지 못한다", () => {
    expect(toggleVenueType(["booth"], "booth")).toEqual(["booth"])
    expect(toggleVenueType(["booth", "zone_table"], "booth")).toEqual(["zone_table"])
    expect(toggleVenueType(["booth"], "business_room")).toEqual(["booth", "business_room"])
  })
})

describe("동일 역할 상호 열람", () => {
  it("기본은 꺼짐이고, 켜도 다른 규칙을 깨지 않는다", () => {
    expect(SETTINGS.allow_same_role_discovery).toBe(false)
    const result = validateEventSettings(SETTINGS, { allow_same_role_discovery: true })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.settings.allow_same_role_discovery).toBe(true)
  })
})

describe("행사 날짜 검증 (validateEvent)", () => {
  it("YYYY-MM-DD 형식이고 실재하는 날짜만 통과", () => {
    expect(isEventDate("2026-08-26")).toBe(true)
    for (const v of ["2026-13-01", "2026-02-30", "26-08-26", "2026/08/26", "", null]) {
      expect(isEventDate(v)).toBe(false)
    }
  })

  it("기본 행사는 유효하다", () => {
    expect(validateEvent(EVENT, {}).valid).toBe(true)
  })

  it("행사명이 비면 막는다", () => {
    const result = validateEvent(EVENT, { name: "   " })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("name-required")
  })

  it("신청기간 역전을 막는다", () => {
    const result = validateEvent(EVENT, {
      application_start: "2026-09-20",
      application_end: "2026-09-11",
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("application-period-reversed")
  })

  it("전시기간 역전을 막는다", () => {
    const result = validateEvent(EVENT, {
      exhibition_start: "2026-09-20",
      exhibition_end: "2026-09-18",
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("exhibition-period-reversed")
  })

  it("시작 == 종료(하루짜리)는 허용", () => {
    expect(
      validateEvent(EVENT, { application_start: "2026-09-01", application_end: "2026-09-01" })
        .valid,
    ).toBe(true)
  })

  it("여러 규칙이 동시에 깨지면 전부 보고한다", () => {
    const result = validateEvent(EVENT, {
      name: "",
      application_start: "not-a-date",
      exhibition_end: "2026-01-01",
    })
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors).toContain("name-required")
    expect(result.errors).toContain("application-start-invalid")
    expect(result.errors).toContain("exhibition-period-reversed")
  })

  it("저장 시 행사명 공백을 다듬는다", () => {
    const result = validateEvent(EVENT, { name: "  여백 전시  " })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.event.name).toBe("여백 전시")
  })
})

describe("슬롯 길이 변경 시 기존 불가 시간대 정합성", () => {
  it("새 격자(유효 시각 목록)에 없는 시각을 어긋난 것으로 센다", () => {
    const slots = ["2026-09-16T09:00", "2026-09-16T09:30", "2026-09-16T10:00"]
    expect(countMisalignedSlots(slots, ["09:00", "09:30", "10:00"])).toBe(0) // 전부 격자 안
    expect(countMisalignedSlots(slots, ["09:00", "10:00"])).toBe(1) // 09:30 이 격자 밖
  })

  // 계약서 §3.10 — 예전 "자정 기준 모듈로"는 앵커가 10:00인 45분 피치 격자에서 10:00 자체를
  // 어긋남으로 오판했다(600%45=15≠0). 실제 격자(schedule.slotTimes 결과)와 직접 대조하면 이런
  // 오판이 생길 수 없다 — 40분 상담+5분 텀 격자에서 10:40(어긋난 시각)만 걸러진다.
  it("stride 격자에서도 실제 격자와 대조해 정확히 판정한다(자정 기준 모듈로 재발명 아님)", () => {
    const validTimes = ["10:00", "10:45", "11:30"] // 10:00 앵커, 40분/5분텀
    const slots = ["2026-10-20T10:00", "2026-10-20T10:40", "2026-10-20T11:30"]
    expect(countMisalignedSlots(slots, validTimes)).toBe(1) // 10:40만 어긋남(정상은 10:45)
  })

  it("망가진 슬롯 id는 어긋난 것으로 센다", () => {
    expect(countMisalignedSlots(["broken"], ["09:00"])).toBe(1)
  })
})

describe("slot_gap_minutes / max_meeting_minutes 검증 (계약서 §3.1)", () => {
  it("slot_gap_minutes는 0~30분만 허용한다", () => {
    expect(validateEventSettings(SETTINGS, { slot_gap_minutes: 5 }).valid).toBe(true)
    expect(validateEventSettings(SETTINGS, { slot_gap_minutes: 0 }).valid).toBe(true)
    expect(validateEventSettings(SETTINGS, { slot_gap_minutes: 30 }).valid).toBe(true)
    const tooBig = validateEventSettings(SETTINGS, { slot_gap_minutes: 31 })
    expect(tooBig.valid).toBe(false)
    if (!tooBig.valid) expect(tooBig.errors).toContain("slot-gap-invalid")
    const negative = validateEventSettings(SETTINGS, { slot_gap_minutes: -1 })
    expect(negative.valid).toBe(false)
    if (!negative.valid) expect(negative.errors).toContain("slot-gap-invalid")
  })

  it("max_meeting_minutes는 10~480분만 허용한다", () => {
    expect(validateEventSettings(SETTINGS, { max_meeting_minutes: 90 }).valid).toBe(true)
    expect(validateEventSettings(SETTINGS, { max_meeting_minutes: 10 }).valid).toBe(true)
    expect(validateEventSettings(SETTINGS, { max_meeting_minutes: 480 }).valid).toBe(true)
    const tooSmall = validateEventSettings(SETTINGS, { max_meeting_minutes: 9 })
    expect(tooSmall.valid).toBe(false)
    if (!tooSmall.valid) expect(tooSmall.errors).toContain("max-meeting-invalid")
    const tooBig = validateEventSettings(SETTINGS, { max_meeting_minutes: 481 })
    expect(tooBig.valid).toBe(false)
    if (!tooBig.valid) expect(tooBig.errors).toContain("max-meeting-invalid")
  })
})

// 참가자 메뉴(F-NV-001 D15) — 참가사·바이어 화면의 왼쪽 메뉴 구성. 저장은 어휘 안의 값만 보낸다.
describe("participant_menu 검증", () => {
  it("어휘는 meetings_only / full 둘뿐이다", () => {
    for (const v of ["meetings_only", "full"]) expect(isParticipantMenu(v)).toBe(true)
    for (const v of ["", "FULL", "none", "meetings-only", null, undefined, 0, true]) {
      expect(isParticipantMenu(v)).toBe(false)
    }
  })

  it("두 값 모두 통과하고 그대로 저장 대상이 된다", () => {
    for (const v of ["meetings_only", "full"] as const) {
      const result = validateEventSettings(SETTINGS, { participant_menu: v })
      expect(result.valid).toBe(true)
      if (result.valid) expect(result.settings.participant_menu).toBe(v)
    }
  })

  it("어휘 밖이면 participant-menu-invalid 로 막는다", () => {
    // 타입 시스템 밖(런타임 유입)을 가정한 캐스팅.
    const result = validateEventSettings(SETTINGS, {
      participant_menu: "everything" as unknown as AdminEventSettings["participant_menu"],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(["participant-menu-invalid"])
  })

  it("다른 설정만 바꿀 때 메뉴 값은 그대로 유지된다", () => {
    const current: AdminEventSettings = { ...SETTINGS, participant_menu: "full" }
    const result = validateEventSettings(current, { slot_gap_minutes: 5 })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.settings.participant_menu).toBe("full")
  })
})

// 참가자 알림 메일(nt004mail0001) — 저장은 true/false만 보낸다(백엔드 StrictBool과 같은 규칙).
describe("participant_email_enabled 검증", () => {
  it("true·false 모두 통과하고 그대로 저장 대상이 된다", () => {
    for (const v of [true, false]) {
      const result = validateEventSettings(SETTINGS, { participant_email_enabled: v })
      expect(result.valid).toBe(true)
      if (result.valid) expect(result.settings.participant_email_enabled).toBe(v)
    }
  })

  it("불리언이 아니면 participant-email-invalid 로 막는다", () => {
    for (const bad of [null, undefined, "false", 0, 1]) {
      // 타입 시스템 밖(런타임 유입)을 가정한 캐스팅.
      const result = validateEventSettings(SETTINGS, {
        participant_email_enabled: bad as unknown as boolean,
      })
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.errors).toEqual(["participant-email-invalid"])
    }
  })

  it("다른 설정만 바꿀 때 꺼 둔 값이 그대로 유지된다", () => {
    const current: AdminEventSettings = { ...SETTINGS, participant_email_enabled: false }
    const result = validateEventSettings(current, { slot_gap_minutes: 5 })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.settings.participant_email_enabled).toBe(false)
  })
})

// 부분 저장 — 바뀐 필드만 PATCH에 싣는다(오래 열어 둔 탭이 다른 마스터의 변경을 되돌리지 않게).
describe("바뀐 필드만 저장", () => {
  it("바뀐 필드만 고른다 — 배열은 순서까지, 점심은 null과 빈 문자열을 같게 본다", () => {
    expect(changedSettingsFields(SETTINGS, { ...SETTINGS })).toEqual([])
    expect(
      changedSettingsFields(SETTINGS, { ...SETTINGS, slot_minutes: 20, participant_email_enabled: false }),
    ).toEqual(["slot_minutes", "participant_email_enabled"])
    expect(
      changedSettingsFields(SETTINGS, {
        ...SETTINGS,
        enabled_venue_types: [...SETTINGS.enabled_venue_types].reverse(),
      }),
    ).toEqual(["enabled_venue_types"]) // ["booth","zone_table"] → 뒤집으면 순서가 다르다
    const noLunch: AdminEventSettings = { ...SETTINGS, lunch_start: null }
    expect(changedSettingsFields(noLunch, { ...noLunch, lunch_start: "" as unknown as null })).toEqual([])
    // 이 화면이 다루지 않는 필드(min_guaranteed_slots)는 보지 않는다.
    expect(changedSettingsFields(SETTINGS, { ...SETTINGS, min_guaranteed_slots: 3 })).toEqual([])
  })

  it("PATCH 본문은 고른 필드만", () => {
    expect(
      settingsPatchOf({ ...SETTINGS, slot_minutes: 20 }, ["slot_minutes"]),
    ).toEqual({ slot_minutes: 20 })
  })

  it("새 서버 값 위에 운영자가 바꾼 필드만 다시 얹는다", () => {
    const base = SETTINGS
    const draft: AdminEventSettings = { ...SETTINGS, slot_minutes: 20 } // 운영자는 슬롯만 바꿨다
    const fresh: AdminEventSettings = { ...SETTINGS, participant_email_enabled: false, participant_menu: "full" }
    const rebased = rebaseSettingsDraft(draft, base, fresh)
    expect(rebased.slot_minutes).toBe(20) // 운영자의 변경은 남는다
    expect(rebased.participant_email_enabled).toBe(false) // 손대지 않은 필드는 서버 값
    expect(rebased.participant_menu).toBe("full")
  })
})
