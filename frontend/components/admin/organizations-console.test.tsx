import { screen, waitFor, within } from "@testing-library/react"
import { render } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
import { toast } from "sonner"
import { OrganizationsConsole } from "./organizations-console"
import { toAdminOrganization } from "@/lib/admin/http-client"

// 명단 업로드 다이얼로그(components/roster)가 적용 후 router.refresh를 부른다 — 열었을 때만 필요하다.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const rows = [
  toAdminOrganization(
    {
      id: "broadcast",
      name_ko: "방송 참가사",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
      content_category: "broadcasting",
      exhibition_categories: ["content_production", "game_production"],
      match_count: 4,
    },
    "event"
  ),
  toAdminOrganization(
    {
      id: "animation",
      name_ko: "애니 참가사",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
      content_category: "animation_character",
      exhibition_categories: ["game_production"],
    },
    "event"
  ),
]

describe("admin organization categories", () => {
  it("shows the three category and eight field choices, and filters the table", async () => {
    render(
      <OrganizationsConsole
        organizations={rows}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly
        canManageRoles={false}
        actorName="운영자"
      />
    )
    expect(
      screen.getByRole("columnheader", { name: "카테고리" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("columnheader", { name: "사업분야/관심분야" })
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    const categoryMenu = screen.getByRole("menu")
    expect(within(categoryMenu).getAllByRole("menuitemcheckbox")).toHaveLength(
      3
    )
    await userEvent.click(
      within(categoryMenu).getByRole("menuitemcheckbox", { name: "방송" })
    )
    expect(screen.getByText("방송 참가사")).toBeInTheDocument()
    expect(screen.queryByText("애니 참가사")).not.toBeInTheDocument()

    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("button", { name: "사업분야" }))
    expect(
      within(screen.getByRole("menu")).getAllByRole("menuitemcheckbox")
    ).toHaveLength(8)
  })
})

describe("admin proxy application UX", () => {
  it("shows provenance separately from the proxy-write action", () => {
    const legacyProxy = {
      ...rows[0],
      id: "legacy-proxy",
      application_status: "registered" as const,
      proxy_written: true,
    }
    render(
      <OrganizationsConsole
        organizations={[legacyProxy]}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly={false}
        canManageRoles
        actorName="운영자"
      />
    )

    expect(screen.getByText("운영자 작성")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "대리작성" })).toBeInTheDocument()
    expect(screen.getAllByText("대리작성")).toHaveLength(1)
  })
})

