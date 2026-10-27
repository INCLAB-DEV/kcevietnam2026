import { describe, it, expect } from "vitest"
import {
  aggregateOpsMetrics,
  hourlyDistribution,
  meetingStatusBreakdown,
  noshowRate,
  participantCounts,
  reviewCoverage,
  slotUsage,
  slotsPerDay,
  zeroMeetingExhibitorCount,
  type OpsMeeting,
  type OpsParticipant,
  type OpsReview,
  type ScheduleSettings,
} from "./ops-metrics"

const SCHEDULE: ScheduleSettings = {
  operatingStart: "09:00",
  operatingEnd: "18:00",
  slotMinutes: 30,
  slotGapMinutes: 0,
  // 점심 미설정 — 백엔드 OpsScheduleOut 이 NULL을 "00:00"/"00:00"으로 내려주는 관례와 같다.
  // slotTimes 는 이걸 빈 구간으로 봐서 아무 칸도 건너뛰지 않는다.
  lunchStart: "00:00",
  lunchEnd: "00:00",
  eventDays: 3,
}

function meeting(over: Partial<OpsMeeting>): OpsMeeting {
  return {
    id: "m",
    exhibitorOrgId: "ex-1",
    buyerOrgId: "by-1",
    status: "accepted",
    scheduledStart: "2026-09-16T10:00:00+09:00",
    ...over,
  }
}

describe("participantCounts — approved만 비즈매칭 참가자(ADR-0009)", () => {
  const participants: OpsParticipant[] = [
    { orgId: "ex-1", role: "exhibitor", approved: true },
    { orgId: "ex-2", role: "exhibitor", approved: false }, // submitted/registered → 참가자 아님
    { orgId: "by-1", role: "buyer", approved: true },
    { orgId: "by-2", role: "buyer", approved: true },
  ]
  it("approved 아닌 행은 참가자 수에 잡히지 않는다", () => {
    expect(participantCounts(participants)).toEqual({ exhibitor: 1, buyer: 2, total: 3 })
  })
})

describe("meetingStatusBreakdown — 운영 관점 묶음 + 노쇼 파생", () => {
  const meetings: OpsMeeting[] = [
    meeting({ id: "a", status: "proposed" }),
    meeting({ id: "b", status: "accepted" }),
    meeting({ id: "c", status: "completed" }), // 정상 완료
    meeting({ id: "d", status: "completed" }), // 노쇼(아래 리뷰)
    meeting({ id: "e", status: "cancelled" }),
    meeting({ id: "f", status: "rejected" }),
  ]
  const reviews: OpsReview[] = [
    { meetingId: "d", reviewerOrgId: "ex-1", counterpartNoshow: true, selfNoshow: false },
    { meetingId: "c", reviewerOrgId: "ex-1", counterpartNoshow: false, selfNoshow: false },
  ]
  it("예정=proposed+accepted, 취소=cancelled+rejected, 노쇼=completed∧리뷰노쇼", () => {
    expect(meetingStatusBreakdown(meetings, reviews)).toEqual({
      scheduled: 2,
      completed: 1, // c 만 — d 는 노쇼로 빠짐
      cancelled: 2,
      noshow: 1,
    })
  })
  it("취소/거부 건의 노쇼 리뷰는 노쇼로 집계하지 않는다(completed에서만 의미)", () => {
    const bad: OpsReview[] = [{ meetingId: "e", reviewerOrgId: "ex-1", counterpartNoshow: true, selfNoshow: false }]
    expect(meetingStatusBreakdown(meetings, bad).noshow).toBe(0)
  })
  it("self_noshow('내가 불참') 단독 리뷰도 counterpart_noshow와 동일하게 노쇼로 집계한다", () => {
    const selfNoshowOnly: OpsReview[] = [
      { meetingId: "d", reviewerOrgId: "ex-1", counterpartNoshow: false, selfNoshow: true },
      { meetingId: "c", reviewerOrgId: "ex-1", counterpartNoshow: false, selfNoshow: false },
    ]
    expect(meetingStatusBreakdown(meetings, selfNoshowOnly)).toEqual({
      scheduled: 2,
      completed: 1,
      cancelled: 2,
      noshow: 1,
    })
  })
})

describe("noshowRate — noshow/(completed+noshow)", () => {
  it("완료 4 + 노쇼 1 → 0.2", () => {
    expect(noshowRate({ scheduled: 0, completed: 4, cancelled: 0, noshow: 1 })).toBeCloseTo(0.2)
  })
  it("완료 미팅이 없으면 0(나눗셈 방어)", () => {
    expect(noshowRate({ scheduled: 5, completed: 0, cancelled: 0, noshow: 0 })).toBe(0)
  })
})

