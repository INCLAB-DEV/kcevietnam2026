import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OrganizersConsole } from "./organizers-console"
import type { AdminOrganizer } from "@/lib/admin/types"

// 이슈 #16③ — 운영자 관리 목록에 raw 회원 UUID가 노출되지 않아야 한다. 이름·이메일로 충분하다.
// 2026-09-17 — 서브어드민 부여는 **로그인 이메일**로, **서버 확정 후에만** 행을 추가한다(유령 행·지어낸 id 금지).

type GrantResult = { success: boolean; error?: string; organizer?: AdminOrganizer }
type RevokeResult = { success: boolean; error?: string }
const grantSubAdmin = vi.hoisted(() => vi.fn<(eventId: string, email: string) => Promise<GrantResult>>())
const revokeOrganizer = vi.hoisted(() =>
  vi.fn<(eventId: string, organizerId: string) => Promise<RevokeResult>>(),
)
vi.mock("@/lib/admin/admin-actions", () => ({ grantSubAdmin, revokeOrganizer }))

const toastError = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: Object.assign(toastInfo, { error: toastError }) }))

function renderConsole(props: ComponentProps<typeof OrganizersConsole>) {
  return render(<OrganizersConsole {...props} />)
}

function org(
  over: Partial<AdminOrganizer> & Pick<AdminOrganizer, "id" | "name">
): AdminOrganizer {
  return {
    event_id: "evt-test",
    member_id: "048a8903-a125-4e60-9682-cb6dd0cebb9d",
    email: "sean@example.com",
    permission_level: "master",
    trade_office: null,
    granted_at: "2026-09-09T11:48:00+09:00",
    ...over,
  }
}

const MASTER_ROW = org({ id: "org-1", name: "Sean 운영자" })

beforeEach(() => {
  grantSubAdmin.mockReset()
  revokeOrganizer.mockReset()
  revokeOrganizer.mockResolvedValue({ success: true, error: undefined })
  toastError.mockClear()
  toastInfo.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("OrganizersConsole — 회원 UUID 비노출(#16③)", () => {
  it("회원 ID 컬럼도, raw UUID 값도 화면에 없다", () => {
    renderConsole({
      organizers: [MASTER_ROW],
      eventId: "evt-1",
      timeZone: "Asia/Seoul",
      readOnly: false,
    })

    expect(screen.getByText("Sean 운영자")).toBeInTheDocument()
    expect(screen.getByText("sean@example.com")).toBeInTheDocument()
    expect(screen.queryByText("회원 ID")).not.toBeInTheDocument()
    expect(
      screen.queryByText("048a8903-a125-4e60-9682-cb6dd0cebb9d")
    ).not.toBeInTheDocument()
  })
})

async function openGrantDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "서브어드민 부여" }))
  return screen.findByRole("dialog")
}

describe("OrganizersConsole — 서브어드민 부여(이메일·서버 확정)", () => {
  it("부여 다이얼로그는 회원 UUID가 아니라 로그인 이메일을 받는다", async () => {
    const user = userEvent.setup()
    renderConsole({ organizers: [MASTER_ROW], eventId: "evt-1", timeZone: "Asia/Seoul", readOnly: false })

    const dialog = await openGrantDialog(user)
    const input = within(dialog).getByLabelText("회원 이메일")
    expect(input).toHaveAttribute("type", "email")
    expect(within(dialog).queryByLabelText("회원 ID")).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/조회 전용/)).not.toBeInTheDocument()
  })

  it("서버가 거절하면(없는 회원) 행을 만들지 않고 이유를 알리며 다이얼로그를 남긴다", async () => {
    grantSubAdmin.mockResolvedValueOnce({ success: false, error: "MEMBER_NOT_FOUND" })
    const user = userEvent.setup()
    renderConsole({ organizers: [MASTER_ROW], eventId: "evt-1", timeZone: "Asia/Seoul", readOnly: false })

    const dialog = await openGrantDialog(user)
    await user.type(within(dialog).getByLabelText("회원 이메일"), "nobody@kotra.or.kr")
    await user.click(within(dialog).getByRole("button", { name: "서브어드민 부여" }))

    await waitFor(() => expect(grantSubAdmin).toHaveBeenCalledWith("evt-1", "nobody@kotra.or.kr"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][1]?.description)).toContain("가입한 회원이 없습니다")
    // 다이얼로그가 열려 있으면 Radix가 배경을 aria-hidden으로 가린다 — hidden 포함으로 센다.
    expect(screen.getAllByRole("row", { hidden: true })).toHaveLength(2) // 헤더 + master 1행 — 유령 행 없음
    expect(screen.queryByText("nobody@kotra.or.kr", { selector: "td" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("성공하면 서버 응답(실명·이메일·배정 id)으로만 행을 추가하고, 그 id로 곧바로 회수할 수 있다", async () => {
    grantSubAdmin.mockResolvedValueOnce({
      success: true,
      organizer: org({
        id: "eo-server-42",
        name: "박무역",
        email: "trade@kotra.or.kr",
        permission_level: "sub",
        member_id: "7f1c2d3e-0000-4000-8000-000000000042",
        granted_at: "2026-09-17T10:00:00+09:00",
      }),
    })
    const user = userEvent.setup()
    renderConsole({ organizers: [MASTER_ROW], eventId: "evt-1", timeZone: "Asia/Seoul", readOnly: false })

    const dialog = await openGrantDialog(user)
    await user.type(within(dialog).getByLabelText("회원 이메일"), "Trade@kotra.or.kr")
    await user.click(within(dialog).getByRole("button", { name: "서브어드민 부여" }))

    expect(await screen.findByText("박무역")).toBeInTheDocument()
    expect(screen.getByText("trade@kotra.or.kr")).toBeInTheDocument()
    expect(screen.queryByText("7f1c2d3e-0000-4000-8000-000000000042")).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(String(toastInfo.mock.calls.at(-1)?.[1]?.description)).not.toContain("조회만")

    await user.click(screen.getByRole("button", { name: "박무역 권한 회수" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "회수" }))

    await waitFor(() => expect(revokeOrganizer).toHaveBeenCalledWith("evt-1", "eo-server-42"))
    await waitFor(() => expect(screen.queryByText("박무역")).not.toBeInTheDocument())
  })

  it("회수가 실패하면 행을 지우지 않는다(사라진 척하지 않는다)", async () => {
    revokeOrganizer.mockResolvedValueOnce({ success: false, error: "http_500" })
    const user = userEvent.setup()
    const subRow = org({ id: "eo-sub-1", name: "김관할", email: "kim@kotra.or.kr", permission_level: "sub" })
    renderConsole({ organizers: [MASTER_ROW, subRow], eventId: "evt-1", timeZone: "Asia/Seoul", readOnly: false })

    await user.click(screen.getByRole("button", { name: "김관할 권한 회수" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "회수" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByText("김관할", { selector: "td" })).toBeInTheDocument()
  })
})
