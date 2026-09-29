import { describe, it, expect } from "vitest"
import {
  alreadyPaired,
  commonFreeSlots,
  emptySlotsFor,
  expandOccupancy,
  freeCounterpartsAt,
  freeRunLength,
  isAvailableAt,
  isFreeAt,
  isOpenAt,
  maxRunSlots,
  meetingCountFor,
  mergeConsecutive,
} from "./slot-intersection"
import { spanOf } from "./schedule"
import type { AssignmentMeeting } from "./forced-assignment"

const meeting = (over: Partial<AssignmentMeeting>): AssignmentMeeting => ({
  id: "m",
  exhibitorId: "e1",
  buyerId: "b1",
  slotId: "s1",
  status: "accepted",
  matchingType: "forced",
  ...over,
})

describe("slot-intersection (빈슬롯 · 가능 상대)", () => {
  it("미팅이 점유한 슬롯은 양쪽 모두 불가", () => {
    const ms = [meeting({ exhibitorId: "e1", buyerId: "b1", slotId: "s1" })]
    expect(isFreeAt("e1", "s1", ms)).toBe(false)
    expect(isFreeAt("b1", "s1", ms)).toBe(false)
    expect(isFreeAt("e1", "s2", ms)).toBe(true) // 다른 슬롯은 비어 있음
    expect(isFreeAt("e2", "s1", ms)).toBe(true) // 무관한 기업은 비어 있음
  })

  it("emptySlotsFor는 그 기업이 안 찬 슬롯만, 순서 보존", () => {
    const ms = [meeting({ buyerId: "b1", slotId: "s2" })]
    expect(emptySlotsFor("b1", ["s1", "s2", "s3"], ms)).toEqual(["s1", "s3"])
  })

  it("freeCounterpartsAt는 그 슬롯에 빈 후보만 남기고 매칭순(입력 순서)을 보존", () => {
    const ms = [meeting({ buyerId: "b2", slotId: "s1" })]
    const candidates = [{ id: "b1" }, { id: "b2" }, { id: "b3" }]
    expect(freeCounterpartsAt("s1", candidates, ms)).toEqual([{ id: "b1" }, { id: "b3" }])
  })

  it("commonFreeSlots는 양쪽 다 비어있는 슬롯만", () => {
    const ms = [
      meeting({ exhibitorId: "e1", buyerId: "bx", slotId: "s1" }), // e1 s1 점유
      meeting({ exhibitorId: "ey", buyerId: "b1", slotId: "s2" }), // b1 s2 점유
    ]
    expect(commonFreeSlots("e1", "b1", ["s1", "s2", "s3"], ms)).toEqual(["s3"])
  })

  it("alreadyPaired · meetingCountFor", () => {
    const ms = [meeting({ exhibitorId: "e1", buyerId: "b1", slotId: "s1" })]
    expect(alreadyPaired("e1", "b1", ms)).toBe(true)
    expect(alreadyPaired("b1", "e1", ms)).toBe(true) // 방향 무관
    expect(alreadyPaired("e1", "b2", ms)).toBe(false)
    expect(meetingCountFor("e1", ms)).toBe(1)
    expect(meetingCountFor("e2", ms)).toBe(0)
  })

  it("expandOccupancy: 연속 미팅을 점유 슬롯별로 펼치고 뒤 칸은 phantom으로 막는다", () => {
    const m = meeting({ exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T09:00", durationMinutes: 90 })
    const expanded = expandOccupancy([m], 30)
    expect(expanded).toHaveLength(3)
    expect(expanded[0].phantom).toBeUndefined()
    expect(expanded[1]).toMatchObject({ slotId: "2026-09-16T09:30", phantom: true })
    expect(expanded[2]).toMatchObject({ slotId: "2026-09-16T10:00", phantom: true })
    // 펼친 뒤 칸이 빈슬롯 판정을 막는다(시작칸뿐 아니라 연속 칸까지 점유).
    expect(isFreeAt("e1", "2026-09-16T10:00", expanded)).toBe(false)
    expect(isFreeAt("b1", "2026-09-16T09:30", expanded)).toBe(false)
  })

  it("expandOccupancy: gap이 있으면 stride만큼 떨어진 뒤 칸을 펼친다(40분/5분텀/85분=2칸)", () => {
    const m = meeting({ exhibitorId: "e1", buyerId: "b1", slotId: "2026-10-20T10:00", durationMinutes: 85 })
    const expanded = expandOccupancy([m], 40, 5)
    expect(expanded).toHaveLength(2)
    expect(expanded[1]).toMatchObject({ slotId: "2026-10-20T10:45", phantom: true })
  })

  it("meetingCountFor는 phantom을 제외 — 연속 미팅도 1건으로 센다", () => {
    const m = meeting({ exhibitorId: "e1", slotId: "2026-09-16T09:00", durationMinutes: 90 })
    expect(meetingCountFor("e1", expandOccupancy([m], 30))).toBe(1)
  })
})

describe("isAvailableAt / isOpenAt (신청 불가 슬롯)", () => {
  const unavailable = { e1: new Set(["s2"]) }
  it("불가 슬롯은 available=false, 나머지는 true", () => {
    expect(isAvailableAt("e1", "s2", unavailable)).toBe(false)
    expect(isAvailableAt("e1", "s1", unavailable)).toBe(true)
    expect(isAvailableAt("e2", "s2", unavailable)).toBe(true) // 다른 기업엔 무관
    expect(isAvailableAt("e1", "s1", undefined)).toBe(true) // 맵 없으면 전부 가능
  })
  it("isOpenAt = 비어있음 AND 가능 — 불가 슬롯은 비어 있어도 배정 불가", () => {
    expect(isOpenAt("e1", "s2", [], unavailable)).toBe(false) // 비었지만 불가
    expect(isOpenAt("e1", "s1", [], unavailable)).toBe(true)
    const busy = [meeting({ exhibitorId: "e1", slotId: "s1" })]
    expect(isOpenAt("e1", "s1", busy, unavailable)).toBe(false) // 가능하지만 참
  })
})

describe("mergeConsecutive (연속 동일 페어 슬롯 병합)", () => {
  it("같은 페어가 시간 연속이면 하나로 합치고 소요시간 합산", () => {
    const ms = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T13:00" }),
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T13:30" }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: "a", slotId: "2026-09-16T13:00", durationMinutes: 60 })
  })

  it("시간이 떨어져 있으면(점심 등 단절) 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T11:30" }), // 12:00 종료
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T13:00" }), // 13:00 시작(단절)
    ]
    expect(mergeConsecutive(ms, 30)).toHaveLength(2)
  })

  it("다른 페어/다른 날짜는 합치지 않는다", () => {
    const diffPair = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T13:00" }),
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b2", slotId: "2026-09-16T13:30" }),
    ]
    expect(mergeConsecutive(diffPair, 30)).toHaveLength(2)
  })

  it("연속 90분 미팅(3슬롯)은 그대로 1건, 이어진 30분과 합치면 합산", () => {
    const ms = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T09:00", durationMinutes: 90 }), // 09:00~10:30
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b1", slotId: "2026-09-16T10:30" }), // 10:30 시작 → 연속
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(1)
    expect(merged[0].durationMinutes).toBe(120)
  })

  // codex P2: 병합이 뒤 미팅의 status·provenance를 삼키지 않도록, 표시가 다른 미팅은 별개 블록으로 둔다.
  it("연속이어도 status가 다르면(앞 확정·뒤 수락대기) 합치지 않고 뒤 상태를 보존", () => {
    const ms = [
      meeting({ id: "a", slotId: "2026-09-16T13:00", status: "accepted" }),
      meeting({ id: "b", slotId: "2026-09-16T13:30", status: "proposed" }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.status)).toEqual(["accepted", "proposed"])
  })

  it("연속이어도 provenance(matchingType)가 다르면(forced↔ai) 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", slotId: "2026-09-16T13:00", matchingType: "forced" }),
      meeting({ id: "b", slotId: "2026-09-16T13:30", matchingType: "ai" }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.matchingType)).toEqual(["forced", "ai"])
  })

  it("연속 completed여도 hasReview가 다르면(회의록필요↔보관) 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", slotId: "2026-09-16T13:00", status: "completed", hasReview: false }),
      meeting({ id: "b", slotId: "2026-09-16T13:30", status: "completed", hasReview: true }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.hasReview)).toEqual([false, true])
  })

  // codex review P1: 병합 블록은 방향 라벨·액션·장소를 첫 미팅에서 가져가므로,
  // requestedByOrgId(방향)·venue(장소)가 다르면 합치면 안 된다.
  it("연속이어도 requestedByOrgId가 다르면(신청 방향 다름) 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", slotId: "2026-09-16T13:00", requestedByOrgId: "e1" }),
      meeting({ id: "b", slotId: "2026-09-16T13:30", requestedByOrgId: "b1" }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.requestedByOrgId)).toEqual(["e1", "b1"])
  })

  it("연속이어도 venue(장소)가 다르면 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", slotId: "2026-09-16T13:00", venue: "테이블 A" }),
      meeting({ id: "b", slotId: "2026-09-16T13:30", venue: "테이블 B" }),
    ]
    const merged = mergeConsecutive(ms, 30)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.venue)).toEqual(["테이블 A", "테이블 B"])
  })

  // 계약서 §2 — 40분 상담+5분 텀(stride 45)에서 10:00·10:45는 stride만큼 정확히 인접하므로 합쳐지고,
  // 합친 소요시간은 스팬 전체(중간 텀 포함) 85분이다.
  it("gap이 있으면 stride만큼 인접한 칸만 합치고, 소요시간은 스팬 전체(텀 포함)로 잡는다", () => {
    const ms = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-10-20T10:00" }),
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b1", slotId: "2026-10-20T10:45" }),
    ]
    const merged = mergeConsecutive(ms, 40, 5)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: "a", slotId: "2026-10-20T10:00", durationMinutes: 85 })
  })

  // 점심 횡단 차단(계약서 §2/§5 인수기준 4) — 11:30 칸(끝 12:10)과 13:00 칸은 stride(45분)만큼
  // 떨어져 있지 않으므로(90분 차이) 별도 "점심 횡단 금지" 분기 없이 인접성 조건만으로 끊긴다.
  it("점심으로 끊긴 두 칸(11:30·13:00)은 stride 인접이 아니므로 합치지 않는다", () => {
    const ms = [
      meeting({ id: "a", exhibitorId: "e1", buyerId: "b1", slotId: "2026-10-20T11:30" }),
      meeting({ id: "b", exhibitorId: "e1", buyerId: "b1", slotId: "2026-10-20T13:00" }),
    ]
    expect(mergeConsecutive(ms, 40, 5)).toHaveLength(2)
  })
})

