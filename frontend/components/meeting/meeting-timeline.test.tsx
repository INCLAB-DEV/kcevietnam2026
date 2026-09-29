// 우측 패널(MeetingDetailPanel)이 useTranslations("meeting.toast")·useRouter를 쓰게 되면서
// (수락/거절/취소 실 연동) 렌더 헬퍼를 intl-aware 버전으로, next/navigation을 모킹해야 한다.
import { render, screen, fireEvent, waitFor, within } from "@/lib/test/render-with-intl"
import { describe, it, expect, vi } from "vitest"
import { MeetingTimeline } from "./meeting-timeline"

// nav가 모바일 오버레이로 접히는 폭(<768)을 흉내내기 위한 useIsMobile 모킹.
// jsdom 기본(matchMedia matches:false)은 항상 데스크톱이라 死구간 시나리오를 못 재현한다.
let mockIsMobile = false
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}))

// PanelActionButton(수락/거절/취소)이 useRouter().refresh()를 쓴다 — 앱 라우터 컨텍스트 없이
// 단위 렌더링만 하므로 목업으로 대체(login-flow.test.tsx와 동일 패턴).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}))

// 한 칸에 여러 건이 쌓였을 때(#10) 수락이 **그 건의** meetingId로 나가는지 보려면 mutation seam을
// 가로채야 한다 — isMeetingHttpMode()가 false면 패널이 "준비 중" 토스트로 빠져 호출 자체가 없다.
const actionMocks = vi.hoisted(() => ({
  acceptMeeting: vi.fn(async () => ({ success: true })),
}))
vi.mock("@/lib/meeting/meeting-actions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meeting/meeting-actions")>()
  return {
    ...actual,
    isMeetingHttpMode: () => true,
    acceptMeeting: actionMocks.acceptMeeting,
  }
})
import { Toaster } from "@/components/ui/sonner"
import type { DayTimeline, FilledSlot, SlotMeeting } from "@/lib/meeting/timeline"
import type { MeetingPanelView } from "@/lib/meeting/meeting-panel"

// 한 칸에 걸린 미팅 한 건(#10). meetings[] 없이 filled()를 부르면 대표 1건짜리 칸이 만들어진다.
function slotMeeting(partial: Partial<SlotMeeting> = {}): SlotMeeting {
  return {
    meetingId: "m1",
    status: "accepted",
    attended: true,
    expired: false,
    dead: false,
    tone: "green",
    label: "확정",
    shortLabel: "확정",
    direction: "sent",
    actions: ["cancel"],
    counterpartName: "한화시스템",
    venue: "비즈니스룸 1",
    span: 1,
    endTime: "10:30",
    ...partial,
  }
}

function filled(partial: Partial<FilledSlot> & { time: string }): FilledSlot {
  const { meetings, ...rest } = partial
  const slot = {
    kind: "meeting" as const,
    ...slotMeeting(),
    span: 1,
    coveredTimes: [] as string[],
    ...rest,
  }
  // meetings를 안 넘기면 단수 필드(대표 건)를 그대로 1건짜리 목록으로 복제한다 — 기존 케이스 보존.
  return { ...slot, meetings: meetings ?? [slotMeeting(slot)] }
}

function day(partial: Partial<DayTimeline> & { dateId: string }): DayTimeline {
  return {
    label: "9/16",
    weekday: "수",
    pendingCount: 0,
    slots: [],
    isToday: false,
    now: null,
    ...partial,
  }
}

