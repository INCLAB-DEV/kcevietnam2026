import { describe, it, expect } from "vitest"
import {
  isDeadSlotMeeting,
  occupyingSlotMeeting,
  pickSlotMeeting,
  sortSlotMeetings,
} from "./slot-pick"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"

function m(id: string, status: ScheduleStatus) {
  return { id, status }
}

// #2 — 슬롯당 하나를 고른다면 올바른 것을 고른다: 죽은 미팅(rejected/cancelled)이 산 미팅
// (accepted/proposed)을 절대 가리지 않는다. 타임라인·배정그리드가 공유하는 단일 규칙(회귀 테스트).
describe("pickSlotMeeting", () => {
  it("{rejected, accepted} → accepted가 이긴다", () => {
    const winner = pickSlotMeeting([m("rejected", "rejected"), m("accepted", "accepted")])
    expect(winner?.id).toBe("accepted")
  })

  it("{cancelled, cancelled, accepted} → accepted가 이긴다(순서 무관)", () => {
    const winner = pickSlotMeeting([
      m("c1", "cancelled"),
      m("c2", "cancelled"),
      m("accepted", "accepted"),
    ])
    expect(winner?.id).toBe("accepted")
  })

  it("{rejected만} → 배열 앞쪽(=최신, 호출부 계약)이 이긴다", () => {
    const winner = pickSlotMeeting([m("newest", "rejected"), m("oldest", "rejected")])
    expect(winner?.id).toBe("newest")
  })

  it("우선순위: accepted > proposed > completed > rejected/cancelled", () => {
    expect(pickSlotMeeting([m("p", "proposed"), m("c", "completed")])?.id).toBe("p")
    expect(pickSlotMeeting([m("c", "completed"), m("r", "rejected")])?.id).toBe("c")
    expect(pickSlotMeeting([m("a", "accepted"), m("p", "proposed")])?.id).toBe("a")
  })

  it("rejected와 cancelled는 동일 등급 — 먼저 나온(=최신) 쪽이 이긴다", () => {
    expect(pickSlotMeeting([m("rejected", "rejected"), m("cancelled", "cancelled")])?.id).toBe(
      "rejected"
    )
    expect(pickSlotMeeting([m("cancelled", "cancelled"), m("rejected", "rejected")])?.id).toBe(
      "cancelled"
    )
  })

  it("빈 배열이면 undefined", () => {
    expect(pickSlotMeeting([])).toBeUndefined()
  })

  it("한 건뿐이면 그대로 반환", () => {
    expect(pickSlotMeeting([m("only", "proposed")])?.id).toBe("only")
  })

  // 운영자 배정 그리드(assignment-hub.tsx meetingAt)의 실제 호출 패턴 회귀 테스트 — 백엔드가
  // created_at 오름차순(오래된 게 먼저)으로 내려주므로, 넘기기 전에 .reverse()로 최신을 앞으로
  // 보내야 pickSlotMeeting의 "배열 앞쪽=최신" 계약과 맞는다(#2 원인②).
  it("운영자 그리드 패턴 — 오래된순 배열을 reverse해서 넘기면 최신 거절이 이긴다(뒤집지 않으면 틀린다)", () => {
    const oldestFirst = [m("oldest-rejected", "rejected"), m("newest-rejected", "rejected")]
    expect(pickSlotMeeting([...oldestFirst].reverse())?.id).toBe("newest-rejected")
    // reverse 없이 그대로 넘기면(옛 버그와 동일 실수) 오래된 쪽이 이겨버린다는 것도 함께 확인.
    expect(pickSlotMeeting(oldestFirst)?.id).toBe("oldest-rejected")
  })

  it("운영자 그리드 패턴 — 오래된 거절 다음에 최신 수락이 와도(오름차순) reverse 후엔 수락이 이긴다", () => {
    const oldestFirst = [m("old-rejected", "rejected"), m("new-accepted", "accepted")]
    expect(pickSlotMeeting([...oldestFirst].reverse())?.id).toBe("new-accepted")
  })
})

// #10 — "슬롯 = 미팅 1개" 가정을 버렸다. 한 칸의 미팅을 **전부** 표시 순서로 내려주고,
// 대표 1건(칸 톤·진행 중 판정)과 점유 1건(뒤 칸 가림)만 따로 고른다. 타임라인·배정그리드 공유 규칙.
describe("sortSlotMeetings", () => {
  it("활성(확정·대기)이 위, 죽은 것(거절·취소)이 아래 — 아무도 사라지지 않는다", () => {
    const sorted = sortSlotMeetings([
      m("r", "rejected"),
      m("p", "proposed"),
      m("c", "cancelled"),
      m("a", "accepted"),
    ])
    expect(sorted.map((x) => x.id)).toEqual(["a", "p", "r", "c"])
  })

  it("동급이면 배열 앞쪽(=최신, 호출부 계약)이 위 — 안정 정렬", () => {
    const sorted = sortSlotMeetings([
      m("newest", "proposed"),
      m("middle", "proposed"),
      m("oldest", "proposed"),
    ])
    expect(sorted.map((x) => x.id)).toEqual(["newest", "middle", "oldest"])
  })

  it("첫 원소는 언제나 pickSlotMeeting의 대표 건과 같다(두 함수가 같은 규칙을 쓴다)", () => {
    const candidates = [m("c", "cancelled"), m("p", "proposed"), m("a", "accepted")]
    expect(sortSlotMeetings(candidates)[0]).toBe(pickSlotMeeting(candidates))
  })

  it("입력 배열을 제자리에서 뒤섞지 않는다", () => {
    const candidates = [m("r", "rejected"), m("a", "accepted")]
    sortSlotMeetings(candidates)
    expect(candidates.map((x) => x.id)).toEqual(["r", "a"])
  })

  it("빈 배열이면 빈 배열", () => {
    expect(sortSlotMeetings([])).toEqual([])
  })
})

describe("occupyingSlotMeeting — 죽은 미팅은 뒤 칸을 삼키지 않는다", () => {
  it("대표가 살아 있으면 그 건이 뒤 칸을 점유한다", () => {
    expect(occupyingSlotMeeting([m("r", "rejected"), m("a", "accepted")])?.id).toBe("a")
    expect(occupyingSlotMeeting([m("c", "cancelled"), m("p", "proposed")])?.id).toBe("p")
  })

  it("완료(completed)는 실제로 있었던 미팅이라 점유를 유지한다", () => {
    expect(occupyingSlotMeeting([m("done", "completed"), m("r", "rejected")])?.id).toBe("done")
  })

  it("거절·취소만 남은 칸은 아무것도 점유하지 않는다 — 90분 거절이 뒤의 빈 칸을 감추지 않게", () => {
    expect(occupyingSlotMeeting([m("r", "rejected"), m("c", "cancelled")])).toBeUndefined()
  })

  it("빈 배열이면 undefined", () => {
    expect(occupyingSlotMeeting([])).toBeUndefined()
  })
})

describe("isDeadSlotMeeting", () => {
  it("거절·취소만 죽은 미팅", () => {
    expect(isDeadSlotMeeting("rejected")).toBe(true)
    expect(isDeadSlotMeeting("cancelled")).toBe(true)
    expect(isDeadSlotMeeting("accepted")).toBe(false)
    expect(isDeadSlotMeeting("proposed")).toBe(false)
    expect(isDeadSlotMeeting("completed")).toBe(false)
  })
})
