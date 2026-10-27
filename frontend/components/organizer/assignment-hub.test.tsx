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
import type { AssignmentActionResult, SaturationRunResult } from "@/lib/organizer/assignment-actions"
import type { AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import type { Organization } from "@/lib/types"
import { toast } from "sonner"

const refresh = vi.hoisted(() => vi.fn())
// 세션 만료 리다이렉트 검증(2026-09-30)용 — router.push를 검사하려면 mock 안에서 고정된 스파이가
// 필요하다(예전엔 매 호출 `push: vi.fn()`이라 참조를 못 잡았다).
const push = vi.hoisted(() => vi.fn())
// 인자 타입을 남겨둬야 mock.calls[0][0]으로 저장 payload를 검사할 수 있다. 반환 타입은 실제 계약
// (AssignmentActionResult — message·busyRoles·savedCount 포함)으로 넓혀 둔다.
const postAssignments = vi.hoisted(() =>
  vi.fn(
    async (meetings: AssignmentMeeting[]): Promise<AssignmentActionResult> => ({
      success: meetings.length > 0,
      error: undefined,
    })
  )
)
const refreshAssignmentViews = vi.hoisted(() => vi.fn(async () => {}))
// 전체 일괄배정 실행 결과를 테스트마다 정할 수 있게 고정 스파이로 둔다(결과 0건 안내 회귀 가드).
const postSaturationRun = vi.hoisted(() =>
  vi.fn(async (): Promise<SaturationRunResult> => ({ success: false, error: "not_mocked" }))
)

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }))
vi.mock("@/lib/organizer/assignment-refresh", () => ({ refreshAssignmentViews }))
vi.mock("@/lib/organizer/assignment-actions", () => ({
  postAssignments,
  postSaturationRun,
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
    push.mockClear()
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
    push.mockClear()
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

    // 09:30 블록이 10:00까지 먹으므로 남는 빈 칸은 09:00 하나뿐. "확정"은 서버 2xx 뒤에야 보인다.
    const block = (await screen.findByTitle("바이어1 · 확정")).closest("td")
    expect(addButtons()).toHaveLength(1)
    expect(block).toHaveAttribute("colspan", "2")
  })
})