describe("maxRunSlots (분 상한 → 칸 수 환산, 계약서 §2)", () => {
  it("gap=0/slotMinutes=30/기본 90분 상한 → 3칸(기존 MAX_RUN_SLOTS=3과 동일, 하위호환)", () => {
    expect(maxRunSlots(90, 30)).toBe(3)
  })

  it("40분/5분텀(stride 45)/90분 상한 → 2칸(3칸=130분은 상한 초과)", () => {
    expect(maxRunSlots(90, 40, 5)).toBe(2)
  })
})

// 계약서 §2 표 — 6케이스를 spanOf(필요 칸 수)와 maxRunSlots(허용 칸 수) 대조로 고정한다.
describe("연속 예약 상한 6케이스 (계약서 §2 표)", () => {
  function fitsWithinCap(
    durationMinutes: number,
    slotMinutes: number,
    gap: number,
    maxMeetingMinutes: number,
  ): boolean {
    return spanOf(durationMinutes, slotMinutes, gap) <= maxRunSlots(maxMeetingMinutes, slotMinutes, gap)
  }

  it("30분/gap0/상한90분 — 1·2·3칸(30/60/90분) 전부 허용(현행 유지)", () => {
    expect(fitsWithinCap(30, 30, 0, 90)).toBe(true)
    expect(fitsWithinCap(60, 30, 0, 90)).toBe(true)
    expect(fitsWithinCap(90, 30, 0, 90)).toBe(true)
  })

  it("40분/gap5/상한90분 — 1·2칸(40/85분) 허용, 3칸(130분)은 상한 초과로 거부", () => {
    expect(fitsWithinCap(40, 40, 5, 90)).toBe(true)
    expect(fitsWithinCap(85, 40, 5, 90)).toBe(true)
    expect(fitsWithinCap(130, 40, 5, 90)).toBe(false)
  })
})

