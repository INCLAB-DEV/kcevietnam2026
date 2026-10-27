import { describe, it, expect } from "vitest"
import {
  confirmDraft,
  editDraftMeeting,
  generateSaturationDraft,
  proposeSingleOrgFill,
  removeDraftMeeting,
  singleFillOrderLabel,
  type SaturationInput,
} from "./saturation"
import { DEFAULT_SCHEDULE_SETTINGS } from "./schedule"
import type { AssignmentMeeting } from "./forced-assignment"
import type { BuyerType, Organization } from "@/lib/types"

const exOrg = (id: string): Organization => ({ id, name: id, role: "exhibitor", keywords: [] })
const buyerOrg = (id: string, buyerType: BuyerType): Organization => ({
  id,
  name: id,
  role: "buyer",
  keywords: [],
  buyerType,
})
// minSlots만 바꾸는 헬퍼(데모 그리드 기본값 그대로) + slotMinutes까지 오버라이드하는 헬퍼(아래
// "base 슬롯 여러 칸 점유" 테스트는 REQ-05 그리드 간격과 무관하게 base=30 고정값으로 일반 산술을 검증).
const settings = (minSlots: number) => ({ ...DEFAULT_SCHEDULE_SETTINGS, minSlots })
const settingsWithSlotMinutes = (minSlots: number, slotMinutes: number) => ({
  ...DEFAULT_SCHEDULE_SETTINGS,
  minSlots,
  slotMinutes,
})

describe("saturation assignMinutes (회의 길이 = base 슬롯 여러 칸 점유, 그리드 기준과 독립)", () => {
  it("assignMinutes=60·base 30이면 회의 1건이 연속 2칸을 점유하고 durationMinutes=60", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted")],
      fit: { E1: { B1: 50 } },
      applicationOrder: { E1: 1, B1: 1 },
      allSlotIds: ["2026-09-16T09:00", "2026-09-16T09:30", "2026-09-16T10:00", "2026-09-16T10:30"],
      existing: [],
      assignMinutes: 60,
    }
    const draft = generateSaturationDraft(input, settingsWithSlotMinutes(1, 30), 1) // base=30(테스트 고정값 — 데모 그리드의 실제 slotMinutes=45와 무관)
    expect(draft.meetings).toHaveLength(1)
    expect(draft.meetings[0]).toMatchObject({ slotId: "2026-09-16T09:00", durationMinutes: 60 })
  })

  it("footprint(회의 길이)가 슬롯 유니버스를 벗어나면(점심/종료 침범) 그 칸엔 배정 안 함", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted")],
      fit: { E1: { B1: 50 } },
      applicationOrder: { E1: 1, B1: 1 },
      // 09:30이 빠져 있어 60분(2칸) 회의는 09:00·10:00 어디서 시작해도 뒤칸이 유니버스 밖 → 배정 불가
      allSlotIds: ["2026-09-16T09:00", "2026-09-16T10:00"],
      existing: [],
      assignMinutes: 60,
    }
    expect(generateSaturationDraft(input, settingsWithSlotMinutes(1, 30), 1).meetings).toHaveLength(0)
  })
})

describe("saturation.generateSaturationDraft (전체 포화배정 Draft)", () => {
  // 진입 상태: 전체 일괄배정은 운영자 개입 채널(AI_SATURATION)이라 받는 쪽 바이어 유형과 무관하게
  // 즉시 확정이다(ADR-0005 2026-09-15 정정 / 발주자 QA B3, 백엔드 acceptance_rule의
  // _OPERATOR_OVERRIDE_CHANNELS와 동일). 바이어 유형 규칙은 단일 기업 자동채움(AI_RETRIGGER)에 남는다.
  it("참가사 최소 N까지 채우되 슬롯·상대는 중복 없이, 진입 상태는 전부 확정(운영자 개입 채널)", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted"), buyerOrg("B2", "pre_registered"), buyerOrg("B3", "pre_registered")],
      fit: { E1: { B1: 50, B2: 50, B3: 50 } }, // 동률 → 신청순 tie-break
      applicationOrder: { E1: 1, B1: 1, B2: 2, B3: 3 },
      allSlotIds: ["s1", "s2", "s3"],
      existing: [],
    }
    const draft = generateSaturationDraft(input, settings(2), 1)
    expect(draft.meetings).toHaveLength(2)
    expect(draft.meetings[0]).toMatchObject({ exhibitorId: "E1", buyerId: "B1", slotId: "s1", status: "accepted" })
    expect(draft.meetings[1]).toMatchObject({ exhibitorId: "E1", buyerId: "B2", slotId: "s2", status: "accepted" })
    expect(draft.runNumber).toBe(1)
  })

  it("단일 기업 자동채움(AI 재트리거)은 종전대로 바이어 유형이 진입 상태를 정한다", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted"), buyerOrg("B2", "pre_registered")],
      fit: { E1: { B1: 50, B2: 50 } },
      applicationOrder: { E1: 1, B1: 1, B2: 2 },
      allSlotIds: ["s1", "s2"],
      existing: [],
    }
    const drafts = proposeSingleOrgFill("E1", input, settings(2), 1)
    expect(drafts.map((d) => d.status)).toEqual(["accepted", "proposed"]) // 초청 / 사전등록
  })

  it("추가 전용·비파괴 — 기존 미팅을 건드리지 않고 빈 슬롯만 보충한다", () => {
    const existing: AssignmentMeeting[] = [
      { id: "x1", exhibitorId: "E1", buyerId: "B1", slotId: "s1", status: "accepted", matchingType: "forced" },
    ]
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted"), buyerOrg("B2", "pre_registered")],
      fit: { E1: { B1: 50, B2: 50 } },
      applicationOrder: { E1: 1, B1: 1, B2: 2 },
      allSlotIds: ["s1", "s2", "s3"],
      existing,
    }
    const before = input.existing
    const draft = generateSaturationDraft(input, settings(2), 2)
    expect(input.existing).toBe(before) // 입력 기존 배열은 그대로(안 건드림)
    expect(input.existing).toHaveLength(1)
    expect(draft.meetings).toHaveLength(1) // 기존 1 + 신규 1 = target 2
    const added = draft.meetings[0]
    expect(added.slotId).not.toBe("s1") // 점유 슬롯 재사용 안 함
    expect(added.buyerId).not.toBe("B1") // 이미 짝지은 상대 재사용 안 함
  })

  it("불가 슬롯은 건너뛴다 — 참가사·바이어 어느 쪽이 지정해도 그 슬롯엔 배정 안 함", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("B1", "hosted")],
      fit: { E1: { B1: 50 } },
      applicationOrder: { E1: 1, B1: 1 },
      allSlotIds: ["s1", "s2", "s3"],
      existing: [],
      unavailable: { E1: new Set(["s1"]), B1: new Set(["s2"]) }, // s1은 참가사 불가, s2는 바이어 불가
    }
    const draft = generateSaturationDraft(input, settings(3), 1)
    // s1(E1 불가)·s2(B1 불가) 제외 → s3에만 1건
    expect(draft.meetings).toHaveLength(1)
    expect(draft.meetings[0].slotId).toBe("s3")
  })

  it("동률일 때 비즈매칭 신청 빠른 기업을 먼저 배정한다(tie-break)", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1")],
      buyers: [buyerOrg("Blate", "pre_registered"), buyerOrg("Bearly", "pre_registered")], // 배열 순서는 일부러 늦은 쪽 먼저
      fit: { E1: { Bearly: 50, Blate: 50 } },
      applicationOrder: { E1: 1, Bearly: 1, Blate: 5 },
      allSlotIds: ["s1"],
      existing: [],
    }
    const draft = generateSaturationDraft(input, settings(1), 1)
    expect(draft.meetings[0].buyerId).toBe("Bearly")
  })
})