describe("admin roster upload (shared with /organizer/members)", () => {
  afterEach(() => vi.unstubAllGlobals())

  function renderConsole(props: { readOnly: boolean; canManageRoles: boolean; organizations?: typeof rows }) {
    return render(
      <OrganizationsConsole
        organizations={props.organizations ?? rows}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly={props.readOnly}
        canManageRoles={props.canManageRoles}
        actorName="운영자"
      />
    )
  }

  it("is available to sub operators too and uploads to the selected event through the shared dialog", async () => {
    const result = { added: 1, updated: 0, unchanged: 0, skipped: 0, changes: [], rows: [] }
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result }))
    vi.stubGlobal("fetch", fetchMock)
    // sub(서브어드민): 신청서 편집은 되고(readOnly=false) 거버넌스(canManageRoles)는 막힌 상태.
    renderConsole({ readOnly: false, canManageRoles: false })

    await userEvent.click(screen.getByRole("button", { name: "명단 업로드" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.upload(
      within(dialog).getByLabelText("명단 파일"),
      new File(["id,role,name_ko\r\nby-1,바이어,하노이미디어"], "roster.csv", { type: "text/csv" })
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "미리보기" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/organizer/members/roster?event_id=event")
  })

  it("is hidden for read-only access", () => {
    renderConsole({ readOnly: true, canManageRoles: false })
    expect(screen.queryByRole("button", { name: "명단 업로드" })).not.toBeInTheDocument()
  })

  it("shows organizations the server sends after a refresh (upload apply → router.refresh)", () => {
    const view = renderConsole({ readOnly: true, canManageRoles: false })
    expect(screen.queryByText("새 바이어")).not.toBeInTheDocument()

    const added = toAdminOrganization(
      { id: "new-buyer", name_ko: "새 바이어", is_exhibitor: false, is_buyer: true, application_status: "registered" },
      "event"
    )
    view.rerender(
      <OrganizationsConsole
        organizations={[...rows, added]}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly
        canManageRoles={false}
        actorName="운영자"
      />
    )

    expect(screen.getByText("새 바이어")).toBeInTheDocument()
  })
})

// Task A — /admin/organizations에서도 승인 심사(승인/반려/수정요청)를 할 수 있어야 한다.
// 결정 UI 자체(사유 입력 + 버튼)는 organizer 콘솔과 공유(components/review-decision-actions) —
// 여기선 admin 콘솔의 배선(master 전용 노출·서버 확정 후 반영·실패 시 상태 유지)만 검증한다.
describe("admin approval — 신청서 승인/반려/수정요청", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const submittedOrg = toAdminOrganization(
    {
      id: "submitted-1",
      name_ko: "검토 대기 기업",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "submitted",
    },
    "event"
  )

  function renderWithRow(props: { canManageRoles: boolean; readOnly?: boolean; org?: typeof submittedOrg }) {
    return render(
      <OrganizationsConsole
        organizations={[props.org ?? submittedOrg]}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly={props.readOnly ?? false}
        canManageRoles={props.canManageRoles}
        actorName="운영자"
      />
    )
  }

  it("master는 검토 대기 행을 열면 승인/반려/수정요청 버튼이 보이고, 승인을 누르면 review 엔드포인트를 때린 뒤 상태가 바뀐다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "submitted-1",
        event_id: "event",
        org_event_role_id: "role-1",
        application_status: "approved",
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
      })
    )
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    expect(screen.getByText("승인 심사")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/admin/events/event/organizations/submitted-1/review")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ status: "approved" })

    await waitFor(() => expect(screen.queryByText("승인 심사")).not.toBeInTheDocument())
    expect(within(screen.getByRole("table")).getByText("승인")).toBeInTheDocument()
    expect(toast).toHaveBeenCalled()
  })

  it("sub(canManageRoles=false)는 검토 대기 행을 열어도 승인 심사 UI가 없다", async () => {
    renderWithRow({ canManageRoles: false })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    expect(screen.queryByText("승인 심사")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "반려" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "수정요청" })).not.toBeInTheDocument()
  })

  it("submitted가 아닌 행(승인됨)은 master가 열어도 승인 심사 UI가 없다", async () => {
    const approvedOrg = { ...submittedOrg, id: "approved-1", application_status: "approved" as const }
    renderWithRow({ canManageRoles: true, org: approvedOrg })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    expect(screen.queryByText("승인 심사")).not.toBeInTheDocument()
  })

  it("서버가 실패(409)를 돌려주면 오류 토스트를 띄우고 행 상태를 유지한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ detail: "제출(submitted) 상태만 검토할 수 있습니다" }, { status: 409 })
    )
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 시트는 열린 채 유지되고(닫지 않음), 목록 상태도 검토 대기 그대로다.
    expect(screen.getByText("승인 심사")).toBeInTheDocument()
  })

  // 네트워크 단절은 fetch가 throw한다 — pending이 안 풀리면 버튼이 영구히 잠겨 재시도조차 못 한다.
  it("네트워크 오류로 요청이 실패해도 버튼이 잠기지 않고 다시 시도할 수 있다", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const retry = screen.getByRole("button", { name: "승인" })
    expect(retry).toBeEnabled()
    await userEvent.click(retry)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})

