// QA 3차 #2 — 강제 배정 저장 공용 함수. 배정 그리드(assignment-hub)·기업 상세(member-detail)가
// 같은 이 함수로 POST + 롤백을 처리한다(예전엔 기업 상세가 이 호출 자체를 빠뜨렸다).
//
// 2026-10-01 고객 신고 "배정 저장에 실패했어요 · 네트워크 확인 후 다시 시도해 주세요" — 실제 원인은
// 장소 충돌(VENUE_TAKEN)·장소 없음(no_venue)이었는데 화면은 이유와 무관하게 네트워크 탓을 했다.
// 여기서 원인별 문구 매핑과 "네트워크 문구는 진짜 네트워크 실패일 때만"을 잠근다.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  addConfirmed,
  describeAssignmentError,
  isStaleConflict,
  pendingNotYetListed,
  submitAssignments,
  submitForcedAssignment,
} from "./forced-assignment-submit"
import type { AssignmentActionResult } from "./assignment-actions"
import type { AssignmentMeeting } from "./forced-assignment"

const { postAssignmentsMock } = vi.hoisted(() => ({ postAssignmentsMock: vi.fn() }))
vi.mock("./assignment-actions", () => ({
  postAssignments: postAssignmentsMock,
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { toast } from "sonner"

afterEach(() => vi.clearAllMocks())

const meeting: AssignmentMeeting = {
  id: "forced-b1-e1-slot",
  exhibitorId: "e1",
  buyerId: "b1",
  slotId: "2026-10-20T10:00",
  status: "accepted",
  matchingType: "forced",
} as AssignmentMeeting

const failure = (over: Partial<AssignmentActionResult>): AssignmentActionResult => ({
  success: false,
  ...over,
})

describe("submitForcedAssignment", () => {
  it("성공하면 true를 돌려주고 낙관적으로 넣어둔 목록을 그대로 둔다 — 토스트도 내지 않는다(성공 문구는 호출부가 2xx 뒤에)", async () => {
    postAssignmentsMock.mockResolvedValue({ success: true })
    const setMeetings = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings)

    expect(ok).toBe(true)
    expect(postAssignmentsMock).toHaveBeenCalledWith([meeting])
    expect(setMeetings).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("진짜 네트워크 실패면 false + 낙관적 meeting 롤백 + 네트워크 안내 토스트", async () => {
    postAssignmentsMock.mockResolvedValue({ success: false, error: "network" })
    const setMeetings = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings)

    expect(ok).toBe(false)
    expect(setMeetings).toHaveBeenCalledOnce()
    const updater = setMeetings.mock.calls[0][0] as (prev: AssignmentMeeting[]) => AssignmentMeeting[]
    expect(updater([meeting, { ...meeting, id: "other" }])).toEqual([{ ...meeting, id: "other" }])
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith("배정 저장에 실패했어요", {
      description: "네트워크 확인 후 다시 시도해 주세요.",
    })
  })

  it("백엔드가 이유를 들고 거절하면(VENUE_TAKEN) 그 이유를 보여주고, 서버 진실로 다시 그리게 한다", async () => {
    postAssignmentsMock.mockResolvedValue({
      success: false,
      error: "VENUE_TAKEN",
      message: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
    })
    const setMeetings = vi.fn()
    const onResync = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings, undefined, { onResync })

    expect(ok).toBe(false)
    expect(setMeetings).toHaveBeenCalledOnce() // 롤백
    expect(toast.error).toHaveBeenCalledWith("미팅 장소가 이미 사용 중이에요", {
      description: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
    })
    expect(onResync).toHaveBeenCalledOnce()
  })

  it("SLOT_TAKEN은 막힌 쪽을 당사자 이름으로 말한다", async () => {
    postAssignmentsMock.mockResolvedValue({ success: false, error: "SLOT_TAKEN", busyRoles: ["buyer"] })

    await submitForcedAssignment(meeting, vi.fn(), undefined, {
      partiesOf: () => ({ exhibitorName: "한빛디펜스", buyerName: "Global Marine" }),
    })

    expect(toast.error).toHaveBeenCalledWith("같은 시각에 이미 미팅이 있어요", {
      description:
        "바이어 Global Marine에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.",
    })
  })

  // 세션 만료(2026-09-30) — upstream 401을 write 라우트가 "session_expired"로 통일해 내려준다.
  // "네트워크 확인 후 다시 시도"는 오도한다(재시도해도 401이 반복될 뿐이다) — 별도 안내 + 재로그인.
  it("세션 만료면 롤백은 그대로 하되 세션 만료 토스트 + 리다이렉트 핸들러를 부른다(일반 토스트는 안 부른다)", async () => {
    postAssignmentsMock.mockResolvedValue({ success: false, error: "session_expired" })
    const setMeetings = vi.fn()
    const onSessionExpired = vi.fn()
    const onResync = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings, onSessionExpired, { onResync })

    expect(ok).toBe(false)
    expect(setMeetings).toHaveBeenCalledOnce() // 낙관적 반영 롤백은 그대로
    const updater = setMeetings.mock.calls[0][0] as (prev: AssignmentMeeting[]) => AssignmentMeeting[]
    expect(updater([meeting, { ...meeting, id: "other" }])).toEqual([{ ...meeting, id: "other" }])
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith("세션이 만료됐어요", {
      description: "다시 로그인해 주세요.",
    })
    expect(onSessionExpired).toHaveBeenCalledOnce()
    expect(onResync).not.toHaveBeenCalled()
  })
})

describe("submitAssignments — ⚡ 배치", () => {
  const batch: AssignmentMeeting[] = [
    { ...meeting, id: "fill-1-0", buyerId: "b1" },
    { ...meeting, id: "fill-1-1", buyerId: "b2", slotId: "2026-10-20T10:30" },
    { ...meeting, id: "fill-1-2", buyerId: "b3", slotId: "2026-10-20T11:00" },
  ]

  it("중간에 실패하면 배치 전체를 롤백하고, 부분 저장 제목·실패한 그 항목의 당사자로 알린 뒤 다시 그리게 한다", async () => {
    postAssignmentsMock.mockResolvedValue({
      success: false,
      error: "SLOT_TAKEN",
      busyRoles: ["buyer"],
      savedCount: 1,
    })
    const setPending = vi.fn()
    const partiesOf = vi.fn((m: AssignmentMeeting) => ({ exhibitorName: "참가사1", buyerName: m.buyerId }))
    const onResync = vi.fn()

    const ok = await submitAssignments(batch, setPending, {
      partiesOf,
      failureTitle: (r) => (r.savedCount ? `빈 슬롯 3건 중 ${r.savedCount}건만 배정됐어요` : undefined),
      onResync,
    })

    expect(ok).toBe(false)
    const updater = setPending.mock.calls[0][0] as (prev: AssignmentMeeting[]) => AssignmentMeeting[]
    expect(updater([...batch, { ...meeting, id: "keep" }])).toEqual([{ ...meeting, id: "keep" }])
    // 앞에서 1건 저장 후 멈췄다 = 두 번째(b2) 항목이 실패 건이다.
    expect(partiesOf).toHaveBeenCalledWith(batch[1])
    expect(toast.error).toHaveBeenCalledWith("빈 슬롯 3건 중 1건만 배정됐어요", {
      description: "바이어 b2에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.",
    })
    expect(onResync).toHaveBeenCalledOnce()
  })

  it("저장된 것도 없고 경합도 아니면(일반 서버 오류) 다시 그리지 않는다", async () => {
    postAssignmentsMock.mockResolvedValue({ success: false, error: "server_error" })
    const onResync = vi.fn()

    await submitAssignments(batch, vi.fn(), { onResync })

    expect(onResync).not.toHaveBeenCalled()
  })
})

describe("describeAssignmentError — 원인별 문구", () => {
  const parties = { exhibitorName: "한빛디펜스", buyerName: "Global Marine" }

  it.each([
    [["exhibitor"], "참가사 한빛디펜스에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요."],
    [["buyer"], "바이어 Global Marine에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요."],
    [
      ["exhibitor", "buyer"],
      "참가사 한빛디펜스, 바이어 Global Marine 모두 그 시각에 이미 확정된 미팅이 있어요. 다른 시간을 골라 주세요.",
    ],
    [[], "그 시각에 이미 확정된 미팅이 있어요. 화면을 새로 고쳐 최신 배정을 확인해 주세요."],
  ] as const)("SLOT_TAKEN busyRoles=%j", (busyRoles, description) => {
    expect(
      describeAssignmentError(failure({ error: "SLOT_TAKEN", busyRoles: [...busyRoles] }), parties),
    ).toEqual({ title: "같은 시각에 이미 미팅이 있어요", description })
  })

  it("이름을 모르면 역할만으로 말한다", () => {
    expect(
      describeAssignmentError(failure({ error: "SLOT_TAKEN", busyRoles: ["exhibitor"] })).description,
    ).toBe("참가사에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.")
  })

  it.each([
    ["VENUE_TAKEN", "미팅 장소가 이미 사용 중이에요"],
    ["VENUE_TYPE_DISABLED", "배정할 미팅 장소가 없어요"],
    ["SLOT_INVALID", "배정할 수 없는 시간이에요"],
    ["invalid_slot", "배정할 수 없는 시간이에요"],
    ["EVENT_SCHEDULE_UNSET", "행사 일정이 설정되지 않았어요"],
  ])("%s는 원인 제목 + 백엔드 message를 설명으로", (error, title) => {
    expect(describeAssignmentError(failure({ error, message: "백엔드가 준 이유" }))).toEqual({
      title,
      description: "백엔드가 준 이유",
    })
  })

  it("백엔드 message가 없으면 원인별 기본 설명으로", () => {
    expect(describeAssignmentError(failure({ error: "VENUE_TAKEN" })).description).toBe(
      "그 시각에 비어 있는 미팅 장소가 없어요. 다른 시간을 골라 주세요.",
    )
    expect(describeAssignmentError(failure({ error: "EVENT_SCHEDULE_UNSET" })).description).toBe(
      "행사 설정에서 운영시간과 전시 기간을 먼저 저장해 주세요.",
    )
  })

  it("행사를 못 찾으면(no_event) 행사 재선택 안내", () => {
    expect(describeAssignmentError(failure({ error: "no_event" }))).toEqual({
      title: "선택된 행사를 찾지 못했어요",
      description: "행사를 다시 선택한 뒤 시도해 주세요.",
    })
  })

  it("모르는 코드는 일반 실패 — 백엔드 message가 있으면 그것을, 없으면 서버 오류 안내(네트워크 탓 아님)", () => {
    expect(describeAssignmentError(failure({ error: "BUYER_NOT_FOUND", message: "이 행사의 바이어로 등록된 기업이 아닙니다." }))).toEqual({
      title: "배정 저장에 실패했어요",
      description: "이 행사의 바이어로 등록된 기업이 아닙니다.",
    })
    expect(describeAssignmentError(failure({ error: "server_error" }))).toEqual({
      title: "배정 저장에 실패했어요",
      description: "서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
    })
  })

  it("'네트워크' 문구는 진짜 네트워크 실패(fetch 예외)일 때만 나온다", () => {
    const nonNetwork = [
      "SLOT_TAKEN",
      "VENUE_TAKEN",
      "VENUE_TYPE_DISABLED",
      "SLOT_INVALID",
      "invalid_slot",
      "EVENT_SCHEDULE_UNSET",
      "DUPLICATE_APPLICATION",
      "no_event",
      "no_venue",
      "server_error",
      "http_500",
      undefined,
    ]
    for (const error of nonNetwork) {
      const copy = describeAssignmentError(failure({ error }))
      expect(`${copy.title} ${copy.description}`, String(error)).not.toContain("네트워크")
    }
    expect(describeAssignmentError(failure({ error: "network" })).description).toContain("네트워크")
  })

  it("경합 코드(SLOT_TAKEN·VENUE_TAKEN·DUPLICATE_APPLICATION)만 '서버 상태가 바뀜'으로 본다", () => {
    expect(isStaleConflict(failure({ error: "SLOT_TAKEN" }))).toBe(true)
    expect(isStaleConflict(failure({ error: "VENUE_TAKEN" }))).toBe(true)
    expect(isStaleConflict(failure({ error: "DUPLICATE_APPLICATION" }))).toBe(true)
    expect(isStaleConflict(failure({ error: "network" }))).toBe(false)
    expect(isStaleConflict(failure({ error: "VENUE_TYPE_DISABLED" }))).toBe(false)
  })
})

describe("저장 중 목록 ↔ 서버 목록", () => {
  const pending: AssignmentMeeting = { ...meeting, id: "forced-local" }
  const listedSame: AssignmentMeeting = { ...meeting, id: "server-uuid" }

  it("서버 목록에 이미 들어온 저장 중 건은 다시 그리지 않는다(한 칸 이중 표시 방지)", () => {
    expect(pendingNotYetListed([pending], [listedSame])).toEqual([])
    expect(pendingNotYetListed([pending], [])).toEqual([pending])
  })

  it("죽은 이력(취소·거절)은 같은 칸이어도 저장 중 건을 가리지 않는다", () => {
    expect(pendingNotYetListed([pending], [{ ...listedSame, status: "cancelled" }])).toEqual([pending])
  })

  it("확정 목록에 더할 때 이미 들어온 건은 중복으로 넣지 않는다", () => {
    expect(addConfirmed([listedSame], [pending])).toEqual([listedSame])
    expect(addConfirmed([], [pending])).toEqual([pending])
  })
})