function panel(partial: Partial<MeetingPanelView> & { meetingId: string }): MeetingPanelView {
  return {
    status: "accepted",
    tone: "green",
    statusLabel: "미팅 예정",
    reviewDone: false,
    direction: "sent",
    directionLabel: "내가 신청",
    time: "10:00",
    endTime: "10:30",
    venue: "비즈니스룸 1",
    actions: ["cancel"],
    counterpart: {
      id: "ex-001",
      name: "한화시스템",
      role: "exhibitor",
      typeLabel: "참가사",
      oneLiner: "국내 최고 솔루션",
    },
    org: {
      id: "ex-001",
      name: "한화시스템",
      role: "exhibitor",
      keywords: ["레이더"],
      exhibits: ["다기능레이더(AESA)"],
    },
    viewerRole: "buyer",
    match: { score: 82, reasons: ["관심 분야가 일치합니다"] },
    members: [{ side: "us", name: "김바이어", title: "구매팀장" }],
    detailHref: "/discover/ex-001",
    ...partial,
  }
}

describe("MeetingTimeline", () => {
  it("선택된 미팅의 우측 패널에 매칭 점수·기업명·액션을 보여준다", () => {
    render(
      <>
        <MeetingTimeline
          days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
          panels={{ m1: panel({ meetingId: "m1" }) }}
          initialSelectedId="m1"
          emptyState={null}
        />
        <Toaster />
      </>
    )
    expect(screen.getAllByText("한화시스템").length).toBeGreaterThan(0)
    expect(screen.getAllByText("82").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/관심 분야가 일치합니다/).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("button", { name: "취소" }).length).toBeGreaterThan(0)
  })

  it("좌측 슬롯(선택 전)에는 액션 버튼을 렌더하지 않는다", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument()
  })

  it("슬롯을 클릭하면 우측 패널이 열린다", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState="find-partner"
      />
    )
    fireEvent.click(screen.getAllByRole("button", { name: /한화시스템/ })[0])
    expect(screen.getAllByText(/관심 분야가 일치합니다/).length).toBeGreaterThan(0)
  })

  it("포커싱 안 한 상태에선 다음 예정 미팅을 패널에 기본 표시한다(행 하이라이트 없음)", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        defaultMeetingId="m1"
        emptyState="find-partner"
      />
    )
    // 빈 상태(find-partner) 대신 다음 미팅 내용이 패널에 뜬다.
    expect(screen.getAllByText(/관심 분야가 일치합니다/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/협력할 비즈니스 파트너/)).not.toBeInTheDocument()
    // 단, 비포커스이므로 해당 행은 선택(aria-current/링) 표시되지 않는다.
    const row = screen.getAllByRole("button", { name: /한화시스템/ })[0]
    expect(row).not.toHaveAttribute("aria-current")
    // 대신 어떤 미팅인지 알 수 있게 배경만 옅게 칠한다(링 없음 — 선택과 차별).
    expect(row.className).toContain("bg-accent/40")
    expect(row.className).not.toContain("ring-ring/50")
  })

  it("선택된 슬롯을 다시 누르면 선택이 해제된다(토글)", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState="find-partner"
      />
    )
    const row = screen.getAllByRole("button", { name: /한화시스템/ })[0]
    fireEvent.click(row)
    expect(row).toHaveAttribute("aria-current", "true")
    fireEvent.click(row)
    // 해제되면 패널은 빈 상태로 돌아가고 aria-current가 사라진다.
    expect(row).not.toHaveAttribute("aria-current")
    expect(screen.queryByText(/관심 분야가 일치합니다/)).not.toBeInTheDocument()
  })

  it("일별 탭: 날짜 오른쪽에 미팅 갯수 pill, 받은 응답대기는 숫자 대신 dot으로 간접 알림", () => {
    const { rerender } = render(
      <MeetingTimeline
        days={[
          day({
            dateId: "2026-09-16",
            pendingCount: 2,
            slots: [filled({ time: "11:00", status: "proposed", tone: "red", label: "응답 필요" })],
          }),
        ]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    // 미팅 갯수(1건) pill
    expect(screen.getByLabelText("미팅 1건")).toBeInTheDocument()
    // 받은 응답대기: dot(숫자 없음)
    expect(screen.getByLabelText("받은 응답대기 있음")).toBeInTheDocument()
    expect(screen.queryByText("2")).not.toBeInTheDocument() // 숫자 배지 제거됨

    // pendingCount 0이면 dot 없음
    rerender(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", pendingCount: 0, slots: [filled({ time: "11:00" })] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    expect(screen.queryByLabelText("받은 응답대기 있음")).not.toBeInTheDocument()
  })

  it("빈 상태 A(find-partner): 파트너 찾기 문구 + 기업 탐색 CTA", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [{ kind: "empty", time: "09:00", tone: "gray" }] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState="find-partner"
      />
    )
    expect(screen.getAllByText(/협력할 비즈니스 파트너/).length).toBeGreaterThan(0)
    expect(screen.getAllByText("기업 탐색").length).toBeGreaterThan(0)
  })

  it("빈 시간대를 선택하면 그 시간대 기업 탐색 안내(discover)를 패널에 띄운다", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [{ kind: "empty", time: "09:00", tone: "gray" }] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState="no-meetings" // 선택 전엔 기본 빈 상태(기업 탐색 CTA 없음)
      />
    )
    // 선택 전: 빈슬롯 안내 미노출
    expect(screen.queryByText("비어 있는 시간대예요")).not.toBeInTheDocument()
    // 09:00 빈 슬롯 행(button)을 클릭
    fireEvent.click(screen.getByRole("button", { name: /09:00/ }))
    expect(screen.getAllByText("비어 있는 시간대예요").length).toBeGreaterThan(0)
    expect(screen.getAllByText("기업 탐색").length).toBeGreaterThan(0)
  })

  it("빈 상태 B(no-meetings): 담백한 안내 + CTA 없음", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [{ kind: "empty", time: "09:00", tone: "gray" }] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState="no-meetings"
      />
    )
    expect(screen.getAllByText("예정된 미팅이 없습니다.").length).toBeGreaterThan(0)
    expect(screen.queryByText("기업 탐색")).not.toBeInTheDocument()
  })

  it("빈 시간대면 현재 슬롯(빈 칸) 행에 '지금 HH:MM'을 붙인다(슬롯 사이 분리선 아님)", () => {
    render(
      <MeetingTimeline
        days={[
          day({
            dateId: "2026-09-16",
            slots: [
              { kind: "empty", time: "10:00", tone: "gray" },
              { kind: "empty", time: "10:30", tone: "gray" },
            ],
            now: { rowTime: "10:00", time: "10:11", live: false }, // 10:00 빈 슬롯 행에 부착
          }),
        ]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    // 현재 시각 칩이 10:00 빈 슬롯 행 안에 있다(같은 li). 분리선 마커(aria-label)는 없다.
    const chip = screen.getByText("지금 10:11")
    expect(chip).toBeInTheDocument()
    expect(chip.closest("li")?.querySelector("time")?.textContent).toBe("10:00")
    expect(screen.queryByLabelText(/^현재 시각/)).not.toBeInTheDocument()
  })

  it("nav가 모바일(<768)로 접히면 콘텐츠 폭과 무관하게 인라인 2컬럼 패널을 렌더하지 않는다", () => {
    // 死구간(668~768) 회귀 가드: nav 접힘 순간 콘텐츠가 넓어져도 인라인 aside가 떴다
    // 사라지면 안 된다. isMobile=true면 compact 고정 → 인라인 패널 대신 팝업(Sheet) 경로.
    mockIsMobile = true
    try {
      render(
        <MeetingTimeline
          days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
          panels={{ m1: panel({ meetingId: "m1" }) }}
          initialSelectedId={null}
          defaultMeetingId="m1"
          emptyState={null}
        />
      )
      // 인라인 패널(<aside>)이 없어야 한다. 비포커스라 팝업도 닫혀 있어 패널 본문은 미노출.
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
      expect(screen.queryByText(/관심 분야가 일치합니다/)).not.toBeInTheDocument()
    } finally {
      mockIsMobile = false
    }
  })

  it("데스크톱(≥768)에선 인라인 2컬럼 패널(<aside>)을 렌더한다", () => {
    // 대조군: 모바일이 아니면 기존대로 인라인 패널 경로(measured null → 2컬럼 가정).
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId="m1"
        emptyState={null}
      />
    )
    expect(screen.getByRole("complementary")).toBeInTheDocument()
  })

  it("상단 액션 스트립 행을 탭하면 해당 미팅으로 점프해 패널을 연다(D17)", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00", meetingId: "m1" })] })]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState={null}
        actionStrip={{
          receivedRequests: 1,
          earliestReceivedId: "m1",
          pendingReview: 0,
          earliestReviewId: null,
        }}
      />
    )
    // 진입 시 비포커스 → 패널 비어 있음. 스트립의 "받은 미팅요청" 행을 탭하면 m1이 선택돼 패널이 열린다.
    expect(screen.queryByText(/관심 분야가 일치합니다/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("받은 미팅요청").closest("button")!)
    expect(screen.getAllByText(/관심 분야가 일치합니다/).length).toBeGreaterThan(0)
  })

  it("진행 중(now가 미팅 안)인 미팅 행은 '지금 HH:MM' 칩을 붙이고 상태 라벨은 그대로 유지한다", () => {
    render(
      <MeetingTimeline
        days={[
          day({
            dateId: "2026-09-16",
            slots: [filled({ time: "10:00", meetingId: "m1", label: "확정" })],
            now: { rowTime: "10:00", time: "10:24", live: true },
          }),
        ]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    // 진행 중이면 현재 시각 칩 + 상태 라벨이 함께(겹치지 않게) 보인다.
    expect(screen.getByText("지금 10:24")).toBeInTheDocument()
    expect(screen.getByText("확정")).toBeInTheDocument()
    // 별도 분리선 마커(aria-label)는 없다 — 행 자체로 진행 중을 표시.
    expect(screen.queryByLabelText(/^현재 시각/)).not.toBeInTheDocument()
  })

  it("현재 시각이 비확정(만료 등) 미팅 행에 걸려도 '지금 HH:MM' 시간 칩은 뜨고, 진행 중 링은 없다", () => {
    render(
      <MeetingTimeline
        days={[
          day({
            dateId: "2026-09-16",
            slots: [filled({ time: "10:00", meetingId: "m1", status: "proposed", expired: true, tone: "gray", label: "응답 시간 지남" })],
            now: { rowTime: "10:00", time: "10:24", live: false }, // 앵커만(진행 중 아님)
          }),
        ]}
        panels={{ m1: panel({ meetingId: "m1" }) }}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    // 시간 표기는 절대 사라지지 않는다 + 만료 라벨 공존.
    expect(screen.getByText("지금 10:24")).toBeInTheDocument()
    expect(screen.getByText("응답 시간 지남")).toBeInTheDocument()
    // live=false이므로 인디고 진행 중 링(ring-now)은 없다.
    const row = screen.getByText("응답 시간 지남").closest("button")!
    expect(row.className).not.toContain("ring-now")
  })

  it("빈 슬롯은 텍스트 라벨 없이 시각만 옅게 표시한다(시간축 유지)", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [{ kind: "empty", time: "09:00", tone: "gray" }] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    // 빈 슬롯도 시각은 보여 시간축이 끊기지 않는다. "비어 있음" 노이즈 텍스트는 제거됨.
    expect(screen.getByText("09:00")).toBeInTheDocument()
    expect(screen.queryByText("비어 있음")).not.toBeInTheDocument()
  })
})

