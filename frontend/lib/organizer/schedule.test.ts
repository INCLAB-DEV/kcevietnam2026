import { describe, it, expect } from "vitest"
import {
  addMinutes,
  buildSlotUniverse,
  DEFAULT_SCHEDULE_SETTINGS,
  occupiedSlotIds,
  slotMeetingsFor,
  slotTimes,
  spanOf,
  type ScheduleSettings,
} from "./schedule"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"

const base: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS }

describe("schedule.slotTimes (운영 변수 → 하루 슬롯)", () => {
  it("시작~끝(배타)을 슬롯 길이로 끊는다", () => {
    const times = slotTimes({ ...base, startTime: "09:00", endTime: "11:00", slotMinutes: 30 })
    expect(times).toEqual(["09:00", "09:30", "10:00", "10:30"]) // 11:00은 배타적 끝이라 제외
  })

  it("점심 블록[lunchStart, lunchEnd)은 제외한다", () => {
    const times = slotTimes({
      ...base,
      startTime: "11:00",
      endTime: "14:00",
      slotMinutes: 60,
      lunchStart: "12:00",
      lunchEnd: "13:00",
    })
    expect(times).toEqual(["11:00", "13:00"]) // 12:00은 점심
  })

  it("잘못된 설정(슬롯 ≤ 0, 시작 ≥ 끝)은 빈 목록", () => {
    expect(slotTimes({ ...base, slotMinutes: 0 })).toEqual([])
    expect(slotTimes({ ...base, startTime: "18:00", endTime: "09:00" })).toEqual([])
  })

  // QA B1/B2 — 폴백 상수는 백엔드 컬럼 server_default와 1:1이어야 한다(app/models.py:
  // events.slot_minutes=30, operating 09:00~18:00, lunch NULL, min_guaranteed_slots=10).
  // 예전 값(10:00~18:10 / 45분 / 점심 12:10~13:00)은 폐기된 REQ-05 PPT 스펙이었고, 그 45분이
  // 배정 payload의 종료 시각으로 새어나가 10:00~10:30 배정이 10:00~10:45로 저장됐다.
  it("DEFAULT_SCHEDULE_SETTINGS — 백엔드 기본값(09:00~18:00 / 30분 / 텀 없음 / 점심 없음)과 같다", () => {
    expect(DEFAULT_SCHEDULE_SETTINGS).toEqual({
      startTime: "09:00",
      endTime: "18:00",
      slotMinutes: 30,
      slotGapMinutes: 0,
      lunchStart: "00:00",
      lunchEnd: "00:00",
      minSlots: 10,
      maxMeetingMinutes: 90,
    })
  })

  it("DEFAULT_SCHEDULE_SETTINGS — 그리드가 09:00부터 30분 간격, 마지막 칸은 17:30(하루 18칸)", () => {
    const times = slotTimes(DEFAULT_SCHEDULE_SETTINGS)
    expect(times).toHaveLength(18)
    expect(times.slice(0, 4)).toEqual(["09:00", "09:30", "10:00", "10:30"])
    expect(times.at(-1)).toBe("17:30") // 18:00까지 칸 끝이 들어오는 마지막 시작점
    // 전 구간이 정확히 30분 간격 — 어긋난 칸이 하나라도 있으면 배정 payload도 같이 어긋난다.
    const gaps = times.slice(1).map((t, i) => toMin(t) - toMin(times[i]))
    expect([...new Set(gaps)]).toEqual([30])
  })

  it("점심이 설정되지 않은 행사(lunchStart === lunchEnd)는 아무 칸도 건너뛰지 않는다", () => {
    expect(
      slotTimes({ ...base, startTime: "12:00", endTime: "13:00", slotMinutes: 30 }),
    ).toEqual(["12:00", "12:30"])
  })

  // 계약서(§1·§5 인수기준 1) — 발주사 운영표(40분 상담 + 5분 텀, 10:00~18:10, 점심 12:10~13:00)를
  // 분 단위까지 정확히 재현해야 한다. 11:30~12:10 칸은 점심 시작(12:10)과 맞닿을 뿐 겹치지 않으므로
  // 살아남고, 17:30 칸은 17:30+40=18:10<=18:10이라 마지막 칸으로 살아남는다(§0/§1 근거).
  it("발주사 운영표 재현 — 10:00~18:10 / 40분 상담 / 5분 텀 / 점심 12:10~13:00 = 하루 10칸", () => {
    const times = slotTimes({
      ...base,
      startTime: "10:00",
      endTime: "18:10",
      slotMinutes: 40,
      slotGapMinutes: 5,
      lunchStart: "12:10",
      lunchEnd: "13:00",
    })
    expect(times).toEqual([
      "10:00",
      "10:45",
      "11:30",
      "13:00",
      "13:45",
      "14:30",
      "15:15",
      "16:00",
      "16:45",
      "17:30",
    ])
  })

  // 계약서 §1/§5 인수기준 2 — slotGapMinutes=0이면 stride===slotMinutes라 예전 격자와 완전히 같다.
  it("하위호환 — slotGapMinutes=0이면 기존(간격=길이) 격자와 동일하다", () => {
    const withGapField = slotTimes({ ...base, startTime: "09:00", endTime: "11:00", slotMinutes: 30, slotGapMinutes: 0 })
    expect(withGapField).toEqual(["09:00", "09:30", "10:00", "10:30"])
  })
})

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

