import { describe, it, expect } from "vitest"
import {
  buildTimeline,
  actionsFor,
  toneFor,
  labelFor,
  shortLabelFor,
  slotTimes,
  isEndedAccepted,
  type EventDate,
  type FilledSlot,
} from "./timeline"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"

const DATES: EventDate[] = [
  { id: "2026-09-16", label: "9/16", weekday: "수" },
  { id: "2026-09-17", label: "9/17", weekday: "목" },
]

const VIEWER = "buyer-1"
const OTHER = "exh-9"

// buyer 시점 미팅 1건. sentBy로 방향(보낸/받은)을 정한다(MeetingRecord.requestedBy 필드와
// 이름이 겹치지 않게 테스트 로컬 파라미터는 sentBy로 둔다).
function meeting(
  partial: Partial<MeetingRecord> & { status: ScheduleStatus } & {
    sentBy?: "me" | "counterpart"
  }
): MeetingRecord {
  const { sentBy = "me", ...rest } = partial
  return {
    id: "m",
    hasReview: false,
    scheduledAt: "2026-09-16T10:00:00+09:00",
    buyerOrgId: VIEWER,
    exhibitorOrgId: OTHER,
    requestedByOrgId: sentBy === "me" ? VIEWER : OTHER,
    counterpartName: "상대기업",
    venue: "비즈니스룸 1",
    ...rest,
  }
}

function build(meetings: MeetingRecord[], role: "buyer" | "exhibitor" = "buyer") {
  return buildTimeline({ viewerRole: role, viewerOrgId: VIEWER, meetings, eventDates: DATES })
}

function filledSlots(meetings: MeetingRecord[]): FilledSlot[] {
  return build(meetings)
    .days.flatMap((d) => d.slots)
    .filter((s): s is FilledSlot => s.kind === "meeting")
}

describe("slotTimes", () => {
  it("09:00~17:30 30분 격자 18개를 만든다(18:00 시작 슬롯은 없음)", () => {
    const times = slotTimes()
    expect(times).toHaveLength(18)
    expect(times[0]).toBe("09:00")
    expect(times[1]).toBe("09:30")
    expect(times.at(-1)).toBe("17:30")
    expect(times).not.toContain("18:00")
  })
})

describe("slotTimes — 1시간 단위", () => {
  it("slotMinutes=60이면 정시 9개를 만든다(09:00…17:00)", () => {
    const times = slotTimes(60)
    expect(times).toHaveLength(9)
    expect(times[0]).toBe("09:00")
    expect(times[1]).toBe("10:00")
    expect(times.at(-1)).toBe("17:00")
    expect(times).not.toContain("09:30")
  })
})

// 계약서 §1 — 예전엔 "시(hour) 루프 안에서 분을 step"해서 slotMinutes가 60을 나누어떨어지지
// 않으면(40분) 시 경계에서 분이 리셋돼 09:00,09:40,10:00,09:40,10:00,10:40… 처럼 시각 목록 자체가
// 틀렸다. 지금은 하루 전체를 분 단위로 도는 단일 루프라 40분(+gap) 격자도 정확하다.
describe("slotTimes — gap이 있는 격자(40분/5분 텀, 계약서 §1)", () => {
  it("09:00~18:00 안에서 40분/5분 텀 격자를 시 경계 없이 정확히 만든다", () => {
    const times = slotTimes(40, 5)
    // stride 45분 간격 — 09:00,09:45,10:30,11:15,12:00,12:45,13:30,14:15,15:00,15:45,16:30,17:15
    expect(times[0]).toBe("09:00")
    expect(times[1]).toBe("09:45") // 시 경계를 넘어가도 09:40으로 리셋되지 않는다
    expect(times[2]).toBe("10:30")
    expect(times.every((t, i) => i === 0 || toMinOf(t) - toMinOf(times[i - 1]) === 45)).toBe(true)
  })

  it("slotGapMinutes=0이면 기존(간격=길이) 격자와 동일하다(하위호환)", () => {
    expect(slotTimes(30, 0)).toEqual(slotTimes(30))
  })
})

function toMinOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

