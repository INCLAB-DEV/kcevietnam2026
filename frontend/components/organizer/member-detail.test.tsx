// OP-003 기업 상세의 "미팅 일정" — 배정 그리드와 같은 [+] 노출 규칙을 쓰는지(QA A/B6).
//
// 여기도 같은 사고가 있었다: 그 칸의 미팅을 배열에서 **먼저 찾은 한 건**으로 판단해, 취소·거절
// 이력이 남은 칸이 "채워진 칸"으로 보이고 [빈 슬롯 +]이 사라졌다. 이제 배정 그리드와 같은 유틸
// (slotMeetingsFor + occupyingSlotMeeting)을 써서 이력은 보여주되 칸은 잡지 않는다.

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { MemberDetail } from "./member-detail"
import type { AssignmentActionResult } from "@/lib/organizer/assignment-actions"
import type { AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import type { Organization } from "@/lib/types"
import { toast } from "sonner"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

// assignForced가 저장 성공 후 router.refresh()로 동기화한다(assignment-hub와 동일, QA 3차 #2) —
// 앱 라우터 컨텍스트 없이 단위 렌더링만 하므로 목업으로 대체(meeting-timeline.test.tsx와 동일 패턴).
// postAssignments/refreshAssignmentViews는 assignment-hub.test.tsx와 같은 방식으로 모듈 경계에서
// 직접 스파이한다(fetch 스텁보다 배정 그리드 테스트와 계약이 정확히 같아진다).
const routerRefresh = vi.hoisted(() => vi.fn())
// 인자 타입을 남겨둬야 mock.calls[0][0]으로 저장 payload를 검사할 수 있다(assignment-hub.test.tsx와 동일).
const postAssignments = vi.hoisted(() =>
  vi.fn(
    async (_meetings: AssignmentMeeting[]): Promise<AssignmentActionResult> => ({
      success: true,
      error: undefined,
    })
  )
)
const refreshAssignmentViews = vi.hoisted(() => vi.fn(async () => {}))
// push는 세션 만료(session_expired) 시 /login으로 보내는 리다이렉트 핸들러가 쓴다
// (assignment-hub.test.tsx와 동일 계약 — mock에 push가 없으면 그 경로를 부를 때 던진다).
const routerPush = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: routerPush }),
}))
vi.mock("@/lib/organizer/assignment-refresh", () => ({ refreshAssignmentViews }))
vi.mock("@/lib/organizer/assignment-actions", () => ({ postAssignments }))

const DATE = "2026-10-20"
const exhibitor: Organization = { id: "e1", name: "참가사1", role: "exhibitor", keywords: [] }
const buyer1: Organization = { id: "b1", name: "바이어1", role: "buyer", keywords: [], buyerType: "pre_registered" }
const buyer2: Organization = { id: "b2", name: "바이어2", role: "buyer", keywords: [], buyerType: "hosted" }

