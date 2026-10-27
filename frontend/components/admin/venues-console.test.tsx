// 공용 Dialog의 닫기 라벨이 next-intl(common.close)에서 오므로 intl provider로 감싸 렌더한다.
import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { VenuesConsole } from "./venues-console"
import type { AdminVenue } from "@/lib/admin/types"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// 기본은 mock 모드(NEXT_PUBLIC_AUTH_CLIENT 미설정)라 admin-actions의 dispatch가 네트워크 없이
// 항상 성공한다 — 여기선 낙관적 갱신이 실제로 화면에 반영되는지만 검증한다(admin-actions.test.ts가
// 실연동 경로·409/422 code 분기를 이미 담당).

// 앱 루트(app/layout.tsx)와 동일하게 TooltipProvider로 감싼다 — 삭제 비활성 버튼의 tooltip이
// Radix Tooltip을 쓰므로 provider가 필요하다(components/app-sidebar.test.tsx와 같은 패턴).
function renderConsole(props: ComponentProps<typeof VenuesConsole>) {
  return render(
    <TooltipProvider>
      <VenuesConsole {...props} />
    </TooltipProvider>,
  )
}

function ven(over: Partial<AdminVenue> & Pick<AdminVenue, "id" | "venue_type" | "label">): AdminVenue {
  return { event_id: "evt-test", meeting_count: 0, ...over }
}

const venues: AdminVenue[] = [
  ven({ id: "v-1", venue_type: "zone_table", label: "T-01", meeting_count: 3 }),
  ven({ id: "v-2", venue_type: "zone_table", label: "T-02" }),
  ven({ id: "v-3", venue_type: "business_room", label: "Room A" }),
]

describe("VenuesConsole — 유형별 그룹 테이블", () => {
  it("매칭존 테이블과 비즈니스 룸을 나눠 보여준다", () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    expect(screen.getByRole("heading", { name: /매칭존 테이블/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /비즈니스 룸/ })).toBeInTheDocument()
    expect(screen.getByText("T-01")).toBeInTheDocument()
    expect(screen.getByText("T-02")).toBeInTheDocument()
    expect(screen.getByText("Room A")).toBeInTheDocument()
  })

  it("장소가 없는 유형은 빈 상태 문구를 보여준다", () => {
    renderConsole({
      venues: [ven({ id: "v-1", venue_type: "zone_table", label: "T-01" })],
      eventId: "evt-1",
      readOnly: false,
    })
    expect(screen.getByText("등록된 비즈니스 룸이 없습니다")).toBeInTheDocument()
  })
})

describe("VenuesConsole — 장소 추가", () => {
  it("유형별 추가 버튼으로 그 유형에만 장소가 추가된다", async () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    await userEvent.click(screen.getByRole("button", { name: "매칭존 테이블 추가" }))
    await userEvent.type(screen.getByLabelText("이름"), "T-05")
    await userEvent.click(screen.getByRole("button", { name: "추가" }))

    await waitFor(() => expect(screen.getByText("T-05")).toBeInTheDocument())
    expect(screen.getByRole("heading", { name: /매칭존 테이블 · 3곳/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /비즈니스 룸 · 1곳/ })).toBeInTheDocument()
  })

  it("같은 유형 내 라벨 중복은 클라이언트에서 막고 추가하지 않는다", async () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    await userEvent.click(screen.getByRole("button", { name: "매칭존 테이블 추가" }))
    await userEvent.type(screen.getByLabelText("이름"), "T-01")
    await userEvent.click(screen.getByRole("button", { name: "추가" }))

    // 검증 실패는 다이얼로그를 닫지 않는다(그대로 열려 있어야 함) — 목록도 늘지 않는다.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getAllByText("T-01")).toHaveLength(1)
  })

  it("다른 유형이면 같은 라벨이어도 통과한다", async () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    await userEvent.click(screen.getByRole("button", { name: "비즈니스 룸 추가" }))
    await userEvent.type(screen.getByLabelText("이름"), "T-01")
    await userEvent.click(screen.getByRole("button", { name: "추가" }))

    await waitFor(() => expect(screen.getAllByText("T-01")).toHaveLength(2))
  })
})

describe("VenuesConsole — 이름 변경", () => {
  it("이름변경 버튼으로 라벨을 고치면 목록에 반영된다", async () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    const row = screen.getByText("T-02").closest("tr")!
    await userEvent.click(within(row).getByRole("button", { name: "이름변경" }))

    const input = screen.getByLabelText("이름")
    await userEvent.clear(input)
    await userEvent.type(input, "T-99")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))

    await waitFor(() => {
      expect(screen.getByText("T-99")).toBeInTheDocument()
      expect(screen.queryByText("T-02")).not.toBeInTheDocument()
    })
  })
})

describe("VenuesConsole — 삭제", () => {
  it("사용 중이지 않은 장소는 확인 후 목록에서 사라진다", async () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    await userEvent.click(screen.getByRole("button", { name: "T-02 삭제" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/T-02/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))

    await waitFor(() => expect(screen.queryByText("T-02")).not.toBeInTheDocument())
  })

  // Tooltip(Radix)의 호버 노출 콘텐츠는 jsdom에서 안정적으로 검증하기 어렵다(레이아웃·포인터
  // 캡처 의존 — 이 코드베이스의 다른 Tooltip 사용처도 hover 결과 텍스트는 테스트하지 않는다,
  // components/app-sidebar.test.tsx 참고). 여기선 기능적으로 중요한 "비활성화" 자체만 검증한다.
  it("meeting_count>0인 장소는 삭제 버튼이 비활성화된다(사용 중인 미팅 건수는 TooltipContent로 안내)", () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    expect(screen.getByRole("button", { name: "T-01 삭제" })).toBeDisabled()
  })

  // 이슈 #16① — DELETE가 실패하면 행을 유지하고 실패를 토스트로 보여준다(mock 모드는 항상 성공하므로 실연동 모드로 전환해 fetch를
  // 직접 모킹한다 — admin-actions.test.ts와 같은 패턴).
  it("DELETE가 500이면 행을 유지하고 실패를 보여준다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ detail: "internal error" }), { status: 500 }))
    vi.stubGlobal("fetch", fetchSpy)

    renderConsole({ venues, eventId: "evt-1", readOnly: false })
    await userEvent.click(screen.getByRole("button", { name: "T-02 삭제" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))

    await waitFor(() => expect(screen.getByText("T-02")).toBeInTheDocument())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("삭제에 실패했어요", expect.any(Object)))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})

describe("VenuesConsole — 읽기 전용(sub 권한)", () => {
  it("추가·이름변경·삭제 버튼을 전부 감춘다", () => {
    renderConsole({ venues, eventId: "evt-1", readOnly: true })
    expect(screen.queryByRole("button", { name: "매칭존 테이블 추가" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "이름변경" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "T-01 삭제" })).not.toBeInTheDocument()
    // 조회는 그대로 된다.
    expect(screen.getByText("T-01")).toBeInTheDocument()
  })
})