describe("buildTimeline — 행사일별 슬롯 단위(60분)", () => {
  const DATES_60: EventDate[] = [{ id: "2026-09-16", label: "9/16", weekday: "수", slotMinutes: 60 }]

  it("60분 운영일은 정시 슬롯에만 미팅을 채운다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" })],
      eventDates: DATES_60,
    })
    const day = proj.days[0]
    expect(day.slots).toHaveLength(9)
    expect(day.slots.find((s) => s.time === "10:00")).toMatchObject({ kind: "meeting", meetingId: "a" })
    expect(day.slots.some((s) => s.time === "10:30")).toBe(false)
  })

  it("60분 운영일의 현재 시각 마커는 정시로 내림(10:45→10:00)", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [],
      eventDates: DATES_60,
      now: { date: "2026-09-16", time: "10:45" },
    })
    expect(proj.days[0].now?.rowTime).toBe("10:00")
  })
})

// 계약서 §1/§2 — 40분 상담 + 5분 텀 격자에서도 참가자 타임라인이 정확히 렌더돼야 한다.
describe("buildTimeline — 행사일별 슬롯 단위(40분/5분 텀, 계약서 §1)", () => {
  const DATES_GAP: EventDate[] = [
    { id: "2026-09-16", label: "9/16", weekday: "수", slotMinutes: 40, slotGapMinutes: 5 },
  ]

  it("stride(45분)만큼 떨어진 칸에만 미팅을 채운다 — 09:40 같은 없는 칸은 생기지 않는다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T09:45:00+09:00" })],
      eventDates: DATES_GAP,
    })
    const day = proj.days[0]
    expect(day.slots.some((s) => s.time === "09:40")).toBe(false)
    expect(day.slots.find((s) => s.time === "09:45")).toMatchObject({ kind: "meeting", meetingId: "a" })
  })

  it("85분(2칸) 미팅은 시작칸만 렌더하고 종료는 스팬 전체(텀 포함, 09:00+85분=10:25)", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [
        meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T09:00:00+09:00", durationMinutes: 85 }),
      ],
      eventDates: DATES_GAP,
    })
    const day = proj.days[0]
    expect(day.slots.find((s) => s.time === "09:00")).toMatchObject({
      kind: "meeting",
      span: 2,
      endTime: "10:25", // (2-1)*45 + 40 = 85분 경과
      coveredTimes: ["09:45"],
    })
    expect(day.slots.some((s) => s.time === "09:45")).toBe(false) // 뒤 칸은 미팅이 흡수
  })
})

describe("toneFor / labelFor (F-MY-001 D2 — 색=끝난 미팅의 '다음 할 일')", () => {
  it("기본 색 매핑: 적=proposed, 녹=accepted(예정), 회=rejected/cancelled", () => {
    expect(toneFor("proposed")).toBe("red")
    expect(toneFor("accepted")).toBe("green")
    expect(toneFor("rejected")).toBe("gray")
    expect(toneFor("cancelled")).toBe("gray")
  })

  it("완료 미팅의 색은 참석·회의록으로 갈린다: 미작성=주황, 작성완료=파랑, 노쇼=회색", () => {
    // 참석 + 회의록 미작성 → orange(작성 필요)
    expect(toneFor("completed", { attended: true, hasReview: false })).toBe("orange")
    // 참석 + 회의록 작성완료 → blue(보관)
    expect(toneFor("completed", { attended: true, hasReview: true })).toBe("blue")
    // 노쇼(미참석) → gray(회의록 불가)
    expect(toneFor("completed", { attended: false })).toBe("gray")
  })

  it("확정인데 종료시각 지남(ended) → 주황(회의록 미작성 동치), 진행 전이면 녹색", () => {
    expect(toneFor("accepted", { ended: true })).toBe("orange")
    expect(toneFor("accepted", { ended: false })).toBe("green")
  })

  it("라벨도 '다음 할 일': 수락 필요/대기중, 미팅 예정, 회의록 작성/보기, 불참, 취소됨", () => {
    // proposed 방향
    expect(labelFor("proposed", "received")).toBe("수락 필요")
    expect(labelFor("proposed", "sent")).toBe("수락 대기중")
    // accepted: 예정 vs 종료경과
    expect(labelFor("accepted", "sent")).toBe("미팅 예정")
    expect(labelFor("accepted", "sent", { ended: true })).toBe("회의록 작성")
    // completed 참석: 미작성=회의록 작성 / 작성완료=회의록 보기
    expect(labelFor("completed", "sent", { attended: true, hasReview: false })).toBe("회의록 작성")
    expect(labelFor("completed", "sent", { attended: true, hasReview: true })).toBe("회의록 보기")
    // 노쇼 / 무산
    expect(labelFor("completed", "sent", { attended: false })).toBe("불참")
    expect(labelFor("cancelled", "received")).toBe("취소됨")
  })

  it("축약 라벨(좁은 블록): 수락/대기, 예정/회의록, 거절/취소", () => {
    expect(shortLabelFor("proposed", "received")).toBe("수락")
    expect(shortLabelFor("proposed", "sent")).toBe("대기")
    expect(shortLabelFor("accepted", "sent")).toBe("예정")
    expect(shortLabelFor("accepted", "sent", { ended: true })).toBe("회의록")
    expect(shortLabelFor("completed", "sent", { attended: true })).toBe("회의록")
    expect(shortLabelFor("completed", "sent", { attended: false })).toBe("불참")
    expect(shortLabelFor("rejected", "received")).toBe("거절")
  })
})

