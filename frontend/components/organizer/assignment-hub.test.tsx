// OP-005 발주자 QA 회귀 가드 — 배정 그리드의 [+] 노출·미팅 시간 범위·저장 후 동기화.
//
// 지적 A/B6: 취소·거절된 이력이 칸을 막아 [+]가 사라져 다시 배정할 수 없었다. 이력은 지우지 않고
//            그 **아래**에 [+]를 둔다(살아있는 미팅이 있는 칸은 그대로 잠근다 — 백엔드가 같은
//            시각 중복 확정을 막으므로 눌러봐야 409다).
// 지적 B5:   같은 상대를 연달아 잡으면 시간이 합쳐져야 한다 → 시트에서 시간 범위를 늘려 미팅
//            1건(60분)으로 배정한다.
// 지적 B4:   저장 후 그리드·참가기업 관리 등 다른 화면이 서버 진실로 갱신돼야 한다.

import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { AssignmentHub } from "./assignment-hub"
import type { AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import type { Organization } from "@/lib/types"

const refresh = vi.hoisted(() => vi.fn())
// 인자 타입을 남겨둬야 mock.calls[0][0]으로 저장 payload를 검사할 수 있다.
const postAssignments = vi.hoisted(() =>
  vi.fn(async (meetings: AssignmentMeeting[]) => ({ success: meetings.length > 0 }))
)
const refreshAssignmentViews = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock("@/lib/organizer/assignment-refresh", () => ({ refreshAssignmentViews }))
vi.mock("@/lib/organizer/assignment-actions", () => ({
  postAssignments,
  postSaturationRun: vi.fn(),
  postSaturationConfirm: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

const DATE = "2026-10-20"
const exhibitor: Organization = { id: "e1", name: "참가사1", role: "exhibitor", keywords: [] }
const buyer1: Organization = { id: "b1", name: "바이어1", role: "buyer", keywords: [], buyerType: "pre_registered" }
const buyer2: Organization = { id: "b2", name: "바이어2", role: "buyer", keywords: [], buyerType: "hosted" }

// 09:30 = 취소 이력만 남은 칸(= 발주자 스크린샷의 상황), 10:30 = 살아있는 확정.
const meetings: AssignmentMeeting[] = [
  {
    id: "dead-1",
    exhibitorId: "e1",
    buyerId: "b1",
    slotId: `${DATE}T09:30`,
    status: "cancelled",
    matchingType: "forced",
  },
  {
    id: "live-1",
    exhibitorId: "e1",
    buyerId: "b2",
    slotId: `${DATE}T10:30`,
    status: "accepted",
    matchingType: "forced",
  },
]

const data: AssignmentScheduleData = {
  timezone: "Asia/Ho_Chi_Minh",
  exhibitors: [exhibitor],
  buyers: [buyer1, buyer2],
  dates: [{ id: DATE, label: "10/20", weekday: "화" }],
  settings: {
    startTime: "09:00",
    endTime: "11:00",
    slotMinutes: 30,
    slotGapMinutes: 0,
    lunchStart: "00:00",
    lunchEnd: "00:00",
    minSlots: 10,
    maxMeetingMinutes: 90,
  },
  slotTimes: ["09:00", "09:30", "10:00", "10:30"],
  meetings,
  recsByOrgId: {},
  applicationOrder: { e1: 1, b1: 1, b2: 2 },
  unavailableByOrgId: {},
  contactsByOrgId: {},
}

const now = { date: DATE, time: "08:00" } // 이 날 모든 칸이 미래

function renderHub() {
  return render(<AssignmentHub data={data} now={now} />)
}

const addButtons = () => screen.getAllByLabelText("빈 슬롯 — 상대 배정")

describe("AssignmentHub — 배정 [+] 노출 규칙(QA A/B6)", () => {
  beforeEach(() => {
    refresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
  })

  it("취소 이력만 남은 칸은 이력을 유지한 채 [+]를 함께 보여준다", () => {
    renderHub()
    const deadChip = screen.getByTitle("바이어1 · 취소")
    const cell = deadChip.closest("td")
    expect(cell).not.toBeNull()
    // 이력은 지워지지 않았고(취소 칩 그대로), 그 칸에서 다시 배정할 수 있다.
    expect(within(cell!).getByLabelText("빈 슬롯 — 상대 배정")).toBeInTheDocument()
  })

  it("살아있는 확정이 있는 칸엔 [+]가 없다 — 같은 시각 중복 확정은 백엔드가 막는다", () => {
    renderHub()
    const liveCell = screen.getByTitle("바이어2 · 확정").closest("td")
    expect(within(liveCell!).queryByLabelText("빈 슬롯 — 상대 배정")).toBeNull()
  })

  it("[+]는 빈 칸 2개 + 죽은 이력만 있는 칸 1개 = 3개", () => {
    renderHub()
    expect(addButtons()).toHaveLength(3)
  })
})

describe("AssignmentHub — 미팅 시간 범위 선택(QA B5)", () => {
  beforeEach(() => {
    refresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
  })

  it("시트는 한 칸(30분)에서 시작하고, 다음 칸이 비면 60분까지 늘릴 수 있다", async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(within(screen.getByTitle("바이어1 · 취소").closest("td")!).getByLabelText("빈 슬롯 — 상대 배정"))
    expect(await screen.findByText(/09:30 ~ 10:00/)).toBeInTheDocument()

    const grow = screen.getByLabelText("미팅 시간 늘리기")
    await user.click(grow)
    expect(await screen.findByText(/09:30 ~ 10:30/)).toBeInTheDocument()
    // 10:30은 이미 확정이 잡혀 있어 90분(3칸)으로는 못 늘린다.
    expect(grow).toBeDisabled()
  })

  it("죽은 이력이 있는 칸에서도 상대 후보가 그대로 남는다(취소는 칸을 잡지 않는다)", async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(within(screen.getByTitle("바이어1 · 취소").closest("td")!).getByLabelText("빈 슬롯 — 상대 배정"))
    expect(await screen.findAllByRole("button", { name: "배정" })).toHaveLength(2)
  })

  it("60분으로 배정하면 미팅 1건에 durationMinutes=60이 실려 저장된다", async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(within(screen.getByTitle("바이어1 · 취소").closest("td")!).getByLabelText("빈 슬롯 — 상대 배정"))
    await user.click(await screen.findByLabelText("미팅 시간 늘리기"))
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(postAssignments.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        exhibitorId: "e1",
        buyerId: "b1",
        slotId: `${DATE}T09:30`,
        status: "accepted", // 운영자 배정은 즉시 확정(QA B3)
        matchingType: "forced",
        durationMinutes: 60,
      }),
    ])
  })

  it("60분 미팅은 그리드에서 두 칸을 차지한다 — 뒤 칸이 빈 칸으로 다시 나오지 않는다", async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(within(screen.getByTitle("바이어1 · 취소").closest("td")!).getByLabelText("빈 슬롯 — 상대 배정"))
    await user.click(await screen.findByLabelText("미팅 시간 늘리기"))
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    // 09:30 블록이 10:00까지 먹으므로 남는 빈 칸은 09:00 하나뿐.
    await waitFor(() => expect(addButtons()).toHaveLength(1))
    const block = screen.getByTitle("바이어1 · 확정").closest("td")
    expect(block).toHaveAttribute("colspan", "2")
  })
})