describe("saturation.proposeSingleOrgFill (기업명 옆 [⚡] 단일 자동채움)", () => {
  it("그 기업의 빈 슬롯만 채우고 다른 기업은 건드리지 않는다", () => {
    const input: SaturationInput = {
      exhibitors: [exOrg("E1"), exOrg("E2")],
      buyers: [buyerOrg("B1", "pre_registered"), buyerOrg("B2", "hosted")],
      fit: { E1: { B1: 50, B2: 50 }, E2: { B1: 50, B2: 50 } },
      applicationOrder: { E1: 1, E2: 2, B1: 1, B2: 2 },
      allSlotIds: ["s1", "s2"],
      existing: [],
    }
    const drafts = proposeSingleOrgFill("E1", input, settings(1), 1)
    expect(drafts).toHaveLength(1)
    expect(drafts.every((m) => m.exhibitorId === "E1")).toBe(true)
    expect(drafts[0].matchingType).toBe("ai") // 모드① 자동채움 = AI 재트리거
  })
})

describe("saturation Draft 검토 액션", () => {
  const input: SaturationInput = {
    exhibitors: [exOrg("E1")],
    buyers: [buyerOrg("B1", "hosted"), buyerOrg("B2", "pre_registered")],
    fit: { E1: { B1: 50, B2: 50 } },
    applicationOrder: { E1: 1, B1: 1, B2: 2 },
    allSlotIds: ["s1", "s2", "s3"],
    existing: [],
  }

  it("개별 삭제 / 슬롯 수정 / 확정", () => {
    const draft = generateSaturationDraft(input, settings(2), 1)
    const firstId = draft.meetings[0].id
    expect(removeDraftMeeting(draft, firstId).meetings).toHaveLength(1)
    const edited = editDraftMeeting(draft, firstId, { slotId: "s9" })
    expect(edited.meetings.find((m) => m.id === firstId)?.slotId).toBe("s9")
    expect(confirmDraft(draft)).toEqual(draft.meetings)
  })
})

// 리뷰 M2(2026-10-01) — 자동채움 확인창이 "AI 적합도 순"이라고 했지만 운영에선 추천 점수가 비어(#6)
// 실제로는 신청 순으로 골랐다. 문구가 엔진(candidateIds)의 실제 기준을 따르는지 잠근다.
describe("saturation.singleFillOrderLabel — 자동채움이 상대를 고른 실제 기준", () => {
  it("이 기업의 적합도 점수가 없으면 비즈매칭 신청 순", () => {
    expect(singleFillOrderLabel("e1", {})).toBe("비즈매칭 신청 순")
    expect(singleFillOrderLabel("e1", { e1: {} })).toBe("비즈매칭 신청 순")
    expect(singleFillOrderLabel("e1", { e1: { b1: 0 } })).toBe("비즈매칭 신청 순")
  })

  it("다른 기업의 점수만 있으면 여전히 신청 순(이 기업 후보 정렬엔 영향이 없다)", () => {
    expect(singleFillOrderLabel("e1", { e2: { b1: 87 } })).toBe("비즈매칭 신청 순")
  })

  it("이 기업의 점수가 있으면 AI 적합도 순(동률은 신청 순)", () => {
    expect(singleFillOrderLabel("e1", { e1: { b1: 87, b2: 0 } })).toBe(
      "AI 적합도 순(동률은 비즈매칭 신청 순)"
    )
  })
})
