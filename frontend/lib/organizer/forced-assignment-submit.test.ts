// QA 3차 #2 — 강제 배정 저장 공용 함수. 배정 그리드(assignment-hub)·기업 상세(member-detail)가
// 같은 이 함수로 POST + 롤백을 처리한다(예전엔 기업 상세가 이 호출 자체를 빠뜨렸다).

import { afterEach, describe, expect, it, vi } from "vitest"
import { submitForcedAssignment } from "./forced-assignment-submit"
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

describe("submitForcedAssignment", () => {
  it("성공하면 true를 돌려주고 낙관적으로 넣어둔 목록을 그대로 둔다", async () => {
    postAssignmentsMock.mockResolvedValue({ success: true })
    const setMeetings = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings)

    expect(ok).toBe(true)
    expect(postAssignmentsMock).toHaveBeenCalledWith([meeting])
    expect(setMeetings).not.toHaveBeenCalled()
  })

  it("실패하면 false를 돌려주고 낙관적으로 넣어둔 meeting을 롤백 + 에러 토스트", async () => {
    postAssignmentsMock.mockResolvedValue({ success: false, error: "network" })
    const setMeetings = vi.fn()

    const ok = await submitForcedAssignment(meeting, setMeetings)

    expect(ok).toBe(false)
    expect(setMeetings).toHaveBeenCalledOnce()
    const updater = setMeetings.mock.calls[0][0] as (prev: AssignmentMeeting[]) => AssignmentMeeting[]
    expect(updater([meeting, { ...meeting, id: "other" }])).toEqual([{ ...meeting, id: "other" }])
    expect(toast.error).toHaveBeenCalledOnce()
  })
})