// 담당자 계정 비밀번호 설정/재설정(2026-09-21 지시) — /organizer/members와 같은 기능을 어드민
// 콘솔에도 둔다. 행 액션에 두는 이유: 미신청(registered) 기업은 상세 시트가 아니라 대리작성
// 다이얼로그가 열려, 시트 안에만 두면 정작 갓 등록한 기업의 비밀번호를 못 걸기 때문이다.
describe("admin contact password", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  const buyerRow = toAdminOrganization(
    {
      id: "buyer-1",
      name_ko: "하노이미디어",
      is_exhibitor: false,
      is_buyer: true,
      application_status: "registered",
      contact_email: "contact@hanoi.example",
    },
    "event"
  )

  function renderConsole(props: { readOnly: boolean; canManageRoles: boolean }) {
    return render(
      <OrganizationsConsole
        organizations={[...rows, buyerRow]}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly={props.readOnly}
        canManageRoles={props.canManageRoles}
        actorName="운영자"
      />
    )
  }

  function rowFor(name: string) {
    const table = screen.getByRole("table")
    return within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText(name))!
  }

  it("master는 참가사·바이어 어느 행에서도 비밀번호를 설정할 수 있다", () => {
    renderConsole({ readOnly: false, canManageRoles: true })
    expect(within(rowFor("방송 참가사")).getByRole("button", { name: "비밀번호" })).toBeInTheDocument()
    expect(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" })).toBeInTheDocument()
  })

  it("sub는 관할 바이어 행에만 비밀번호 버튼이 보인다(참가사는 master 전용)", () => {
    renderConsole({ readOnly: false, canManageRoles: false })
    expect(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" })).toBeInTheDocument()
    expect(
      within(rowFor("방송 참가사")).queryByRole("button", { name: "비밀번호" })
    ).not.toBeInTheDocument()
  })

  it("조회 전용 접근에는 어느 행에도 보이지 않는다", () => {
    renderConsole({ readOnly: true, canManageRoles: false })
    expect(screen.queryByRole("button", { name: "비밀번호" })).not.toBeInTheDocument()
  })

  it("저장하면 contact-password 엔드포인트로 평문을 본문에만 실어 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ organization_id: "buyer-1", member_id: "m-1", contact_email: "contact@hanoi.example" })
    )
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderConsole({ readOnly: false, canManageRoles: false })
    await userEvent.click(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/admin/events/event/organizations/buyer-1/contact-password")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ password: "Nabi2026pw" })
    // 성공하면 닫히고, 평문은 화면 어디에도 남지 않는다.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.queryByText("Nabi2026pw")).not.toBeInTheDocument()
    expect(toast).toHaveBeenCalled()
  })

  it("두 비밀번호가 다르면 요청 자체를 보내지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderConsole({ readOnly: false, canManageRoles: true })
    await userEvent.click(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pX")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    expect(within(dialog).getByRole("alert")).toHaveTextContent("두 비밀번호가 서로 달라요")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("서버가 운영자 계정이라 거부하면(409) 토스트로 알리고 다이얼로그를 닫지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ detail: { code: "OPERATOR_ACCOUNT", message: "거부" } }, { status: 409 })
    )
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderConsole({ readOnly: false, canManageRoles: true })
    await userEvent.click(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[1]).toMatchObject({
      description: expect.stringContaining("운영자 계정"),
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("네트워크 오류로 fetch가 reject되면 토스트를 띄우고 다이얼로그를 열어둔 채 재시도할 수 있다", async () => {
    // dispatch()(lib/admin/admin-actions.ts)는 fetch 자체를 try/catch하지 않는다 — 단절 시
    // onSubmit이 통째로 throw한다. 다이얼로그가 그 예외를 finally 없이 받으면 busy가 영원히
    // true로 남아 "저장 중"에 멈춘다(P2 회귀 방지).
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json({ organization_id: "buyer-1", member_id: "m-1", contact_email: "contact@hanoi.example" })
      )
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)

    renderConsole({ readOnly: false, canManageRoles: true })
    await userEvent.click(within(rowFor("하노이미디어")).getByRole("button", { name: "비밀번호" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    const saveButton = within(dialog).getByRole("button", { name: "저장" })
    await userEvent.click(saveButton)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 다이얼로그는 열려 있고, 버튼은 다시 눌릴 수 있어야 한다(재시도).
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await waitFor(() => expect(saveButton).toBeEnabled())

    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