const meetings: AssignmentMeeting[] = [
  { id: "dead-1", exhibitorId: "e1", buyerId: "b1", slotId: `${DATE}T09:30`, status: "rejected", matchingType: "forced" },
  { id: "live-1", exhibitorId: "e1", buyerId: "b2", slotId: `${DATE}T10:00`, status: "accepted", matchingType: "forced" },
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

function renderDetail() {
  return render(
    <MemberDetail org={exhibitor} member={null} data={data} now={{ date: DATE, time: "08:00" }} />
  )
}

describe("MemberDetail 미팅 일정 — 이력이 [빈 슬롯 +]을 가리지 않는다", () => {
  it("거절 이력만 남은 칸은 이력과 [빈 슬롯]을 함께 보여준다", () => {
    renderDetail()
    const cell = screen.getByTitle("바이어1 · 거절").closest<HTMLElement>("div.rounded-md")
    expect(cell).not.toBeNull()
    expect(within(cell!).getByText("빈 슬롯")).toBeInTheDocument()
  })

  it("확정이 있는 칸엔 [빈 슬롯]이 없다", () => {
    renderDetail()
    const cell = screen.getByTitle("바이어2 · 확정").closest<HTMLElement>("div.rounded-md")
    expect(within(cell!).queryByText("빈 슬롯")).toBeNull()
  })

  it("빈 칸 2개 + 죽은 이력만 있는 칸 1개 = [빈 슬롯] 3개", () => {
    renderDetail()
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(3)
  })
})

// 발주자 QA 3차 지적 #2 — 기업 상세에서 한 수동 매칭이 배정 탭에 반영되지 않던 사고. 원인은
// assignForced가 postAssignments를 호출하지 않는 로컬 전용 구현이었던 것 — 이제 배정 탭
// (assignment-hub)과 같은 submitForcedAssignment 공용 함수를 쓴다. 이 테스트는 그 POST와
// 저장 후 동기화(router.refresh + refreshAssignmentViews)가 실제로 일어나는지 잠근다.
describe("MemberDetail 빈 슬롯 배정(Forced) — 서버 저장·동기화(QA 3차 #2)", () => {
  afterEach(() => {
    routerRefresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
  })

  it("빈 슬롯에 후보를 배정하면 postAssignments로 저장하고, 성공하면 동기화한다(배정 탭과 같은 함수)", async () => {
    const user = userEvent.setup()
    renderDetail()
    await user.click(screen.getAllByText("빈 슬롯")[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(postAssignments.mock.calls[0][0]).toEqual([
      expect.objectContaining({ exhibitorId: "e1", matchingType: "forced", status: "accepted" }),
    ])

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1))
    expect(refreshAssignmentViews).toHaveBeenCalledTimes(1)
  })

  it("저장이 실패하면 낙관적으로 채운 칸을 롤백하고 동기화하지 않는다", async () => {
    postAssignments.mockResolvedValueOnce({ success: false, error: "network" })
    const user = userEvent.setup()
    renderDetail()
    await user.click(screen.getAllByText("빈 슬롯")[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    // 롤백되면 그 칸은 다시 [빈 슬롯]으로 돌아온다(원래 개수 3개 유지).
    await waitFor(() => expect(screen.getAllByText("빈 슬롯")).toHaveLength(3))
    expect(routerRefresh).not.toHaveBeenCalled()
    expect(refreshAssignmentViews).not.toHaveBeenCalled()
  })
})

// 2026-09-17 — sub(무역관)는 기업 디테일을 조회만 한다. 배정(자동채움·빈 슬롯 Forced)은 master 전용
// 거버넌스라 눌러도 403 — 누를 수 없는 버튼을 보여주지 않는다. 미팅 일정 표시는 그대로.
describe("MemberDetail 조회 전용(readOnly) — 배정 액션 없음", () => {
  it("자동채움·[빈 슬롯] 버튼이 없고, 미팅 일정(이력 포함)은 그대로 보인다", () => {
    render(
      <MemberDetail org={exhibitor} member={null} data={data} now={{ date: DATE, time: "08:00" }} readOnly />
    )
    expect(screen.queryByRole("button", { name: /자동채움/ })).not.toBeInTheDocument()
    expect(screen.queryByText("빈 슬롯")).not.toBeInTheDocument()
    expect(screen.getByTitle("바이어2 · 확정")).toBeInTheDocument()
    expect(screen.getByTitle("바이어1 · 거절")).toBeInTheDocument()
    expect(screen.getByText(/조회 전용/)).toBeInTheDocument()
  })

  it("기본(master)은 기존처럼 자동채움 버튼이 있다", () => {
    renderDetail()
    expect(screen.getByRole("button", { name: /자동채움/ })).toBeInTheDocument()
  })
})

// ── 2026-10-01 고객 신고 "[배정 저장에 실패했어요]" — 기업 상세 쪽 회귀 가드 ───────────────────────
// 배정 그리드와 같은 규칙: 성공 토스트는 서버 2xx 뒤에만, 저장 중엔 그 칸을 "저장 중"으로 잠그고,
// 실패 문구는 원인별(네트워크 문구는 진짜 네트워크 실패일 때만).
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const successToastTitles = () => vi.mocked(toast).mock.calls.map((c) => String(c[0]))

describe("MemberDetail 빈 슬롯 배정 — 저장 중 잠금·성공 토스트는 2xx 뒤(2026-10-01)", () => {
  beforeEach(() => {
    routerRefresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    vi.mocked(toast).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it("응답 전엔 성공 토스트 없이 '저장 중'으로 칸을 잠그고, 2xx 뒤에 확정 + 성공 토스트", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    renderDetail()

    await user.click(screen.getAllByText("빈 슬롯")[0]) // 09:00
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0]) // 바이어1

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(successToastTitles()).toEqual([])
    expect(screen.getByTitle("바이어1 · 저장 중")).toBeInTheDocument()
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(2) // 그 칸은 잠겼다
    expect(screen.getByRole("button", { name: /자동채움/ })).toBeDisabled()

    pending.resolve({ success: true })

    await waitFor(() => expect(successToastTitles()).toEqual(["바이어1 배정"]))
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull()
    expect(routerRefresh).toHaveBeenCalledTimes(1)
  })

  it("실패하면 칸이 되돌아가고 원인별 문구 — 네트워크 탓을 하지 않는다", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "SLOT_TAKEN",
      busyRoles: ["exhibitor"],
    })
    const user = userEvent.setup()
    renderDetail()

    await user.click(screen.getAllByText("빈 슬롯")[0])
    await user.click((await screen.findAllByRole("button", { name: "배정" }))[0])

    await waitFor(() => expect(screen.getAllByText("빈 슬롯")).toHaveLength(3))
    expect(toast.error).toHaveBeenCalledWith("같은 시각에 이미 미팅이 있어요", {
      description:
        "참가사 참가사1에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.",
    })
    expect(successToastTitles()).toEqual([])
  })
})