describe("actionsFor — 방향×상태×역할 매트릭스 (F-MY-001 D3)", () => {
  it("받은 proposed → 수락/거부", () => {
    expect(actionsFor("proposed", "received", "buyer")).toEqual(["accept", "reject"])
  })
  it("보낸 proposed → 취소", () => {
    expect(actionsFor("proposed", "sent", "buyer")).toEqual(["cancel"])
  })
  it("accepted → 회의록+취소(양방향) — 미팅 전이라도 회의록 진입 허용(2026-09-14 결정)", () => {
    expect(actionsFor("accepted", "received", "buyer")).toEqual(["review", "cancel"])
    expect(actionsFor("accepted", "sent", "exhibitor")).toEqual(["review", "cancel"])
  })
  it("완료(참석) → 회의록만 / 노쇼 → 참석여부 수정만 (두 버튼 공존 금지)", () => {
    expect(actionsFor("completed", "sent", "buyer", true)).toEqual(["review"])
    expect(actionsFor("completed", "received", "buyer", true)).toEqual(["review"])
    expect(actionsFor("completed", "sent", "buyer", false)).toEqual(["attendance"]) // 노쇼
  })
  it("rejected/cancelled → 버튼 없음", () => {
    expect(actionsFor("rejected", "received", "buyer")).toEqual([])
    expect(actionsFor("cancelled", "sent", "buyer")).toEqual([])
  })
})

describe("isEndedAccepted (확정 종료경과 — isExpiredProposed의 짝)", () => {
  const now = { date: "2026-09-16", time: "11:00" }
  it("accepted이고 종료시각(시작+소요)이 now 이하면 true", () => {
    // 10:00 시작 + 30분 → 10:30 종료 ≤ 11:00 → 종료경과
    expect(isEndedAccepted("accepted", "2026-09-16T10:00:00+09:00", 30, now)).toBe(true)
  })
  it("아직 종료 전이면 false", () => {
    // 10:30 시작 + 60분 → 11:30 종료 > 11:00
    expect(isEndedAccepted("accepted", "2026-09-16T10:30:00+09:00", 60, now)).toBe(false)
  })
  it("accepted가 아니거나 now 미주입이면 false", () => {
    expect(isEndedAccepted("completed", "2026-09-16T09:00:00+09:00", 30, now)).toBe(false)
    expect(isEndedAccepted("accepted", "2026-09-16T09:00:00+09:00", 30, undefined)).toBe(false)
  })
})

describe("buildTimeline 톤 — 색=다음 할 일(통합)", () => {
  const tone = (m: MeetingRecord, now?: { date: string; time: string }) =>
    buildTimeline({ viewerRole: "buyer", viewerOrgId: VIEWER, meetings: [m], eventDates: DATES, now })
      .days.flatMap((d) => d.slots)
      .find((s): s is FilledSlot => s.kind === "meeting")

  it("완료+참석+회의록 작성완료 → blue", () => {
    expect(tone(meeting({ id: "a", status: "completed", attended: true, hasReview: true }))?.tone).toBe("blue")
  })
  it("완료+참석+회의록 미작성 → orange", () => {
    expect(tone(meeting({ id: "a", status: "completed", attended: true, hasReview: false }))?.tone).toBe("orange")
  })
  it("완료+노쇼(미참석) → gray, 라벨 '불참'", () => {
    const s = tone(meeting({ id: "a", status: "completed", attended: false }))
    expect(s?.tone).toBe("gray")
    expect(s?.label).toBe("불참")
  })
  it("확정인데 종료시각 지남(now 주입) → orange", () => {
    // 10:00 시작 + 30분 → 10:30 종료. now=11:00 → 종료경과 → orange.
    const s = tone(
      meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 30 }),
      { date: "2026-09-16", time: "11:00" }
    )
    expect(s?.tone).toBe("orange")
  })
})