describe("schedule.buildSlotUniverse (날짜 × 슬롯)", () => {
  it("날짜마다 하루 슬롯을 펼치고 id는 dateTtime", () => {
    const settings = { ...base, startTime: "09:00", endTime: "10:00", slotMinutes: 30 }
    const slots = buildSlotUniverse(["2026-09-16", "2026-09-17"], settings)
    expect(slots).toHaveLength(4) // 2일 × 2슬롯
    expect(slots[0]).toEqual({ id: "2026-09-16T09:00", dateId: "2026-09-16", time: "09:00" })
    expect(slots.map((s) => s.id)).toContain("2026-09-17T09:30")
  })
})

describe("schedule 연속 슬롯 (spanOf · occupiedSlotIds · addMinutes)", () => {
  it("소요시간 → 점유 슬롯 수(30/60/90 = 1/2/3), 미지정은 1칸", () => {
    expect(spanOf(30, 30)).toBe(1)
    expect(spanOf(60, 30)).toBe(2)
    expect(spanOf(90, 30)).toBe(3)
    expect(spanOf(undefined, 30)).toBe(1)
  })

  // 계약서 §2 표 — 40분 상담 + 5분 텀(stride 45)에서 85분은 2칸(10:00~11:25), 130분은 3칸이 필요.
  it("간격(gap)이 있으면 stride 기준으로 칸 수를 센다 — 40/5: 85분=2칸, 130분=3칸", () => {
    expect(spanOf(40, 40, 5)).toBe(1)
    expect(spanOf(85, 40, 5)).toBe(2)
    expect(spanOf(130, 40, 5)).toBe(3)
  })

  it("occupiedSlotIds는 시작 포함 연속 칸 id를 돌려준다", () => {
    expect(occupiedSlotIds("2026-09-16T09:00", 90, 30)).toEqual([
      "2026-09-16T09:00",
      "2026-09-16T09:30",
      "2026-09-16T10:00",
    ])
    expect(occupiedSlotIds("2026-09-16T09:00", undefined, 30)).toEqual(["2026-09-16T09:00"])
  })

  it("occupiedSlotIds는 gap이 있으면 stride만큼 떨어진 칸 id를 돌려준다(85분=10:00,10:45)", () => {
    expect(occupiedSlotIds("2026-10-20T10:00", 85, 40, 5)).toEqual([
      "2026-10-20T10:00",
      "2026-10-20T10:45",
    ])
  })

  it("addMinutes", () => {
    expect(addMinutes("09:30", 90)).toBe("11:00")
    expect(addMinutes("17:30", 30)).toBe("18:00")
  })
})

// #10 — 운영자 배정 그리드의 한 칸도 미팅을 전부 보여준다(참가자 타임라인과 같은 규칙).
// #2 회귀 가드도 겸한다: 서버가 created_at 오름차순으로 주는 목록에서 "확정 자리가 거절로 표시"되면 안 된다.
describe("schedule.slotMeetingsFor (배정 그리드 한 칸)", () => {
  const SLOT = "2026-09-16T10:00"
  const EXH = "exh-1"

  function gm(id: string, status: ScheduleStatus, over: Partial<GridMeeting> = {}): GridMeeting {
    return { id, slotId: SLOT, exhibitorId: EXH, buyerId: `buyer-${id}`, status, ...over }
  }
  interface GridMeeting {
    id: string
    slotId: string
    exhibitorId: string
    buyerId: string
    status: ScheduleStatus
  }

  it("확정이 첫 번째 — 나중에 들어온 거절이 확정 자리를 덮어쓰지 않는다(#2 회귀)", () => {
    // 서버 계약: created_at 오름차순(오래된 것 먼저) = 확정이 먼저, 거절이 나중.
    const list = [gm("accepted", "accepted"), gm("rejected", "rejected")]
    expect(slotMeetingsFor(list, EXH, SLOT)[0].id).toBe("accepted")
  })

  it("같은 칸의 미팅을 전부 돌려준다 — 활성이 위, 죽은 이력이 아래", () => {
    const list = [
      gm("old-cancelled", "cancelled"),
      gm("waiting", "proposed"),
      gm("new-rejected", "rejected"),
    ]
    expect(slotMeetingsFor(list, EXH, SLOT).map((m) => m.id)).toEqual([
      "waiting",
      "new-rejected", // 죽은 것끼리는 최신(=서버 목록 뒤쪽)이 위
      "old-cancelled",
    ])
  })

  it("같은 등급이면 최신(서버 목록 뒤쪽)이 위 — 오름차순 목록을 뒤집어 넘기는 계약", () => {
    const list = [gm("oldest", "proposed"), gm("newest", "proposed")]
    expect(slotMeetingsFor(list, EXH, SLOT).map((m) => m.id)).toEqual(["newest", "oldest"])
  })

  it("다른 슬롯·다른 기업의 미팅은 섞이지 않는다", () => {
    const list = [
      gm("here", "accepted"),
      gm("other-slot", "accepted", { slotId: "2026-09-16T10:45" }),
      gm("other-org", "accepted", { exhibitorId: "exh-2", buyerId: "buyer-x" }),
    ]
    expect(slotMeetingsFor(list, EXH, SLOT).map((m) => m.id)).toEqual(["here"])
  })

  it("바이어 행에서도 같은 칸의 미팅을 전부 집는다(행 기업이 어느 쪽이든)", () => {
    const list = [
      gm("m1", "proposed", { buyerId: "buyer-1" }),
      gm("m2", "proposed", { buyerId: "buyer-1", exhibitorId: "exh-2" }),
    ]
    expect(slotMeetingsFor(list, "buyer-1", SLOT).map((m) => m.id)).toEqual(["m2", "m1"])
  })

  it("걸린 미팅이 없으면 빈 배열", () => {
    expect(slotMeetingsFor([], EXH, SLOT)).toEqual([])
  })
})