// 자동채움(⚡ 재트리거)은 예전엔 화면 목록에만 넣고 "빈 슬롯 N건 보충" 성공 토스트를 띄울 뿐 서버에
// 저장하지 않았다(새로고침하면 사라짐). 이제 배정 그리드 ⚡와 같은 저장 경로(postAssignments → BFF →
// /retrigger-assignments)를 탄다.
describe("MemberDetail 자동채움 — 서버 저장 + 2xx 뒤 성공 토스트(2026-10-01)", () => {
  const freshData: AssignmentScheduleData = { ...data, meetings: [] }
  const renderFresh = () =>
    render(
      <MemberDetail org={exhibitor} member={null} data={freshData} now={{ date: DATE, time: "08:00" }} />
    )

  beforeEach(() => {
    routerRefresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    vi.mocked(toast).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it("확정하면 제안 전부를 저장하고, 2xx 뒤에만 '보충' 토스트 + 동기화", async () => {
    const pending = deferred<AssignmentActionResult>()
    postAssignments.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    renderFresh()

    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    await user.click(await screen.findByRole("button", { name: "확정" }))

    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(postAssignments.mock.calls[0][0]).toEqual([
      expect.objectContaining({ exhibitorId: "e1", buyerId: "b1", matchingType: "ai" }),
      expect.objectContaining({ exhibitorId: "e1", buyerId: "b2", matchingType: "ai" }),
    ])
    expect(successToastTitles()).toEqual([])
    expect(screen.getByTitle("바이어1 · 저장 중")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /자동채움/ })).toBeDisabled()

    pending.resolve({ success: true })

    await waitFor(() => expect(successToastTitles()).toEqual(["빈 슬롯 2건 보충"]))
    expect(routerRefresh).toHaveBeenCalledTimes(1)
    expect(refreshAssignmentViews).toHaveBeenCalledTimes(1)
  })

  it("저장이 실패하면 제안을 걷어내고 원인별 문구를 띄운다", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "VENUE_TYPE_DISABLED",
      message: "이 행사에 등록된 미팅 장소(비즈매칭존 테이블)가 없습니다(운영자 장소 등록 필요).",
    })
    const user = userEvent.setup()
    renderFresh()

    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    await user.click(await screen.findByRole("button", { name: "확정" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("배정할 미팅 장소가 없어요", {
        description: "이 행사에 등록된 미팅 장소(비즈매칭존 테이블)가 없습니다(운영자 장소 등록 필요).",
      })
    )
    expect(screen.queryByTitle("바이어1 · 저장 중")).toBeNull()
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(4) // 전부 빈 칸으로 되돌아왔다
    expect(successToastTitles()).toEqual([])
  })
})

