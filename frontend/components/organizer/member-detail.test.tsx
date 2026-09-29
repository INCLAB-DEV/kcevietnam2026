// OP-003 기업 상세의 "미팅 일정" — 배정 그리드와 같은 [+] 노출 규칙을 쓰는지(QA A/B6).
//
// 여기도 같은 사고가 있었다: 그 칸의 미팅을 배열에서 **먼저 찾은 한 건**으로 판단해, 취소·거절
// 이력이 남은 칸이 "채워진 칸"으로 보이고 [빈 슬롯 +]이 사라졌다. 이제 배정 그리드와 같은 유틸
// (slotMeetingsFor + occupyingSlotMeeting)을 써서 이력은 보여주되 칸은 잡지 않는다.

import { describe, expect, it, vi, afterEach } from "vitest"
import { render, screen, within, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { MemberDetail } from "./member-detail"
import type { AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import type { AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import type { Organization } from "@/lib/types"

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
  vi.fn(async (_meetings: AssignmentMeeting[]) => ({ success: true, error: undefined as string | undefined }))
)
const refreshAssignmentViews = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
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