describe("reviewCoverage — 완료 대비 후기 작성률(완료×2 분모)", () => {
  const meetings: OpsMeeting[] = [
    meeting({ id: "c1", status: "completed" }),
    meeting({ id: "c2", status: "completed" }),
    meeting({ id: "s1", status: "accepted" }), // 완료 아님 → 분모/분자 무관
  ]
  it("완료 2건(4 기대) 중 리뷰 3행 → 0.75", () => {
    const reviews: OpsReview[] = [
      { meetingId: "c1", reviewerOrgId: "ex-1", counterpartNoshow: false, selfNoshow: false },
      { meetingId: "c1", reviewerOrgId: "by-1", counterpartNoshow: false, selfNoshow: false },
      { meetingId: "c2", reviewerOrgId: "ex-1", counterpartNoshow: false, selfNoshow: false },
    ]
    expect(reviewCoverage(meetings, reviews)).toEqual({ submitted: 3, expected: 4, rate: 0.75 })
  })
  it("완료 미팅이 없으면 rate 0", () => {
    expect(reviewCoverage([meeting({ status: "accepted" })], []).rate).toBe(0)
  })
})

describe("slotsPerDay / slotUsage — 운영변수에서 파생, 취소는 제외", () => {
  it("09:00–18:00 / 30분 / 점심 없음 → 18칸", () => {
    expect(slotsPerDay(SCHEDULE)).toBe(18)
  })

  // 계약서 §4 — 하루 슬롯 총량은 slotMinutes가 아니라 stride(=slotMinutes+slotGapMinutes) 기준.
  // 40분을 간격으로 쓰면 12칸이 나와 과다하다.
  it("gap이 있으면 stride 기준으로 센다 — 40분/5분텀(stride 45), 점심 없으면 11칸", () => {
    const withGap: ScheduleSettings = {
      ...SCHEDULE,
      operatingStart: "10:00",
      operatingEnd: "18:10",
      slotMinutes: 40,
      slotGapMinutes: 5,
    }
    expect(slotsPerDay(withGap)).toBe(11)
  })

  it("점심 블록에 걸치는 칸은 빼고 센다 — 09:00~18:00/30분/점심12~13 은 18이 아니라 16칸", () => {
    // 회귀 방지: 구버전은 점심을 빼지 않아 분모가 2칸 부풀었고, 그 결과 대시보드의 슬롯 사용률이
    // 실제보다 낮게 표시됐다(프로덕션 점심은 12:00~13:00 으로 **설정돼 있었다** — "점심이 NULL이라
    // 드러나지 않았다"는 옛 주석은 사실이 아니었다).
    expect(slotsPerDay({ ...SCHEDULE, lunchStart: "12:00", lunchEnd: "13:00" })).toBe(16)
  })

  it("발주사 격자 — 10:00~18:10 / 40분 / 텀5분 / 점심 12:10~13:00 → 10칸", () => {
    // 백엔드 slot_grid.build_grid 가 만드는 실제 격자와 같은 값이어야 한다
    // (backend/tests/test_slot_grid.py::test_client_grid_day_is_reproduced_exactly).
    // 근사 산술이 아니라 organizer/schedule.slotTimes 로 위임하므로 둘이 갈라질 수 없다.
    const client: ScheduleSettings = {
      ...SCHEDULE,
      operatingStart: "10:00",
      operatingEnd: "18:10",
      slotMinutes: 40,
      slotGapMinutes: 5,
      lunchStart: "12:10",
      lunchEnd: "13:00",
    }
    expect(slotsPerDay(client)).toBe(10)
  })
  it("취소·거부 미팅은 점유 슬롯에서 빠진다", () => {
    const participants: OpsParticipant[] = [
      { orgId: "ex-1", role: "exhibitor", approved: true },
      { orgId: "ex-2", role: "exhibitor", approved: true },
    ]
    const meetings: OpsMeeting[] = [
      meeting({ id: "a", status: "accepted" }),
      meeting({ id: "b", status: "completed" }),
      meeting({ id: "c", status: "cancelled" }), // 제외
      meeting({ id: "d", status: "rejected" }), // 제외
    ]
    const usage = slotUsage(participants, meetings, SCHEDULE)
    // total = 승인참가사 2 × 18칸 × 3일 = 108, assigned = 활성 2
    expect(usage).toEqual({ assigned: 2, total: 108, rate: 2 / 108 })
  })
})