// ── 리뷰 H1(2026-10-01) — 기업 상세가 칸 사이 텀을 무시했다 ─────────────────────────────────────────
// 운영 격자(40분 + 텀 5분: 10:00 10:45 11:30 13:00 …)에서 참가사1에 확정 85분 미팅(10:00–11:25 = 2칸)이
// 있으면, 예전엔 병합·점유 펼침이 텀 없이(stride 40) 계산돼
//   · 블록이 "10:00–12:10"(3칸)으로 그려져 실제로 빈 11:30 칸이 사라지고
//   · 점유가 존재하지 않는 10:40·11:20으로 펼쳐져 실제로 막힌 10:45가 빈 칸으로 계산됐다 —
//     [자동채움]이 참가사1 자신의 미팅 한가운데인 10:45를 서버로 보내 SLOT_TAKEN으로 배치가 멈췄다.
// 배정 그리드(assignment-hub)는 텀을 넘기고 있었고 기업 상세만 빠뜨렸다.
const PRODUCTION_TIMES = ["10:00", "10:45", "11:30", "13:00", "13:45", "14:30", "15:15", "16:00", "16:45", "17:30"]
const buyer3: Organization = { id: "b3", name: "바이어3", role: "buyer", keywords: [], buyerType: "hosted" }
const productionGridData: AssignmentScheduleData = {
  ...data,
  buyers: [buyer1, buyer2, buyer3],
  settings: {
    startTime: "10:00",
    endTime: "18:10",
    slotMinutes: 40,
    slotGapMinutes: 5,
    lunchStart: "12:10",
    lunchEnd: "13:00",
    minSlots: 10,
    maxMeetingMinutes: 90,
  },
  slotTimes: PRODUCTION_TIMES,
  meetings: [
    {
      id: "live-85",
      exhibitorId: "e1",
      buyerId: "b1",
      slotId: `${DATE}T10:00`,
      status: "accepted",
      matchingType: "forced",
      durationMinutes: 85, // 2칸 = 10:00(40분) + 텀 5분 + 10:45(40분) → 10:00–11:25
    },
  ],
  applicationOrder: { e1: 1, b1: 1, b2: 2, b3: 3 },
}

describe("MemberDetail — 운영 격자(40분+텀5분)의 85분 미팅(리뷰 H1)", () => {
  const renderProductionGrid = () =>
    render(
      <MemberDetail
        org={exhibitor}
        member={null}
        data={productionGridData}
        now={{ date: DATE, time: "08:00" }}
      />
    )

  beforeEach(() => {
    routerRefresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    vi.mocked(toast).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it("블록은 10:00–11:25로 그려지고 10:45 칸만 덮는다 — 실제로 빈 11:30 칸은 남는다", () => {
    renderProductionGrid()

    expect(screen.getByText("10:00–11:25")).toBeInTheDocument()
    expect(screen.queryByText("10:00–12:10")).toBeNull()
    expect(screen.queryByText("10:45")).toBeNull() // 10:00 블록이 덮은 칸
    const cell1130 = screen.getByText("11:30").closest<HTMLElement>("div.rounded-md")
    expect(within(cell1130!).getByText("빈 슬롯")).toBeInTheDocument()
    // 빈 칸 = 격자 10칸 − 미팅이 쓰는 2칸(10:00·10:45) = 8칸
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(8)
  })

  it("[자동채움]은 막힌 10:45를 고르지 않고 실제로 빈 11:30부터 채운다 — 서버로 10:45를 보내지 않는다", async () => {
    const user = userEvent.setup()
    renderProductionGrid()

    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    const dialog = await screen.findByRole("dialog")

    expect(within(dialog).queryByText("10/20 10:45")).toBeNull()
    expect(within(dialog).getByText("10/20 11:30")).toBeInTheDocument()
    expect(within(dialog).getByText("10/20 13:00")).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "확정" }))
    await waitFor(() => expect(postAssignments).toHaveBeenCalledTimes(1))
    expect(postAssignments.mock.calls[0][0].map((m) => [m.buyerId, m.slotId])).toEqual([
      ["b2", `${DATE}T11:30`],
      ["b3", `${DATE}T13:00`],
    ])
  })
})