describe("AssignmentHub — 저장 후 화면 동기화(QA B4)", () => {
  beforeEach(() => {
    refresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
  })

  it("저장에 성공하면 이 화면을 새로 그리고 다른 화면 캐시도 무효화한다", async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(refreshAssignmentViews).toHaveBeenCalledTimes(1)
  })

  it("서버가 새 목록을 내려주면(refresh 후 재렌더) 낙관적 목록을 서버 진실로 교체한다", async () => {
    const { rerender } = renderHub()
    expect(addButtons()).toHaveLength(3)
    // 갱신 결과: 09:00에 다른 운영자의 배정이 들어왔고, 09:30 취소 이력은 그대로.
    const fromServer: AssignmentMeeting[] = [
      ...meetings,
      {
        id: "srv-1",
        exhibitorId: "e1",
        buyerId: "b1",
        slotId: `${DATE}T09:00`,
        status: "accepted",
        matchingType: "forced",
      },
    ]
    rerender(<AssignmentHub data={{ ...data, meetings: fromServer }} now={now} />)
    await waitFor(() => expect(addButtons()).toHaveLength(2))
    expect(screen.getByTitle("바이어1 · 확정")).toBeInTheDocument()
  })

  it("저장에 실패하면 갱신하지 않고 낙관적 배정을 되돌린다", async () => {
    postAssignments.mockResolvedValueOnce({ success: false })
    const user = userEvent.setup()
    renderHub()
    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(refresh).not.toHaveBeenCalled()
    expect(refreshAssignmentViews).not.toHaveBeenCalled()
    await waitFor(() => expect(addButtons()).toHaveLength(3)) // 롤백되어 빈 칸 수 그대로
  })
})