describe("zeroMeetingExhibitorCount — 활성 미팅 없는 approved 참가사만", () => {
  const participants: OpsParticipant[] = [
    { orgId: "ex-1", role: "exhibitor", approved: true },
    { orgId: "ex-2", role: "exhibitor", approved: true }, // 미팅 0건
    { orgId: "ex-3", role: "exhibitor", approved: false }, // 미승인 → 모집단 아님
    { orgId: "by-1", role: "buyer", approved: true }, // 바이어는 대상 아님
  ]
  it("취소뿐인 참가사는 0건으로 친다(활성만 모집단)", () => {
    const meetings: OpsMeeting[] = [
      meeting({ exhibitorOrgId: "ex-1", status: "accepted" }),
      meeting({ exhibitorOrgId: "ex-2", status: "cancelled" }), // 활성 아님 → ex-2 는 여전히 0건
    ]
    expect(zeroMeetingExhibitorCount(participants, meetings)).toBe(1)
  })
})

describe("hourlyDistribution — 시(hour) 버킷·예정/완료/노쇼, 취소 제외", () => {
  const meetings: OpsMeeting[] = [
    meeting({ id: "a", status: "accepted", scheduledStart: "2026-09-16T10:00:00+09:00" }),
    meeting({ id: "b", status: "proposed", scheduledStart: "2026-09-17T10:30:00+09:00" }), // 같은 10시 버킷
    meeting({ id: "c", status: "completed", scheduledStart: "2026-09-16T14:00:00+09:00" }),
    meeting({ id: "d", status: "completed", scheduledStart: "2026-09-16T14:00:00+09:00" }), // 노쇼
    meeting({ id: "e", status: "cancelled", scheduledStart: "2026-09-16T11:00:00+09:00" }), // 제외
    meeting({ id: "f", status: "accepted", scheduledStart: null }), // 시간 미정 → 제외
  ]
  const reviews: OpsReview[] = [
    { meetingId: "d", reviewerOrgId: "ex-1", counterpartNoshow: true, selfNoshow: false },
  ]
  const buckets = hourlyDistribution(meetings, reviews, SCHEDULE)
  it("운영시간 범위(09–17시)의 칸을 만든다", () => {
    expect(buckets.map((b) => b.hour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
  it("10시 버킷에 예정 2건이 쌓인다", () => {
    expect(buckets.find((b) => b.hour === 10)).toMatchObject({ scheduled: 2, completed: 0, noshow: 0 })
  })
  it("14시 버킷에 완료 1·노쇼 1이 갈린다", () => {
    expect(buckets.find((b) => b.hour === 14)).toMatchObject({ completed: 1, noshow: 1 })
  })
  it("취소 건은 어느 칸에도 들어가지 않는다(11시 비어 있음)", () => {
    expect(buckets.find((b) => b.hour === 11)).toMatchObject({ scheduled: 0, completed: 0, noshow: 0 })
  })

  it("비정시 운영시간(09:30–17:30)에서 창 밖 미팅은 집계하지 않는다", () => {
    const window: ScheduleSettings = { ...SCHEDULE, operatingStart: "09:30", operatingEnd: "17:30" }
    const m: OpsMeeting[] = [
      meeting({ id: "before", status: "accepted", scheduledStart: "2026-09-16T09:00:00+09:00" }), // 창 밖(9:00<9:30)
      meeting({ id: "edge-in", status: "accepted", scheduledStart: "2026-09-16T09:30:00+09:00" }), // 창 안(경계 포함)
      meeting({ id: "after", status: "accepted", scheduledStart: "2026-09-16T17:45:00+09:00" }), // 창 밖(17:45≥17:30)
    ]
    const out = hourlyDistribution(m, [], window)
    // 9시 버킷엔 edge-in 1건만(09:00 제외), 17시 버킷은 비어 있어야 한다(17:45 제외).
    expect(out.find((b) => b.hour === 9)).toMatchObject({ scheduled: 1 })
    expect(out.find((b) => b.hour === 17)).toMatchObject({ scheduled: 0 })
  })
})

describe("aggregateOpsMetrics — 단일 묶음 조립", () => {
  it("전체 비즈매칭(활성) 수 = 예정+완료+노쇼(취소 제외)", () => {
    const metrics = aggregateOpsMetrics({
      roster: { exhibitorRegistrants: 103, buyerRegistrants: 178 },
      participants: [
        { orgId: "ex-1", role: "exhibitor", approved: true },
        { orgId: "by-1", role: "buyer", approved: true },
      ],
      meetings: [
        meeting({ id: "a", status: "accepted" }),
        meeting({ id: "b", status: "completed" }),
        meeting({ id: "c", status: "cancelled" }),
      ],
      reviews: [],
      schedule: SCHEDULE,
    })
    expect(metrics.totalMeetings).toBe(2) // 취소 제외
    expect(metrics.roster.total).toBe(281)
    expect(metrics.participants.total).toBe(2)
    expect(metrics.status.cancelled).toBe(1)
  })
})