// ── 리뷰 M1(2026-10-01) — 기업 상세가 refresh로 내려온 서버 목록을 채택하지 않았다 ──────────────────────
// [자동채움] 2건 중 1건만 저장되고 2번째가 SLOT_TAKEN이면 "2건 중 1건만" 안내는 떴지만, 화면은 마운트
// 때의 목록을 그대로 들고 있어 두 칸 다 빈 칸이었다. 다시 누르면 이미 저장된 첫 항목부터 또 보내져
// DUPLICATE_APPLICATION/SLOT_TAKEN이 페이지를 새로 열 때까지 반복됐다. 배정 그리드와 같은 서버 진실
// 채택 패턴을 기업 상세에도 적용했다.
describe("MemberDetail — 서버 목록 채택(리뷰 M1)", () => {
  const freshData: AssignmentScheduleData = { ...data, meetings: [] }
  const now = { date: DATE, time: "08:00" }

  beforeEach(() => {
    routerRefresh.mockClear()
    postAssignments.mockClear()
    refreshAssignmentViews.mockClear()
    vi.mocked(toast).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it("자동채움이 일부만 저장된 뒤 refresh가 새 목록을 내려주면 그 목록을 그린다 — 다시 눌러도 저장된 건을 또 보내지 않는다", async () => {
    postAssignments.mockResolvedValueOnce({
      success: false,
      error: "SLOT_TAKEN",
      busyRoles: ["buyer"],
      savedCount: 1,
    })
    const user = userEvent.setup()
    const { rerender } = render(
      <MemberDetail org={exhibitor} member={null} data={freshData} now={now} />
    )

    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    await user.click(await screen.findByRole("button", { name: "확정" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("빈 슬롯 2건 중 1건만 보충됐어요", expect.anything())
    )
    expect(routerRefresh).toHaveBeenCalledTimes(1) // 서버 진실로 다시 그려 달라고 했다

    // router.refresh() 결과 — 서버엔 첫 항목(바이어1 09:00, 일반 바이어라 수락대기)이 저장돼 있다.
    rerender(
      <MemberDetail
        org={exhibitor}
        member={null}
        data={{
          ...freshData,
          meetings: [
            {
              id: "srv-fill-1",
              exhibitorId: "e1",
              buyerId: "b1",
              slotId: `${DATE}T09:00`,
              status: "proposed",
              matchingType: "ai",
            },
          ],
        }}
        now={now}
      />
    )

    expect(await screen.findByTitle("바이어1 · 수락대기")).toBeInTheDocument()
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(3)

    // 다시 [자동채움] — 이미 저장된 쌍(바이어1)·칸(09:00)은 다시 제안하지 않는다.
    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByText("바이어1")).toBeNull()
    expect(within(dialog).queryByText("10/20 09:00")).toBeNull()
    expect(within(dialog).getByText("바이어2")).toBeInTheDocument()
  })

  it("서버가 새 목록을 내려주면(다른 화면의 배정 등) 그대로 교체한다", async () => {
    const { rerender } = render(<MemberDetail org={exhibitor} member={null} data={data} now={now} />)
    expect(screen.getAllByText("빈 슬롯")).toHaveLength(3)

    rerender(
      <MemberDetail
        org={exhibitor}
        member={null}
        data={{
          ...data,
          meetings: [
            ...meetings,
            {
              id: "srv-2",
              exhibitorId: "e1",
              buyerId: "b2",
              slotId: `${DATE}T09:00`,
              status: "accepted",
              matchingType: "forced",
            },
          ],
        }}
        now={now}
      />
    )

    await waitFor(() => expect(screen.getAllByText("빈 슬롯")).toHaveLength(2))
  })
})

// ── 리뷰 M2(2026-10-01) — [자동채움] 확인창 문구가 실제 동작과 달랐다 ──────────────────────────────────
// 예전 문구 "AI가 적합도 순으로 … 제안(비파괴)"는 저장되지 않던 시절의 것이다. 이제 확정하면 실제로 배정되고
// 알림이 나간다. 또 운영에선 추천 점수(recsByOrgId)가 비어 실제로는 신청 순으로 고른다.
describe("MemberDetail [자동채움] 확인창 문구(리뷰 M2)", () => {
  const freshData: AssignmentScheduleData = { ...data, meetings: [] }

  it("확정하면 실제로 배정·알림 발송된다고 말하고, 점수가 없으면 '신청 순'이라고 사실대로 말한다", async () => {
    const user = userEvent.setup()
    render(
      <MemberDetail org={exhibitor} member={null} data={freshData} now={{ date: DATE, time: "08:00" }} />
    )

    await user.click(screen.getByRole("button", { name: /자동채움/ }))
    const dialog = await screen.findByRole("dialog")

    expect(
      within(dialog).getByText(
        "비즈매칭 신청 순으로 고른 상대예요. 확정하면 아래 2건이 실제로 배정되고 상대 기업에 알림이 발송됩니다(받는 쪽 유형에 따라 즉시 확정 또는 수락대기). 빼고 싶은 건 ✕로 제외하세요."
      )
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/비파괴/)).toBeNull()
    expect(within(dialog).queryByText(/AI가 적합도 순/)).toBeNull()
  })
})