// #10 — 같은 시간 칸에 여러 건이 걸리면 전부 쌓아 보여주고, 각 건이 독립적으로 동작해야 한다.
// 예전엔 슬롯당 1건만 그려 나머지는 수락도 거절도 할 수 없었다(발주자가 두 번 지적한 N:M 붕괴).
describe("MeetingTimeline — 한 칸에 여러 건(#10)", () => {
  const request = (id: string, name: string): SlotMeeting =>
    slotMeeting({
      meetingId: id,
      status: "proposed",
      tone: "red",
      label: "수락 필요",
      shortLabel: "수락",
      direction: "received",
      actions: ["accept", "reject"],
      counterpartName: name,
    })

  function stacked(meetings: SlotMeeting[]) {
    return filled({ time: "10:00", ...meetings[0], meetings })
  }

  it("같은 시각으로 들어온 신청 3건이 모두 보인다(하나로 뭉개지지 않는다)", () => {
    const meetings = [request("m1", "가 바이어"), request("m2", "나 바이어"), request("m3", "다 바이어")]
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [stacked(meetings)] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    expect(screen.getByRole("button", { name: /가 바이어/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /나 바이어/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /다 바이어/ })).toBeInTheDocument()
    // 날짜 탭 카운트도 칸 수가 아니라 건수를 센다.
    expect(screen.getByLabelText("미팅 3건")).toBeInTheDocument()
  })

  it("확정이 위·거절이 아래로 쌓이고, 거절 이력도 함께 보인다", () => {
    const meetings = [
      slotMeeting({ meetingId: "ok", counterpartName: "확정기업", label: "미팅 예정" }),
      slotMeeting({
        meetingId: "no",
        status: "rejected",
        dead: true,
        tone: "gray",
        label: "거절됨",
        shortLabel: "거절",
        actions: [],
        counterpartName: "거절기업",
      }),
    ]
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [stacked(meetings)] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    const group = screen.getByRole("group", { name: "같은 시간대 미팅 2건" })
    const names = within(group)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
    expect(names[0]).toContain("확정기업")
    expect(names[1]).toContain("거절기업")
    expect(screen.getByText("거절됨")).toBeInTheDocument()
  })

  it("한 건뿐인 칸은 그룹으로 묶지 않는다(기존 단일 행 그대로)", () => {
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [filled({ time: "10:00" })] })]}
        panels={{}}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
  })

  it("건별로 상세 패널이 펼쳐지고, 수락은 클릭한 건의 meetingId로 나간다", async () => {
    actionMocks.acceptMeeting.mockClear()
    const meetings = [request("m1", "가 바이어"), request("m2", "나 바이어")]
    render(
      <>
        <MeetingTimeline
          days={[day({ dateId: "2026-09-16", slots: [stacked(meetings)] })]}
          panels={{
            m1: panel({ meetingId: "m1", actions: ["accept", "reject"] }),
            m2: panel({
              meetingId: "m2",
              actions: ["accept", "reject"],
              counterpart: {
                id: "buyer-2",
                name: "나 바이어",
                role: "buyer",
                typeLabel: "바이어",
                oneLiner: "두 번째 신청자",
              },
            }),
          }}
          initialSelectedId={null}
          emptyState={null}
        />
        <Toaster />
      </>
    )
    // 두 번째 건(m2)을 눌러 그 건의 패널을 펼친다 — 대표 건(m1)이 아니라 클릭한 건이 열려야 한다.
    fireEvent.click(screen.getByRole("button", { name: /나 바이어/ }))
    expect(screen.getAllByText("두 번째 신청자").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "수락" }))
    await waitFor(() => expect(actionMocks.acceptMeeting).toHaveBeenCalledWith("m2"))
  })

  it("대표가 아닌 건을 선택해도 그 건만 하이라이트된다(칸 전체가 아니라)", () => {
    const meetings = [request("m1", "가 바이어"), request("m2", "나 바이어")]
    render(
      <MeetingTimeline
        days={[day({ dateId: "2026-09-16", slots: [stacked(meetings)] })]}
        panels={{ m1: panel({ meetingId: "m1" }), m2: panel({ meetingId: "m2" }) }}
        initialSelectedId={null}
        emptyState={null}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /나 바이어/ }))
    expect(screen.getByRole("button", { name: /나 바이어/ })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: /가 바이어/ })).not.toHaveAttribute("aria-current")
  })
})