// ── 발주사 운영표 격자(40분 상담 + 5분 텀) — 미팅 시간 스테퍼가 **스팬**으로 움직이는가 ──────
// 회귀 배경(mt003gap0001): 스테퍼가 `v ± slotMinutes` 로 걸으면 40 → 80 → 120 이 되는데, 실제
// 2칸 스팬은 85분이다(중간 텀 5분 포함). 그러면 화면은 "10:00 ~ 11:20" 을 보여주는데 백엔드에는
// 2칸(10:00~11:25)이 저장되는 **표시·저장 불일치**가 생긴다. 게다가 상한을 90분 리터럴로 두면
// 3칸(스팬 130분)까지 허용되어 백엔드 validate_slot_run 에 422 로 튕긴다.
const CLIENT_GRID_TIMES = [
  "10:00", "10:45", "11:30", "13:00", "13:45", "14:30", "15:15", "16:00", "16:45", "17:30",
]

const clientGridData: AssignmentScheduleData = {
  ...data,
  meetings: [], // 전부 빈 칸 — 스테퍼만 본다
  settings: {
    ...data.settings,
    startTime: "10:00",
    endTime: "18:10",
    slotMinutes: 40,
    slotGapMinutes: 5,
    lunchStart: "12:10",
    lunchEnd: "13:00",
    maxMeetingMinutes: 90,
  },
  slotTimes: CLIENT_GRID_TIMES,
}

function renderClientGrid() {
  return render(<AssignmentHub data={clientGridData} now={{ date: DATE, time: "08:00" }} />)
}

describe("AssignmentHub — 40분/텀5분 격자 미팅 시간 스테퍼(mt003gap0001)", () => {
  it("발주사 격자 10칸을 그대로 그린다(점심 12:10~13:00 에 걸치는 12:15 칸은 없다)", () => {
    renderClientGrid()
    expect(addButtons()).toHaveLength(CLIENT_GRID_TIMES.length)
  })

  it("한 칸은 40분이고, 늘리면 80분이 아니라 **85분 · 2칸**이 된다", async () => {
    const user = userEvent.setup()
    renderClientGrid()
    await user.click(addButtons()[0])
    expect(screen.getByText(/40분 · 1칸/)).toBeInTheDocument()

    await user.click(screen.getByLabelText("미팅 시간 늘리기"))
    expect(screen.getByText(/85분 · 2칸/)).toBeInTheDocument()
    // 표시되는 끝 시각도 스팬과 일치해야 한다(10:00 + 85분 = 11:25). 80분이면 11:20 이 찍힌다.
    expect(screen.getByText(/10:00 ~ 11:25/)).toBeInTheDocument()
  })

  it("max_meeting_minutes=90 이 3칸(스팬 130분)을 막는다 — 2칸에서 [+] 가 비활성", async () => {
    const user = userEvent.setup()
    renderClientGrid()
    await user.click(addButtons()[0])

    await user.click(screen.getByLabelText("미팅 시간 늘리기"))
    expect(screen.getByLabelText("미팅 시간 늘리기")).toBeDisabled()
    expect(screen.getByText(/85분 · 2칸/)).toBeInTheDocument()

    // 줄이면 다시 한 칸(스팬 40분)으로 돌아온다.
    await user.click(screen.getByLabelText("미팅 시간 줄이기"))
    expect(screen.getByText(/40분 · 1칸/)).toBeInTheDocument()
  })
})
