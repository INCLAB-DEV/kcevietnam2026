import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { buildUnavailableSlotGrid, toggleUnavailableSlot } from "@/lib/operator/slot-grid"

import { UnavailableSlotGrid } from "./unavailable-slot-grid"

// 미팅 불가 시간 격자 — 운영자 콘솔 세 곳(행사 설정·대리작성·신청서 편집 패널)이 함께 쓴다.
// 축과 칸 id가 한 곳에서만 만들어지는지(= 백엔드 저장 키와 같은지)를 고정한다.

const event = { exhibition_start: "2026-10-20", exhibition_end: "2026-10-21" }
const settings = {
  operating_start: "10:00:00", // 백엔드 원응답은 초까지 온다
  operating_end: "13:00:00",
  lunch_start: "12:00:00",
  lunch_end: "13:00:00",
  slot_minutes: 40,
  slot_gap_minutes: 5,
}

describe("buildUnavailableSlotGrid", () => {
  it("행사 기간 × 하루 슬롯(길이+텀, 점심 제외)으로 축을 만든다", () => {
    expect(buildUnavailableSlotGrid(event, settings)).toEqual({
      dateIds: ["2026-10-20", "2026-10-21"],
      times: ["10:00", "10:45"], // 11:30~12:10은 점심(12:00~)과 겹쳐 빠진다
    })
  })

  it("콘솔 타입의 'HH:MM' 시각과 점심 미설정(null)도 받는다", () => {
    expect(
      buildUnavailableSlotGrid(event, {
        operating_start: "10:00",
        operating_end: "12:00",
        lunch_start: null,
        lunch_end: null,
        slot_minutes: 60,
      }),
    ).toEqual({ dateIds: ["2026-10-20", "2026-10-21"], times: ["10:00", "11:00"] })
  })

  it("행사·설정을 못 읽었거나 격자가 비면 null — 지어낸 격자를 만들지 않는다", () => {
    expect(buildUnavailableSlotGrid(null, settings)).toBeNull()
    expect(buildUnavailableSlotGrid(event, null)).toBeNull()
    expect(buildUnavailableSlotGrid({ exhibition_start: "", exhibition_end: "" }, settings)).toBeNull()
    expect(buildUnavailableSlotGrid(event, { ...settings, slot_minutes: 0 })).toBeNull()
  })
})

describe("toggleUnavailableSlot", () => {
  it("없으면 넣고(정렬), 있으면 뺀 전체 목록을 돌려준다", () => {
    expect(toggleUnavailableSlot(["2026-10-21T10:00"], "2026-10-20T10:45")).toEqual([
      "2026-10-20T10:45",
      "2026-10-21T10:00",
    ])
    expect(toggleUnavailableSlot(["2026-10-20T10:45", "2026-10-21T10:00"], "2026-10-21T10:00")).toEqual([
      "2026-10-20T10:45",
    ])
  })
})

describe("UnavailableSlotGrid", () => {
  const grid = { dateIds: ["2026-10-20", "2026-10-21"], times: ["10:00", "10:45"] }

  it("칸을 누르면 그 칸의 id(날짜T시각)로 알린다", async () => {
    const onToggle = vi.fn()
    render(<UnavailableSlotGrid grid={grid} blocked={["2026-10-20T10:00"]} onToggle={onToggle} />)

    expect(screen.getAllByRole("button")).toHaveLength(4)
    const blocked = screen.getByRole("button", { name: /10\/20 .* 10:00 불가 해제/ })
    expect(blocked).toHaveAttribute("aria-pressed", "true")

    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 10:45 불가 지정/ }))
    expect(onToggle).toHaveBeenCalledWith("2026-10-21T10:45")
  })

  it("읽기 전용이면 칸은 보이되 눌리지 않는다", async () => {
    const onToggle = vi.fn()
    render(<UnavailableSlotGrid grid={grid} blocked={[]} onToggle={onToggle} readOnly />)

    const cell = screen.getByRole("button", { name: /10\/20 .* 10:00 불가 지정/ })
    expect(cell).toBeDisabled()
    await userEvent.click(cell)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("격자가 없으면 안내문을 그린다", () => {
    render(<UnavailableSlotGrid grid={null} blocked={["2026-10-20T10:00"]} onToggle={() => {}} />)
    expect(screen.getByText(/슬롯 격자를 만들 수 없습니다/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
