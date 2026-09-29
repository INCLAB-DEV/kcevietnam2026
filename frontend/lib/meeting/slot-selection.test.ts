import { describe, it, expect } from "vitest"
import { durationLabel, slotRangeLabel, toggleSlot } from "./slot-selection"
import type { SlotShape } from "./slot-selection"
import type { TimeSlot } from "./types"

// 10:00~12:00 중 11:00만 불가인 단순 슬롯 묶음.
const SLOTS: TimeSlot[] = [
  { id: "s-1000", time: "10:00", available: true },
  { id: "s-1030", time: "10:30", available: true },
  { id: "s-1100", time: "11:00", available: false },
  { id: "s-1130", time: "11:30", available: true },
  { id: "s-1200", time: "12:00", available: true },
]

// 기존 30분/텀0/상한90 픽스처 — 현행 동작(하위호환)의 기준.
const SHAPE30: SlotShape = { slotMinutes: 30, slotGapMinutes: 0, maxMeetingMinutes: 90 }

// 발주사 운영표 격자(40분 상담 + 5분 텀 + 점심 12:10~13:00, 상한 90분).
const GRID40: TimeSlot[] = [
  { id: "s-1000", time: "10:00", available: true },
  { id: "s-1045", time: "10:45", available: true },
  { id: "s-1130", time: "11:30", available: true },
  { id: "s-1300", time: "13:00", available: true },
  { id: "s-1345", time: "13:45", available: true },
]
const SHAPE40: SlotShape = { slotMinutes: 40, slotGapMinutes: 5, maxMeetingMinutes: 90 }

describe("toggleSlot (연속 선택 규칙, F-MT-001 D4 — 상한은 분(maxMeetingMinutes), 칸 수 아님)", () => {
  it("빈 선택에서 가용 슬롯을 누르면 선택된다", () => {
    expect(toggleSlot(SLOTS, [], "s-1000", SHAPE30)).toEqual(["s-1000"])
  })

  it("불가 슬롯은 선택되지 않는다", () => {
    expect(toggleSlot(SLOTS, ["s-1000"], "s-1100", SHAPE30)).toEqual(["s-1000"])
  })

  it("인접 슬롯은 연속으로 확장된다", () => {
    expect(toggleSlot(SLOTS, ["s-1000"], "s-1030", SHAPE30)).toEqual(["s-1000", "s-1030"])
  })

  it("최대 3개까지만 확장하고, 그 이상은 새 선택으로 시작한다", () => {
    const three = ["s-1000", "s-1030", "s-1130"]
    // 1030~1200은 1100 불가라 연속 불가 → 새 선택. 대신 길이 3(스팬 90분)에서 확장 시도는 상한 초과라 거부.
    expect(toggleSlot(SLOTS, three, "s-1200", SHAPE30)).toEqual(["s-1200"])
  })

  it("떨어진 슬롯을 누르면 새 선택으로 시작한다", () => {
    expect(toggleSlot(SLOTS, ["s-1000"], "s-1130", SHAPE30)).toEqual(["s-1130"])
  })

  it("가장자리 슬롯은 해제되고, 중간 슬롯은 해제되지 않는다", () => {
    const three = ["s-1000", "s-1030", "s-1130"]
    expect(toggleSlot(SLOTS, three, "s-1000", SHAPE30)).toEqual(["s-1030", "s-1130"]) // 앞 가장자리
    expect(toggleSlot(SLOTS, three, "s-1130", SHAPE30)).toEqual(["s-1000", "s-1030"]) // 뒤 가장자리
    expect(toggleSlot(SLOTS, three, "s-1030", SHAPE30)).toEqual(three) // 중간 → 불변
  })
})

describe("toggleSlot (40분/텀5분 격자 — 점심 횡단은 stride 인접성으로 자동 차단)", () => {
  it("② 2칸 스팬 85분은 허용된다", () => {
    expect(toggleSlot(GRID40, ["s-1000"], "s-1045", SHAPE40)).toEqual(["s-1000", "s-1045"])
  })

  it("③ 3칸 스팬 130분은 상한(90분) 초과라 거부되고 새 선택으로 시작한다", () => {
    const two = ["s-1000", "s-1045"]
    expect(toggleSlot(GRID40, two, "s-1130", SHAPE40)).toEqual(["s-1130"])
  })

  it("④ 11:30과 13:00은 사이에 점심이 있어 이어 붙일 수 없다(stride=45 ≠ 90분 격차)", () => {
    expect(toggleSlot(GRID40, ["s-1130"], "s-1300", SHAPE40)).toEqual(["s-1300"])
  })
})

describe("durationLabel / slotRangeLabel", () => {
  it("슬롯 개수를 길이 문구로 바꾼다(30분/텀0 — 기존 기대값 유지)", () => {
    expect(durationLabel(1, SHAPE30)).toBe("30분")
    expect(durationLabel(2, SHAPE30)).toBe("1시간")
    expect(durationLabel(3, SHAPE30)).toBe("1시간 30분")
  })

  it("슬롯 개수를 길이 문구로 바꾼다(40분/텀5)", () => {
    expect(durationLabel(1, SHAPE40)).toBe("40분")
    expect(durationLabel(2, SHAPE40)).toBe("1시간 25분") // 85분
  })

  it("선택 범위를 시작-끝·길이로 요약한다", () => {
    expect(slotRangeLabel(SLOTS, ["s-1000", "s-1030"], SHAPE30)).toEqual({
      range: "10:00 - 11:00",
      duration: "1시간",
    })
    expect(slotRangeLabel(SLOTS, [], SHAPE30)).toBeNull()
  })

  it("① 40분 상담 1칸의 range가 30분 하드코딩 없이 10:40에서 끝난다(회귀 방지)", () => {
    expect(slotRangeLabel(GRID40, ["s-1000"], SHAPE40)).toEqual({
      range: "10:00 - 10:40",
      duration: "40분",
    })
  })
})