describe("buildTimeline", () => {
  it("미팅을 KST 시각에 맞는 슬롯에 채우고, 빈 슬롯은 gray empty로 둔다", () => {
    const proj = build([
      meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" }),
    ])
    const day = proj.days[0]
    const at10 = day.slots.find((s) => s.time === "10:00")
    const at1030 = day.slots.find((s) => s.time === "10:30")
    expect(at10).toMatchObject({ kind: "meeting", meetingId: "a", tone: "green", label: "미팅 예정" })
    expect(at1030).toEqual({ kind: "empty", time: "10:30", tone: "gray" })
  })

  it("받은 proposed 건만 그날 pendingCount로 센다(보낸 proposed는 제외)", () => {
    const proj = build([
      meeting({ id: "r", status: "proposed", sentBy: "counterpart", scheduledAt: "2026-09-16T11:00:00+09:00" }),
      meeting({ id: "s", status: "proposed", sentBy: "me", scheduledAt: "2026-09-16T12:00:00+09:00" }),
    ])
    expect(proj.days[0].pendingCount).toBe(1)
  })

  it("소요시간이 길면 여러 슬롯을 점유하고 뒤 칸은 목록에서 가린다(90분=3칸)", () => {
    const proj = build([
      meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 90 }),
    ])
    const day = proj.days[0]
    expect(day.slots.find((s) => s.time === "10:00")).toMatchObject({
      kind: "meeting",
      span: 3,
      endTime: "11:30",
      coveredTimes: ["10:30", "11:00"], // 시간축 라벨 유지용
    })
    expect(day.slots.some((s) => s.time === "10:30")).toBe(false)
    expect(day.slots.some((s) => s.time === "11:00")).toBe(false)
    expect(day.slots.find((s) => s.time === "11:30")).toMatchObject({ kind: "empty" })
  })

  it("소요시간 60분=2칸: 시작칸만 렌더(span 2·종료 11:00)하고 다음 칸(10:30)은 가린다", () => {
    const proj = build([
      meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 60 }),
    ])
    const day = proj.days[0]
    expect(day.slots.find((s) => s.time === "10:00")).toMatchObject({
      kind: "meeting",
      span: 2,
      endTime: "11:00",
      coveredTimes: ["10:30"], // 시간축 라벨 유지용
    })
    expect(day.slots.some((s) => s.time === "10:30")).toBe(false) // 점유칸은 별도 슬롯 아님(미팅이 흡수)
    expect(day.slots.find((s) => s.time === "11:00")).toMatchObject({ kind: "empty" }) // 종료 후 빈칸
  })

  it("현재 시각이 60분(2칸) 미팅의 2번째 칸(10:34)에 걸려도 시작칸(10:00) 행에 앵커가 붙는다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [
        meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 60 }),
      ],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "10:34" }, // 10:00~11:00 안, 점유칸(10:30)에 해당
    })
    expect(proj.days[0].now).toEqual({ rowTime: "10:00", time: "10:34", live: true })
  })

  // 상단 합산 카운트(summary)는 폐기(F-MY-001 D18) → 집계는 action-strip.test.ts로 이관.

  it("rejected/cancelled 건도 슬롯에 표시하되(이력) 액션은 없다", () => {
    const slots = filledSlots([
      meeting({ id: "c", status: "cancelled", scheduledAt: "2026-09-16T13:00:00+09:00" }),
    ])
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({ tone: "gray", label: "취소됨", actions: [] })
  })

  it("권한 경계: 내 기업이 당사자가 아닌 미팅은 제외한다", () => {
    const proj = build([
      { ...meeting({ id: "mine", status: "accepted" }) },
      { ...meeting({ id: "notmine", status: "accepted" }), buyerOrgId: "someone-else" },
    ])
    expect(proj.totalMeetings).toBe(1)
    expect(filledSlots([
      { ...meeting({ id: "mine", status: "accepted" }) },
      { ...meeting({ id: "notmine", status: "accepted" }), buyerOrgId: "someone-else" },
    ]).map((s) => s.meetingId)).toEqual(["mine"])
  })

  it("exhibitor 시점에서는 exhibitorOrgId가 viewer 측 org가 된다", () => {
    const m: MeetingRecord = {
      ...meeting({ id: "x", status: "accepted", sentBy: "counterpart" }),
      buyerOrgId: OTHER,
      exhibitorOrgId: VIEWER,
      requestedByOrgId: OTHER,
    }
    const proj = buildTimeline({
      viewerRole: "exhibitor",
      viewerOrgId: VIEWER,
      meetings: [m],
      eventDates: DATES,
    })
    expect(proj.totalMeetings).toBe(1)
    const slot = proj.days[0].slots.find((s) => s.kind === "meeting") as FilledSlot
    // 상대가 신청(received) + accepted → 회의록+취소(2026-09-14 결정)
    expect(slot.direction).toBe("received")
    expect(slot.actions).toEqual(["review", "cancel"])
  })

  it("현재 시각 마커: 오늘 날짜의 해당 슬롯(10:24→10:00) 아래에 마커를 둔다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "10:24" },
    })
    expect(proj.days[0].now).toEqual({ rowTime: "10:00", time: "10:24", live: false })
    // 다른 날(9/17)에는 현재 시각이 없다
    expect(proj.days[1].now).toBeNull()
  })

  it("현재 시각 마커: 30분 경과분은 다음 반슬롯으로 내림(10:45→10:30)", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "10:45" },
    })
    expect(proj.days[0].now?.rowTime).toBe("10:30")
  })

  it("현재 시각 마커: 행사일이 아니면(now.date 불일치) 모든 날 null", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [],
      eventDates: DATES,
      now: { date: "2026-06-22", time: "10:00" },
    })
    expect(proj.days.every((d) => d.now === null)).toBe(true)
  })

  it("현재 시각 마커: 슬롯 시간대(09:00~18:00) 밖이면 null", () => {
    const before = buildTimeline({ viewerRole: "buyer", viewerOrgId: VIEWER, meetings: [], eventDates: DATES, now: { date: "2026-09-16", time: "08:30" } })
    const after = buildTimeline({ viewerRole: "buyer", viewerOrgId: VIEWER, meetings: [], eventDates: DATES, now: { date: "2026-09-16", time: "18:00" } })
    expect(before.days[0].now).toBeNull()
    expect(after.days[0].now).toBeNull()
  })

  it("현재 시각 마커: now 미주입 시 마커 없음", () => {
    const proj = build([meeting({ id: "a", status: "accepted" })])
    expect(proj.days.every((d) => d.now === null)).toBe(true)
  })

  it("현재 시각: now가 미팅 진행 중이면 그 미팅 시작칸 행(rowTime)에 칩을 붙인다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "live", status: "accepted", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "09:34" }, // 09:30~10:00 진행 중
    })
    expect(proj.days[0].now).toEqual({ rowTime: "09:30", time: "09:34", live: true })
  })

  it("현재 시각: 멀티슬롯 미팅 점유칸에 now가 있어도 그 미팅 시작칸에 붙어 사라지지 않는다", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [
        meeting({ id: "long", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 90 }),
      ],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "10:34" }, // 10:00~11:30 안(점유칸 10:30 — 예전엔 마커 소실)
    })
    expect(proj.days[0].now).toEqual({ rowTime: "10:00", time: "10:34", live: true }) // floor(10:30) 아니라 미팅 시작칸
  })

  it("현재 시각: 미팅 없는 빈 시간대면 now가 속한 빈 슬롯 행(floor)에 붙인다(슬롯 사이 분리선 아님)", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "11:24" }, // 11:00 빈 슬롯 안
    })
    expect(proj.days[0].now).toEqual({ rowTime: "11:00", time: "11:24", live: false })
  })

  it("만료: 수락 전(proposed) + 시작 지나면 회색·'응답 시간 지남'·액션 없음(상태값은 proposed 유지)", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "x", status: "proposed", sentBy: "counterpart", scheduledAt: "2026-09-16T09:30:00+09:00" })],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "09:34" }, // 시작(09:30) 지남
    })
    const slot = proj.days[0].slots.find(
      (s): s is FilledSlot => s.kind === "meeting" && s.meetingId === "x"
    )!
    expect(slot.expired).toBe(true)
    expect(slot.status).toBe("proposed") // 상태값은 그대로(표시만 만료)
    expect(slot.tone).toBe("gray")
    expect(slot.label).toBe("응답 시간 지남")
    expect(slot.actions).toEqual([])
    // 시간 앵커(지금 칩)는 만료 행에도 뜬다(시간 표기는 항상). 단 live=false라 "진행 중" 링은 없다.
    expect(proj.days[0].now).toEqual({ rowTime: "09:30", time: "09:34", live: false })
    // 받은요청 배지에서는 빠진다.
    expect(proj.days[0].pendingCount).toBe(0)
  })

  it("만료 아님: 시작 전(start>now) proposed는 정상 '응답 필요' + 수락/거부", () => {
    const proj = buildTimeline({
      viewerRole: "buyer",
      viewerOrgId: VIEWER,
      meetings: [meeting({ id: "x", status: "proposed", sentBy: "counterpart", scheduledAt: "2026-09-16T11:00:00+09:00" })],
      eventDates: DATES,
      now: { date: "2026-09-16", time: "09:34" },
    })
    const slot = proj.days[0].slots.find(
      (s): s is FilledSlot => s.kind === "meeting" && s.meetingId === "x"
    )!
    expect(slot.expired).toBe(false)
    expect(slot.label).toBe("수락 필요")
    expect(slot.actions).toEqual(["accept", "reject"])
  })
})