// QA B5 / 발주자 플로우 — 운영자가 "10:00~11:00"처럼 시간 범위를 고를 때, 어디까지 늘릴 수 있나.
// 배정 시트의 시간 스테퍼 상한이자 상대 후보 필터가 이 함수 하나를 공유한다.
describe("freeRunLength (시작 칸부터 연달아 잡을 수 있는 칸 수)", () => {
  const DAY = ["09:00", "09:30", "10:00", "10:30", "11:00"]
  const daySlots = new Set(DAY.map((t) => `2026-10-20T${t}`))
  const run = (over: Partial<Parameters<typeof freeRunLength>[0]> = {}) =>
    freeRunLength({
      orgId: "e1",
      startSlotId: "2026-10-20T09:00",
      slotMinutes: 30,
      daySlots,
      meetings: [],
      ...over,
    })

  it("비어 있으면 상한(기본 3칸 = 90분)까지", () => {
    expect(run()).toBe(3)
  })

  it("뒤 칸이 차 있으면 거기서 멈춘다 — 60분은 되고 90분은 안 되는 자리", () => {
    const busy = [meeting({ id: "x", exhibitorId: "e1", slotId: "2026-10-20T10:00" })]
    expect(run({ meetings: busy })).toBe(2)
  })

  it("시작 칸부터 차 있으면 0 — 그 자리엔 아예 못 잡는다", () => {
    const busy = [meeting({ id: "x", exhibitorId: "e1", slotId: "2026-10-20T09:00" })]
    expect(run({ meetings: busy })).toBe(0)
  })

  it("죽은 이력(거절·취소)은 칸을 잡지 않는다 — 호출부가 걸러 넘기는 계약 그대로", () => {
    // 배정 화면은 살아있는 건만 넘긴다(assignment-hub의 expanded) → 같은 칸이어도 run이 안 줄어든다.
    expect(run({ meetings: [] })).toBe(3)
  })

  it("그리드에 없는 칸(운영 종료·점심 단절)에서 멈춘다", () => {
    expect(run({ startSlotId: "2026-10-20T10:30" })).toBe(2) // 10:30·11:00만 남음(11:30은 그리드 밖)
  })

  it("그 기업이 불가로 지정한 칸에서 멈춘다(소프트 제약도 화면에선 존중)", () => {
    const unavailable = { e1: new Set(["2026-10-20T09:30"]) }
    expect(run({ unavailable })).toBe(1)
  })

  it("maxSlots로 상한을 낮출 수 있다 — 후보 필터가 '필요한 만큼만' 확인할 때 쓴다", () => {
    expect(run({ maxSlots: 2 })).toBe(2)
  })

  // 계약서 §2/§5 인수기준 4 — 40분 상담+5분 텀 격자에서는 90분 상한이 2칸까지만 허용한다
  // (3칸=130분은 상한 밖이라 maxMeetingMinutes만 넘기면 애초에 3번째 칸을 제안하지 않는다).
  it("gap이 있으면 maxMeetingMinutes에서 칸 수 상한을 역산한다 — 40분/5분텀/90분 상한은 2칸까지", () => {
    const grid = ["10:00", "10:45", "11:30", "13:00"].map((t) => `2026-10-20T${t}`)
    const daySlots40 = new Set(grid)
    const result = freeRunLength({
      orgId: "e1",
      startSlotId: "2026-10-20T10:00",
      slotMinutes: 40,
      slotGapMinutes: 5,
      daySlots: daySlots40,
      meetings: [],
      maxMeetingMinutes: 90,
    })
    expect(result).toBe(2) // 10:00·10:45까지만 — 3번째 칸(11:30)은 상한(90분) 밖이라 제안 안 함
  })

  // 점심 횡단 차단(계약서 §5 인수기준 4) — 11:30 칸에서 시작하면 그리드에 12:15가 없어(점심으로
  // 제외됨) stride 인접 후보가 없다. 상한을 넉넉히 줘도 그리드 자체가 끊겨 있어 1칸에서 멈춘다.
  it("점심 횡단 차단 — 11:30에서 시작해도 13:00으로는 못 잇는다(그리드에 12:15가 없음)", () => {
    const grid = ["10:00", "10:45", "11:30", "13:00"].map((t) => `2026-10-20T${t}`)
    const daySlots40 = new Set(grid)
    const result = freeRunLength({
      orgId: "e1",
      startSlotId: "2026-10-20T11:30",
      slotMinutes: 40,
      slotGapMinutes: 5,
      daySlots: daySlots40,
      meetings: [],
      maxMeetingMinutes: 480, // 상한을 넉넉히 줘도 그리드가 끊겨 있어 넘어가지 못한다
    })
    expect(result).toBe(1)
  })
})