describe("AssignmentHub — 저장 후 화면 동기화(QA B4)", () => {
  beforeEach(() => {
    refresh.mockClear()
    push.mockClear()
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
    postAssignments.mockResolvedValueOnce({ success: false, error: undefined })
    const user = userEvent.setup()
    renderHub()
    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(refresh).not.toHaveBeenCalled()
    expect(refreshAssignmentViews).not.toHaveBeenCalled()
    await waitFor(() => expect(addButtons()).toHaveLength(3)) // 롤백되어 빈 칸 수 그대로
  })

  // 세션 만료 표면화(2026-09-30) — upstream 401을 write 라우트가 session_expired로 통일해 내려주면
  // 일반 "저장에 실패했어요" 대신 재로그인 안내로 가야 한다. 낙관적 반영은 그대로 롤백(유령 배정 방지).
  it("세션이 만료되면 일반 토스트 대신 재로그인 안내를 띄우고 /login으로 보낸다", async () => {
    postAssignments.mockResolvedValueOnce({ success: false, error: "session_expired" })
    const user = userEvent.setup()
    renderHub()
    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"))
    expect(refresh).not.toHaveBeenCalled()
    expect(refreshAssignmentViews).not.toHaveBeenCalled()
    await waitFor(() => expect(addButtons()).toHaveLength(3)) // 롤백되어 빈 칸 수 그대로
    expect(toast.error).toHaveBeenCalledWith("세션이 만료됐어요", {
      description: "다시 로그인해 주세요.",
    })
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

// ── 2026-10-01 고객 신고 "[배정 저장에 실패했어요]" — 화면 쪽 회귀 가드 ─────────────────────────────
// ① 성공 토스트가 서버 응답 **전에** 먼저 떴다(실패해도 "배정"이 먼저 보였다).
// ② 실패 문구가 원인과 무관하게 "네트워크 확인 후 다시 시도해 주세요"였다(실제 원인은 장소 충돌).
// ③ 저장(201까지 5~6초) 중 칸이 잠기지 않았다 — 먼저 끝난 저장의 router.refresh가 낙관적 목록을
//    서버 목록으로 통째로 교체하면, 아직 저장 중인 칸이 빈 칸 [+]로 되살아나 중복 배정을 부를 수 있었다.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function clearToasts() {
  vi.mocked(toast).mockClear()
  vi.mocked(toast.error).mockClear()
}

const successToastTitles = () => vi.mocked(toast).mock.calls.map((c) => String(c[0]))
const errorToastTexts = () =>
  vi.mocked(toast.error).mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1] ?? {})}`)

describe("AssignmentHub — 강제 배정 저장 중 잠금·성공 토스트는 2xx 뒤(2026-10-01)", () => {
  beforeEach(() => {
    refresh.mockClear()
    push.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    clearToasts()
  })

  it("서버 응답 전엔 성공 토스트 없이 '저장 중'으로 칸을 잠그고, 2xx 뒤에야 확정 + 성공 토스트", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    renderHub()

    await user.click(addButtons()[0]) // 09:00 빈 칸
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0]) // 바이어1

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    // 아직 서버가 확정하지 않았다 — 성공 문구 없음, "확정" 아님.
    expect(successToastTitles()).toEqual([])
    const savingChip = screen.getByTitle("바이어1 · 저장 중")
    expect(screen.queryByTitle("바이어1 · 확정")).toBeNull()
    // 그 칸은 잠긴다: 칩은 눌리지 않고(상세·취소 불가), 같은 칸의 [+]도 없다.
    const savingButton = savingChip.closest("button")!
    expect(savingButton).toBeDisabled()
    expect(within(savingChip.closest("td")!).queryByLabelText("빈 슬롯 — 상대 배정")).toBeNull()
    expect(addButtons()).toHaveLength(2)
    // 저장 중인 기업(참가사1)의 ⚡ 보충도 저장이 끝날 때까지 잠긴다.
    expect(screen.getByLabelText("참가사1 단일 일괄배정")).toBeDisabled()

    pending.resolve({ success: true })

    expect(await screen.findByTitle("바이어1 · 확정")).toBeInTheDocument()
    expect(successToastTitles()).toEqual(["참가사1 ↔ 바이어1 배정"])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText("참가사1 단일 일괄배정")).not.toBeDisabled()
  })

  it("실패하면 칸이 되돌아가고, 원인별 문구를 띄운다 — 네트워크 탓을 하지 않는다(VENUE_TAKEN)", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "VENUE_TAKEN",
      message: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
    })
    const user = userEvent.setup()
    renderHub()

    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(addButtons()).toHaveLength(3)) // 롤백 — 빈 칸 수 그대로
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull()
    expect(toast.error).toHaveBeenCalledWith("미팅 장소가 이미 사용 중이에요", {
      description: "해당 시간에 참가사 부스(7홀 A-12)가 이미 사용 중입니다.",
    })
    expect(errorToastTexts().join("\n")).not.toContain("네트워크")
    expect(successToastTitles()).toEqual([])
    // 경합 거절은 서버 상태가 화면과 달라졌다는 뜻 — 서버 진실로 다시 그린다.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("SLOT_TAKEN은 바쁜 쪽(바이어)을 이름으로 말한다", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "SLOT_TAKEN",
      busyRoles: ["buyer"],
    })
    const user = userEvent.setup()
    renderHub()

    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("같은 시각에 이미 미팅이 있어요", {
        description:
          "바이어 바이어1에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.",
      })
    )
  })

  it("저장 중에 서버 목록이 새로 내려와도(다른 저장의 refresh) 저장 중인 칸은 잠긴 채 남는다 — [+]로 되살아나지 않는다", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    const { rerender } = renderHub()

    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])
    expect(screen.getByTitle("바이어1 · 저장 중")).toBeInTheDocument()

    // 먼저 끝난 다른 저장의 router.refresh — 서버 목록엔 아직 이 건이 없다(새 배열 참조 = 서버 진실 채택).
    rerender(<AssignmentHub data={{ ...data, meetings: [...meetings] }} now={now} />)

    expect(screen.getByTitle("바이어1 · 저장 중")).toBeInTheDocument()
    expect(addButtons()).toHaveLength(2)

    pending.resolve({ success: true })
    expect(await screen.findByTitle("바이어1 · 확정")).toBeInTheDocument()
  })

  it("서버 목록에 이미 이 건이 들어와 있으면(커밋됐고 응답만 오는 중) 한 칸에 두 번 그리지 않는다", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    const { rerender } = renderHub()

    await user.click(addButtons()[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    rerender(
      <AssignmentHub
        data={{
          ...data,
          meetings: [
            ...meetings,
            {
              id: "srv-1",
              exhibitorId: "e1",
              buyerId: "b1",
              slotId: `${DATE}T09:00`,
              status: "accepted",
              matchingType: "forced",
            },
          ],
        }}
        now={now}
      />
    )
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull()
    expect(screen.getAllByTitle("바이어1 · 확정")).toHaveLength(1)

    pending.resolve({ success: true })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getAllByTitle("바이어1 · 확정")).toHaveLength(1)
  })
})

describe("AssignmentHub — ⚡ 단일 일괄배정 확정도 같은 규칙(2026-10-01)", () => {
  // 참가사1이 아직 아무 미팅도 없는 상태 — ⚡ 제안이 바이어1(09:00)·바이어2(09:30)로 나온다.
  const freshData: AssignmentScheduleData = { ...data, meetings: [] }
  const renderFresh = () => render(<AssignmentHub data={freshData} now={now} />)

  beforeEach(() => {
    refresh.mockClear()
    push.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    clearToasts()
  })

  async function confirmFill(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText("참가사1 단일 일괄배정"))
    await user.click(await screen.findByRole("button", { name: "확정" }))
  }

  it("2xx 전엔 성공 토스트 없이 '저장 중' + 그 기업 ⚡ 잠금, 2xx 뒤에 '빈 슬롯 N건 배정'", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    renderFresh()

    await confirmFill(user)

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(postAssignments.mock.calls[0][0]).toHaveLength(2)
    expect(successToastTitles()).toEqual([])
    expect(screen.getByTitle("바이어1 · 저장 중")).toBeInTheDocument()
    expect(screen.getByTitle("바이어2 · 저장 중")).toBeInTheDocument()
    expect(screen.getByLabelText("참가사1 단일 일괄배정")).toBeDisabled()

    pending.resolve({ success: true })

    await waitFor(() => expect(successToastTitles()).toEqual(["참가사1 빈 슬롯 2건 배정"]))
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull()
    expect(screen.getByTitle("바이어1 · 수락대기")).toBeInTheDocument() // 일반 바이어 — ⚡는 수락대기
    expect(screen.getByTitle("바이어2 · 확정")).toBeInTheDocument() // 초청 바이어 — 즉시 확정
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("중간에 실패하면(앞 1건은 저장됨) 'N건 중 M건만'을 알리고 서버 진실로 다시 그린다", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "SLOT_TAKEN",
      busyRoles: ["buyer"],
      savedCount: 1,
    })
    const user = userEvent.setup()
    renderFresh()

    await confirmFill(user)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("참가사1 빈 슬롯 2건 중 1건만 배정됐어요", {
        description:
          "바이어 바이어2에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.",
      })
    )
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull() // 낙관적 반영은 걷어내고
    expect(refresh).toHaveBeenCalledTimes(1) // 저장된 1건은 서버 목록으로 다시 받는다
    expect(successToastTitles()).toEqual([])
  })

  it("진짜 네트워크 실패일 때만 네트워크 문구", async () => {
    postAssignments.mockResolvedValueOnce({ success: false, error: "network" })
    const user = userEvent.setup()
    renderFresh()

    await confirmFill(user)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("배정 저장에 실패했어요", {
        description: "네트워크 확인 후 다시 시도해 주세요.",
      })
    )
    expect(refresh).not.toHaveBeenCalled()
  })
})

// ── 2026-10-01 로컬 E2E — 전체 일괄배정 결과가 0건이면 화면에 아무 변화가 없었다 ─────────────────────────
// POST /api/organizer/saturation이 200 count:0이면(모든 참가사·바이어가 이미 미팅이 있다 — 백엔드는 미팅
// 0건인 기업끼리만 짝짓는다) 설정 창은 닫히고 토스트는 몇 초 뒤 사라져 "실행이 됐는지"조차 알 수 없었다.
describe("AssignmentHub — 전체 일괄배정 결과 0건 안내(2026-10-01 E2E)", () => {
  beforeEach(() => {
    refresh.mockClear()
    postSaturationRun.mockClear()
    clearToasts()
  })

  it("실행 중엔 우상단 버튼이 잠기고, 0건이면 '추가로 배정할 빈 쌍이 없습니다'를 다음 실행 전까지 남긴다", async () => {
    const pending = deferred<SaturationRunResult>()
    postSaturationRun.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    renderHub()

    await user.click(screen.getByRole("button", { name: "전체 일괄배정" }))
    await user.click(await screen.findByRole("button", { name: "실행 (run #1)" }))

    // 설정 창은 닫혔다 — 진행은 우상단 버튼이 보여준다.
    const running = await screen.findByRole("button", { name: "일괄배정 실행 중…" })
    expect(running).toBeDisabled()

    // 서버가 새 쌍 0건을 돌려준다(run 번호는 서버 값이 권위).
    pending.resolve({ success: true, draft: { runNumber: 7, settings: data.settings, meetings: [] } })

    const notice = (await screen.findByText("추가로 배정할 빈 쌍이 없습니다")).closest('[role="status"]')
    expect(notice).not.toBeNull()
    expect(notice).toHaveTextContent("전체 포화배정 run #7")
    expect(notice).toHaveTextContent("아직 미팅이 없는 참가사·바이어끼리")
    expect(toast).toHaveBeenCalledWith(
      "추가로 배정할 빈 쌍이 없습니다",
      expect.objectContaining({ description: expect.stringContaining("run #7") })
    )
    expect(screen.getByRole("button", { name: "전체 일괄배정" })).not.toBeDisabled()

    // 운영자가 닫을 수 있다.
    await user.click(within(notice as HTMLElement).getByRole("button", { name: "닫기" }))
    expect(screen.queryByText("추가로 배정할 빈 쌍이 없습니다")).toBeNull()
  })

  it("결과가 있으면 0건 안내 대신 Draft 검토 배너가 뜬다", async () => {
    postSaturationRun.mockResolvedValueOnce({
      success: true,
      draft: {
        runNumber: 3,
        settings: data.settings,
        meetings: [
          {
            id: "draft-3-0",
            exhibitorId: "e1",
            buyerId: "b1",
            slotId: `${DATE}T09:00`,
            status: "accepted",
            matchingType: "ai",
          },
        ],
      },
    })
    const user = userEvent.setup()
    renderHub()

    await user.click(screen.getByRole("button", { name: "전체 일괄배정" }))
    await user.click(await screen.findByRole("button", { name: "실행 (run #1)" }))

    expect(await screen.findByText("Draft 1건")).toBeInTheDocument()
    expect(screen.queryByText("추가로 배정할 빈 쌍이 없습니다")).toBeNull()
  })
})

// ── 리뷰 L6(2026-10-01) — 장소 라벨이 없는 미팅을 "비즈매칭존 테이블"이라고 지어냈다 ────────────────────
// 장소는 서버가 정책대로 정한다(기본: 참가사 부스). 화면에 라벨이 아직 없으면 특정 유형을 지어내지 않는다.
describe("AssignmentHub — 장소 라벨이 없는 미팅의 상세(리뷰 L6)", () => {
  it("상세 슬라이드가 '비즈매칭존 테이블'을 지어내지 않고 '장소 확인 중'으로 보여준다", async () => {
    const user = userEvent.setup()
    renderHub() // live-1(바이어2 10:30)은 venue 라벨이 없다

    await user.click(screen.getByTitle("바이어2 · 확정"))

    expect(await screen.findByText("장소 확인 중")).toBeInTheDocument()
    expect(screen.queryByText("비즈매칭존 테이블")).toBeNull()
  })
})

// ── 리뷰 M2(2026-10-01) — ⚡ 확인창도 기업 상세와 같은 사실 문구 ───────────────────────────────────────
describe("AssignmentHub — ⚡ 확인창 문구(리뷰 M2)", () => {
  it("확정하면 실제로 배정·알림 발송된다고 말하고, 점수가 없으면 '신청 순'이라고 한다", async () => {
    const user = userEvent.setup()
    render(<AssignmentHub data={{ ...data, meetings: [] }} now={now} />)

    await user.click(screen.getByLabelText("참가사1 단일 일괄배정"))
    const dialog = await screen.findByRole("dialog")

    expect(
      within(dialog).getByText(
        "비즈매칭 신청 순으로 고른 상대예요. 확정하면 아래 2건이 실제로 배정되고 상대 기업에 알림이 발송됩니다(받는 쪽 유형에 따라 즉시 확정 또는 수락대기). 빼고 싶은 건 ✕로 제외하세요."
      )
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/AI가 적합도 순/)).toBeNull()
  })
})