// #2 — 같은 시간칸에 미팅이 여러 건(재신청 등)이면 pickSlotMeeting 규칙으로 하나를 고른다.
// 서버 목록은 created_at DESC(최신 먼저)로 온다 — 아래 meetings 배열도 그 계약대로 최신을 앞에 둔다.
describe("buildTimeline — 같은 슬롯 충돌(#2, pickSlotMeeting 회귀)", () => {
  it("거절(오래됨) + 수락(최신)이 같은 칸이면 수락이 이긴다 — 거절이 확정을 가리지 않는다", () => {
    const proj = build([
      meeting({ id: "new-accepted", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" }), // 최신(서버 DESC 앞쪽)
      meeting({ id: "old-rejected", status: "rejected", scheduledAt: "2026-09-16T10:00:00+09:00" }), // 오래됨
    ])
    const slot = proj.days[0].slots.find((s) => s.time === "10:00") as FilledSlot
    expect(slot.meetingId).toBe("new-accepted")
    expect(slot.status).toBe("accepted")
    expect(slot.label).toBe("미팅 예정")
  })

  it("취소×2 + 수락이 같은 칸이면 수락이 이긴다", () => {
    const proj = build([
      meeting({ id: "c1", status: "cancelled", scheduledAt: "2026-09-16T10:00:00+09:00" }),
      meeting({ id: "accepted", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" }),
      meeting({ id: "c2", status: "cancelled", scheduledAt: "2026-09-16T10:00:00+09:00" }),
    ])
    const slot = proj.days[0].slots.find((s) => s.time === "10:00") as FilledSlot
    expect(slot.meetingId).toBe("accepted")
  })

  it("거절만 여러 건이면 최신(배열 앞쪽) 거절이 이긴다", () => {
    const proj = build([
      meeting({ id: "newest-rejected", status: "rejected", scheduledAt: "2026-09-16T10:00:00+09:00" }),
      meeting({ id: "oldest-rejected", status: "rejected", scheduledAt: "2026-09-16T10:00:00+09:00" }),
    ])
    const slot = proj.days[0].slots.find((s) => s.time === "10:00") as FilledSlot
    expect(slot.meetingId).toBe("newest-rejected")
  })

  it("충돌 없는 평범한 케이스(슬롯당 1건)는 기존과 동일하게 그려진다 — 회귀 없음", () => {
    const proj = build([
      meeting({ id: "a", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00" }),
      meeting({ id: "b", status: "proposed", sentBy: "counterpart", scheduledAt: "2026-09-16T14:00:00+09:00" }),
    ])
    const slots = proj.days[0].slots.filter((s): s is FilledSlot => s.kind === "meeting")
    expect(slots.map((s) => s.meetingId).sort()).toEqual(["a", "b"])
  })

  it("진 미팅(rejected)이 더 긴 소요시간이어도 뒤 칸을 가리지 않는다(선택된 미팅 기준으로만 점유)", () => {
    const proj = build([
      meeting({ id: "accepted-30", status: "accepted", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 30 }),
      meeting({ id: "rejected-90", status: "rejected", scheduledAt: "2026-09-16T10:00:00+09:00", durationMinutes: 90 }),
    ])
    const day = proj.days[0]
    expect(day.slots.find((s) => s.time === "10:00")).toMatchObject({ kind: "meeting", meetingId: "accepted-30" })
    // 진 미팅(90분 거절)의 점유가 살아남지 않으므로 10:30은 빈 칸이어야 한다.
    expect(day.slots.find((s) => s.time === "10:30")).toMatchObject({ kind: "empty" })
  })
})

// #10 — 같은 시각에 여러 건이 걸려도 **전부** 보이고 각각 응답할 수 있다.
// 발주자 요구: 참가사–바이어 N:M이 유지되어야 하고, 거절 이력이 보이되 새 신청을 가리면 안 된다.
// (#2는 "하나를 고르되 올바른 것을 고른다"까지였다 — 그래서 나머지가 화면에서 사라졌다.)
describe("buildTimeline — 한 칸의 미팅을 전부 표시(#10)", () => {
  const EXHIBITOR = "exh-1"

  // 바이어가 이 참가사에게 신청한 건(받은 요청). 서버 계약대로 배열 앞쪽이 최신이다.
  function received(
    id: string,
    status: ScheduleStatus,
    extra: Partial<MeetingRecord> = {}
  ): MeetingRecord {
    return {
      id,
      status,
      hasReview: false,
      scheduledAt: "2026-09-16T10:00:00+09:00",
      buyerOrgId: `buyer-${id}`,
      exhibitorOrgId: EXHIBITOR,
      requestedByOrgId: `buyer-${id}`,
      counterpartName: `바이어 ${id}`,
      venue: "비즈니스룸 1",
      ...extra,
    }
  }

  function slotAt(meetings: MeetingRecord[], time = "10:00"): FilledSlot {
    const proj = buildTimeline({
      viewerRole: "exhibitor",
      viewerOrgId: EXHIBITOR,
      meetings,
      eventDates: DATES,
    })
    return proj.days[0].slots.find((s) => s.time === time) as FilledSlot
  }

  it("{거절, 확정}이 같은 칸이면 둘 다 보이고 확정이 위다", () => {
    const slot = slotAt([received("a", "accepted"), received("b", "rejected")])
    expect(slot.meetings.map((m) => m.meetingId)).toEqual(["a", "b"])
    expect(slot.meetings.map((m) => m.status)).toEqual(["accepted", "rejected"])
    // 거절 이력은 지우지 않되 한 줄 축약 대상으로 표시한다(dead).
    expect(slot.meetings.map((m) => m.dead)).toEqual([false, true])
  })

  it("같은 시각으로 신청 3건이 들어오면 3건 다 보이고 각각 수락·거절할 수 있다", () => {
    const slot = slotAt([
      received("c", "proposed"),
      received("b", "proposed"),
      received("a", "proposed"),
    ])
    expect(slot.meetings).toHaveLength(3)
    // 액션은 건별로 독립 — 각 건이 자기 meetingId를 들고 있어야 수락/거절이 올바른 대상에 나간다.
    for (const m of slot.meetings) {
      expect(m.actions).toEqual(["accept", "reject"])
      expect(m.label).toBe("수락 필요")
    }
    expect(slot.meetings.map((m) => m.meetingId)).toEqual(["c", "b", "a"]) // 동급이면 최신이 위
    expect(slot.meetings.map((m) => m.counterpartName)).toEqual([
      "바이어 c",
      "바이어 b",
      "바이어 a",
    ])
  })

  it("{취소, 취소, 확정}이면 확정이 위고 취소 2건도 함께 보인다", () => {
    const slot = slotAt([
      received("c1", "cancelled"),
      received("ok", "accepted"),
      received("c2", "cancelled"),
    ])
    expect(slot.meetings.map((m) => m.meetingId)).toEqual(["ok", "c1", "c2"])
    expect(slot.meetings).toHaveLength(3)
    // 칸의 대표(단수 필드)는 확정 건 — 칸 톤·"진행 중" 판정이 거절/취소로 물들지 않는다.
    expect(slot.meetingId).toBe("ok")
    expect(slot.tone).toBe("green")
  })

  it("칸의 단수 필드는 대표 1건(meetings[0])과 정확히 같다 — 축약 표현 호환", () => {
    const slot = slotAt([received("a", "accepted"), received("b", "rejected")])
    const primary = slot.meetings[0]
    expect(slot.meetingId).toBe(primary.meetingId)
    expect(slot.status).toBe(primary.status)
    expect(slot.label).toBe(primary.label)
    expect(slot.shortLabel).toBe(primary.shortLabel)
    expect(slot.actions).toEqual(primary.actions)
    expect(slot.counterpartName).toBe(primary.counterpartName)
  })

  it("각 건은 자기 소요시간으로 종료 시각을 갖는다(칸 점유와 별개)", () => {
    const slot = slotAt([
      received("short", "accepted", { durationMinutes: 30 }),
      received("long", "proposed", { durationMinutes: 90 }),
    ])
    expect(slot.meetings.find((m) => m.meetingId === "short")?.endTime).toBe("10:30")
    expect(slot.meetings.find((m) => m.meetingId === "long")?.endTime).toBe("11:30")
    // 칸 점유(그리드)는 활성 대표 건 기준이라 30분 = 1칸.
    expect(slot.span).toBe(1)
    expect(slot.endTime).toBe("10:30")
  })

  it("죽은 미팅(90분 거절)만 남은 칸은 뒤 칸을 가리지 않는다 — 잡을 수 있는 시간이 숨지 않게", () => {
    const proj = buildTimeline({
      viewerRole: "exhibitor",
      viewerOrgId: EXHIBITOR,
      meetings: [
        received("r1", "rejected", { durationMinutes: 90 }),
        received("c1", "cancelled", { durationMinutes: 90 }),
      ],
      eventDates: DATES,
    })
    const day = proj.days[0]
    const slot = day.slots.find((s) => s.time === "10:00") as FilledSlot
    expect(slot.meetings).toHaveLength(2) // 이력은 그대로 보인다
    expect(slot.span).toBe(1) // 하지만 점유는 1칸
    expect(slot.coveredTimes).toEqual([])
    expect(day.slots.find((s) => s.time === "10:30")).toMatchObject({ kind: "empty" })
    expect(day.slots.find((s) => s.time === "11:00")).toMatchObject({ kind: "empty" })
  })

  it("살아있는 90분 확정은 예전처럼 뒤 칸을 점유한다(회귀 없음)", () => {
    const proj = buildTimeline({
      viewerRole: "exhibitor",
      viewerOrgId: EXHIBITOR,
      meetings: [
        received("live", "accepted", { durationMinutes: 90 }),
        received("dead", "rejected", { durationMinutes: 30 }),
      ],
      eventDates: DATES,
    })
    const day = proj.days[0]
    const slot = day.slots.find((s) => s.time === "10:00") as FilledSlot
    expect(slot.span).toBe(3)
    expect(slot.coveredTimes).toEqual(["10:30", "11:00"])
    expect(day.slots.some((s) => s.time === "10:30")).toBe(false)
    expect(day.slots.some((s) => s.time === "11:00")).toBe(false)
    expect(day.slots.find((s) => s.time === "11:30")).toMatchObject({ kind: "empty" })
  })

  it("같은 칸의 받은 신청은 응답대기 배지에 전부 집계된다(가려진 건이 없으므로)", () => {
    const proj = buildTimeline({
      viewerRole: "exhibitor",
      viewerOrgId: EXHIBITOR,
      meetings: [
        received("a", "proposed"),
        received("b", "proposed"),
        received("c", "proposed"),
      ],
      eventDates: DATES,
    })
    expect(proj.days[0].pendingCount).toBe(3)
    expect(proj.totalMeetings).toBe(3)
  })

  it("한 건뿐인 칸은 meetings 길이 1 — 기존 단일 케이스 그대로", () => {
    const slot = slotAt([received("solo", "accepted")])
    expect(slot.meetings).toHaveLength(1)
    expect(slot.meetings[0].meetingId).toBe("solo")
  })
})
