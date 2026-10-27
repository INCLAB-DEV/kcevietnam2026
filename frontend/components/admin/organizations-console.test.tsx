import { screen, waitFor, within } from "@testing-library/react"
import { render } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
import { toast } from "sonner"
import { OrganizationsConsole } from "./organizations-console"
import { toAdminOrganization } from "@/lib/admin/http-client"
import type { AdminEvent, AdminEventSettings, AdminOrgProfile } from "@/lib/admin/types"
import { BOOTH_BODY_KEYS, type OperatorOrgDetailApi } from "@/lib/operator/application-client"
import { testBuyerDetail, testExhibitorDetail } from "@/lib/test/operator-application"

// 신청서 저장·명단 업로드 뒤 목록을 다시 읽는 router.refresh — 저장 테스트가 호출 여부를 본다.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
}))

// 실연동 모드의 백엔드 흉내 — 신청서 패널은 열 때마다 상세(GET .../organizations/{id})를 읽는다.
// 그 밖의 요청(쓰기)은 handler가 맡고, 안 맡으면 빈 200이다. 응답은 호출마다 새로 만든다(본문은 한 번만 읽힌다).
type BackendHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response> | undefined

function stubBackend(
  details: Record<string, OperatorOrgDetailApi>,
  handler: BackendHandler = () => undefined,
) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const detailMatch = /\/api\/admin\/events\/event\/organizations\/([^/?]+)$/.exec(url)
    if (method === "GET" && detailMatch) {
      const detail = details[detailMatch[1]]
      return detail
        ? Response.json(detail)
        : Response.json({ detail: "기업을 찾을 수 없습니다" }, { status: 404 })
    }
    return (await handler(url, init)) ?? Response.json({})
  })
  vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// 쓰기 요청만(패널의 상세 조회 GET을 뺀다).
function writesOf(fetchMock: ReturnType<typeof stubBackend>) {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }))
    .filter(({ init }) => (init?.method ?? "GET") !== "GET")
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(init?.body as string) as Record<string, unknown>

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
    await userEvent.click(within(dialog).getByRole("button", { name: "바이어 명단" }))
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

  const submittedDetail = {
    "submitted-1": testExhibitorDetail({ application_status: "submitted" }, { id: "submitted-1" }),
  }

  it("master는 검토 대기 행을 열면 승인/반려/수정요청 버튼이 보이고, 승인을 누르면 review 엔드포인트를 때린 뒤 상태가 바뀐다", async () => {
    const fetchMock = stubBackend(submittedDetail, () =>
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

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    expect(screen.getByText("승인 심사")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const { url, init } = writesOf(fetchMock)[0]
    expect(url).toBe("/api/admin/events/event/organizations/submitted-1/review")
    expect(init?.method).toBe("PATCH")
    expect(bodyOf(init)).toEqual({ status: "approved" })

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
    stubBackend(submittedDetail, () =>
      Response.json({ detail: "제출(submitted) 상태만 검토할 수 있습니다" }, { status: 409 })
    )

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 시트는 열린 채 유지되고(닫지 않음), 목록 상태도 검토 대기 그대로다.
    expect(screen.getByText("승인 심사")).toBeInTheDocument()
  })

  // 네트워크 단절은 fetch가 throw한다 — pending이 안 풀리면 버튼이 영구히 잠겨 재시도조차 못 한다.
  it("네트워크 오류로 요청이 실패해도 버튼이 잠기지 않고 다시 시도할 수 있다", async () => {
    const fetchMock = stubBackend(submittedDetail, () => {
      throw new TypeError("Failed to fetch")
    })

    renderWithRow({ canManageRoles: true })
    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await userEvent.click(screen.getByRole("button", { name: "승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const retry = screen.getByRole("button", { name: "승인" })
    expect(retry).toBeEnabled()
    await userEvent.click(retry)
    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(2))
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

// 신청서 편집(고객 요청 2026-10-08) — "기업 관리 → 신청서 편집에서 처음 입력한 항목 중 안 보이는 것이
// 있다(선호 바이어 국가·구분, 미팅 불가 시간). 모든 항목을 수정 가능하게." 시트의 본문은 행사 운영 콘솔과
// 함께 쓰는 패널이다(components/operator/application-panel — 패널 자체의 동작은 그쪽 테스트가 본다).
// 여기선 콘솔의 배선만 본다: 열 때마다 서버에서 읽는가, 권한이 화면에 맞게 걸리는가, 저장 뒤 목록을
// 다시 읽는가.
describe("admin application editor — 신청서 편집 패널", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const exhibitor = rows[0] // 방송 참가사 · approved
  const buyerRow = toAdminOrganization(
    { id: "buyer-1", name_ko: "하노이미디어", is_exhibitor: false, is_buyer: true, application_status: "approved" },
    "event"
  )
  const details = {
    broadcast: testExhibitorDetail({ organization_name_ko: "방송 참가사" }, { id: "broadcast" }),
    "buyer-1": testBuyerDetail({}, { id: "buyer-1" }),
  }
  const event: AdminEvent = {
    id: "event",
    name: "K-콘텐츠 엑스포",
    venue_name: "SECC",
    exhibition_start: "2026-10-20",
    exhibition_end: "2026-10-21",
    application_start: "2026-09-01",
    application_end: "2026-10-10",
    timezone: "Asia/Ho_Chi_Minh",
  }
  const settings: AdminEventSettings = {
    event_id: "event",
    slot_minutes: 60,
    enabled_venue_types: ["booth"],
    allow_same_role_discovery: false,
    operating_start: "10:00",
    operating_end: "12:00",
    lunch_start: null,
    lunch_end: null,
    min_guaranteed_slots: 10,
    slot_gap_minutes: 0,
    max_meeting_minutes: 90,
    participant_menu: "meetings_only",
    participant_email_enabled: true,
  }

  function renderConsole(props: {
    canManageRoles: boolean
    readOnly?: boolean
    profiles?: Record<string, AdminOrgProfile>
  }) {
    return render(
      <OrganizationsConsole
        organizations={[exhibitor, buyerRow]}
        profiles={props.profiles ?? {}}
        eventId="event"
        event={event}
        settings={settings}
        readOnly={props.readOnly ?? false}
        canManageRoles={props.canManageRoles}
        actorName="운영자"
      />
    )
  }

  function rowFor(name: string) {
    return within(screen.getByRole("table"))
      .getAllByRole("row")
      .find((r) => within(r).queryByText(name))!
  }

  async function openSheet(name: string, action = "신청서 편집") {
    await userEvent.click(within(rowFor(name)).getByRole("button", { name: action }))
    await screen.findByText("현재 신청 상태")
    return screen.getByRole("dialog")
  }

  // 시트 위에 뜬 구획 다이얼로그(가장 나중에 열린 것).
  async function sectionDialog(title: string) {
    await screen.findByRole("heading", { name: title })
    return screen.getAllByRole("dialog").at(-1)!
  }

  it("열 때마다 서버에서 새로 읽는다 — 목록과 함께 실려 온 profiles를 초깃값으로 쓰지 않는다", async () => {
    const fetchMock = stubBackend(details)
    // 목록 화면이 들고 있는 옛 값(예: 다른 운영자가 그 사이 고쳤다).
    const stale = { broadcast: { company_intro_ko: "목록에 실려 온 옛 소개" } as AdminOrgProfile }
    renderConsole({ canManageRoles: true, profiles: stale })

    const sheet = await openSheet("방송 참가사")
    await userEvent.click(within(sheet).getByRole("tab", { name: "회사소개" }))

    expect(within(sheet).getByText("웹툰·게임을 만드는 스튜디오입니다.")).toBeInTheDocument()
    expect(screen.queryByText("목록에 실려 온 옛 소개")).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      "/api/admin/events/event/organizations/broadcast"
    )

    // 닫았다 다시 열면 다시 읽는다.
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("현재 신청 상태")).not.toBeInTheDocument())
    await openSheet("방송 참가사")
    const reads = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url) === "/api/admin/events/event/organizations/broadcast" &&
        ((init as RequestInit | undefined)?.method ?? "GET") === "GET"
    )
    expect(reads).toHaveLength(2)
  })

  it("고객이 안 보인다고 한 세 항목(선호 바이어 국가·구분, 미팅 불가 시간)이 보이고 수정된다", async () => {
    const saved = testExhibitorDetail({
      organization_name_ko: "방송 참가사",
      preferred_buyer_countries: ["vietnam", "thailand", "japan"],
    }).exhibitor_profile
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/profile?role=exhibitor") ? Response.json(saved) : undefined
    )
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("방송 참가사")
    expect(within(sheet).getByText("미팅 불가 시간")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: /10\/20 .* 10:00 불가 해제/ })).toBeEnabled()

    await userEvent.click(within(sheet).getByRole("tab", { name: "타겟" }))
    expect(within(sheet).getByText("베트남, 태국")).toBeInTheDocument()
    expect(within(sheet).getByText("방송·미디어")).toBeInTheDocument()

    await userEvent.click(within(sheet).getByRole("button", { name: "타겟 수정" }))
    const dialog = await sectionDialog("타겟 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "일본" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const { url, init } = writesOf(fetchMock)[0]
    expect(url).toBe("/api/admin/events/event/organizations/broadcast/profile?role=exhibitor")
    expect(init?.method).toBe("PATCH")
    expect(bodyOf(init)).toEqual({
      preferred_buyer_countries: ["vietnam", "thailand", "japan"],
      preferred_buyer_types: ["media"],
    })
    // 서버 응답으로 다시 그리고, 목록도 서버에서 다시 읽는다. 시트는 닫히지 않는다.
    expect(await within(sheet).findByText("베트남, 태국, 일본")).toBeInTheDocument()
    expect(mockRefresh).toHaveBeenCalled()
    expect(screen.getByText("현재 신청 상태")).toBeInTheDocument()
  })

  it("미팅 불가 시간 칸을 누르면 전용 엔드포인트로 전체 목록이 나간다(master)", async () => {
    const saved = testExhibitorDetail({
      unavailable_meeting_slots: ["2026-10-20T10:00", "2026-10-21T11:00"],
    }).exhibitor_profile
    const fetchMock = stubBackend(details, (url) =>
      url.endsWith("/unavailable-slots") ? Response.json(saved) : undefined
    )
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("방송 참가사")
    await userEvent.click(within(sheet).getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const { url, init } = writesOf(fetchMock)[0]
    expect(url).toBe("/api/admin/events/event/organizations/broadcast/unavailable-slots")
    expect(bodyOf(init)).toEqual({ slots: ["2026-10-20T10:00", "2026-10-21T11:00"] })
    expect(await within(sheet).findByText("불가 2칸")).toBeInTheDocument()
  })

  it("master는 부스를 고치고, 저장하면 booth_location으로 실려 나간다", async () => {
    const saved = testExhibitorDetail({ booth_location: "01" }).exhibitor_profile
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/profile?role=exhibitor") ? Response.json(saved) : undefined
    )
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("방송 참가사")
    await userEvent.click(within(sheet).getByRole("button", { name: "부스 수정" }))
    const dialog = await sectionDialog("부스 수정")
    const booth = within(dialog).getByLabelText("부스위치")
    await userEvent.clear(booth)
    await userEvent.type(booth, "01")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchMock)[0].init)).toEqual({ booth_location: "01" })
    expect(toast.success).toHaveBeenCalled()
  })

  it("sub는 부스가 보이기만 하고, 저장 본문에 부스 키가 실리지 않는다", async () => {
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/profile?role=exhibitor")
        ? Response.json(testExhibitorDetail().exhibitor_profile)
        : undefined
    )
    renderConsole({ canManageRoles: false })

    const sheet = await openSheet("방송 참가사")
    expect(within(sheet).getAllByText("A-12").length).toBeGreaterThan(0) // 값은 보인다
    expect(within(sheet).queryByRole("button", { name: "부스 수정" })).not.toBeInTheDocument()
    expect(within(sheet).getByText(/부스는 슈퍼관리자가 지정합니다/)).toBeInTheDocument()
    // 미팅 불가 시간도 읽기 전용이다.
    expect(within(sheet).getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ })).toBeDisabled()

    await userEvent.click(within(sheet).getByRole("button", { name: "기본정보 수정" }))
    const dialog = await sectionDialog("기본정보 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const body = bodyOf(writesOf(fetchMock)[0].init)
    for (const key of BOOTH_BODY_KEYS) expect(body).not.toHaveProperty(key)
    expect(body.attendees).toHaveLength(2) // 담당자는 전체가 실린다
  })

  it("조회 전용(readOnly)은 같은 패널을 읽기 전용으로 보여 준다 — 수정 버튼이 없다", async () => {
    stubBackend(details)
    renderConsole({ canManageRoles: false, readOnly: true })

    const sheet = await openSheet("방송 참가사", "신청서 보기")
    expect(within(sheet).getByText(/조회 전용입니다/)).toBeInTheDocument()
    expect(within(sheet).getAllByText("A-12").length).toBeGreaterThan(0)
    expect(within(sheet).queryByRole("button", { name: /수정$/ })).not.toBeInTheDocument()
  })

  it("저장이 실패하면(403) 토스트로 알리고 다이얼로그·입력을 그대로 둔다(낙관 반영 금지)", async () => {
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/profile?role=exhibitor")
        ? Response.json({ detail: "부스 지정은 슈퍼관리자만 할 수 있습니다" }, { status: 403 })
        : undefined
    )
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("방송 참가사")
    await userEvent.click(within(sheet).getByRole("button", { name: "부스 수정" }))
    const dialog = await sectionDialog("부스 수정")
    const booth = within(dialog).getByLabelText("부스위치")
    await userEvent.clear(booth)
    await userEvent.type(booth, "99")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][1]).toMatchObject({
      description: expect.stringContaining("수정할 권한이 없습니다"),
    })
    // 다이얼로그는 열린 채, 방금 입력한 값이 그대로 남아 재시도할 수 있다.
    expect(within(dialog).getByLabelText("부스위치")).toHaveValue("99")
    expect(toast.success).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(2))
  })

  it("네트워크가 끊겨 fetch가 reject돼도 입력이 남고 같은 자리에서 다시 저장할 수 있다", async () => {
    const fetchMock = stubBackend(details, (url) => {
      if (url.includes("/profile?role=exhibitor")) throw new TypeError("Failed to fetch")
      return undefined
    })
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("방송 참가사")
    await userEvent.click(within(sheet).getByRole("button", { name: "부스 수정" }))
    const dialog = await sectionDialog("부스 수정")
    await userEvent.type(within(dialog).getByLabelText("부스타입"), "+")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(within(dialog).getByLabelText("부스타입")).toHaveValue("독립부스+")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(2))
  })

  it("바이어 — 구분 여러 개가 그대로 보이고, 기본정보를 저장해도 전부 실려 나간다", async () => {
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/profile?role=buyer") ? Response.json(testBuyerDetail().buyer_profile) : undefined
    )
    renderConsole({ canManageRoles: true })

    const sheet = await openSheet("하노이미디어")
    expect(
      within(sheet).getByText("방송·미디어, 민간기업(제작·유통), 전시·에이전시")
    ).toBeInTheDocument()
    expect(within(sheet).getByText("VN-0001")).toBeInTheDocument() // 운영자 전용 항목

    await userEvent.click(within(sheet).getByRole("button", { name: "기본정보 수정" }))
    const dialog = await sectionDialog("기본정보 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const { url, init } = writesOf(fetchMock)[0]
    expect(url).toBe("/api/admin/events/event/organizations/buyer-1/profile?role=buyer")
    expect(bodyOf(init).org_types).toEqual(["media", "private_commercial", "exhibition_agent"])
  })

  it("신청서를 못 읽으면(403) 옛 값을 그리지 않고 안내한다", async () => {
    stubBackend({}, () => undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ detail: "이 바이어는 관할 밖입니다" }, { status: 403 }))
    )
    renderConsole({ canManageRoles: false })

    await userEvent.click(within(rowFor("하노이미디어")).getByRole("button", { name: "신청서 편집" }))

    expect(await screen.findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.getByText(/이 기업을 열람할 권한이 없습니다/)).toBeInTheDocument()
  })
})

// 대리작성(미신청 기업) — 열 때 서버에서 읽고, 저장 결과를 기다리고, 성공하면 곧바로 신청서 편집 패널로 넘어간다.
describe("admin proxy write — 대리작성 뒤 이어서 편집", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const registered = toAdminOrganization(
    { id: "new-1", name_ko: "신규 참가사", is_exhibitor: true, is_buyer: false, application_status: "registered" },
    "event"
  )

  // 서버가 돌려주는 미신청 기업의 상세 — 프로필 행이 없어도 백엔드는 빈 프로필을 돌려준다.
  // profile로 "참가자가 써 둔 초안" 값을 얹는다.
  function registeredDetail(profile: Record<string, unknown> = {}): OperatorOrgDetailApi {
    return {
      id: "new-1",
      org_event_role_id: "role-new",
      event_id: "event",
      name_ko: "신규 참가사",
      name_en: null,
      is_exhibitor: true,
      is_buyer: false,
      application_status: "registered",
      proxy_written_by_organizer_id: null,
      buyer_profile: null,
      exhibitor_profile: {
        org_event_role_id: "role-new",
        application_status: "registered",
        organization_name_ko: "신규 참가사",
        ...profile,
      },
    } as unknown as OperatorOrgDetailApi
  }

  function renderConsole(profiles: Record<string, AdminOrgProfile> = {}) {
    return render(
      <OrganizationsConsole
        organizations={[registered]}
        profiles={profiles}
        eventId="event"
        event={null}
        settings={null}
        readOnly={false}
        canManageRoles
        actorName="운영자"
      />
    )
  }

  // 대리작성 다이얼로그를 열고, 서버에서 읽기가 끝나 폼이 그려질 때까지 기다린다.
  async function openProxyDialog() {
    await userEvent.click(screen.getByRole("button", { name: "대리작성" }))
    return screen.findByLabelText("기업소개(영문)")
  }

  it("대리작성이 성공하면 상태가 승인으로 바뀌고 같은 기업의 신청서 편집 패널이 곧바로 열린다", async () => {
    const afterProxy = testExhibitorDetail(
      { organization_name_ko: "신규 참가사", intro_en: "Our studio", application_status: "approved" },
      { id: "new-1", proxy_written_by_organizer_id: "organizer-1" }
    )
    const details: Record<string, OperatorOrgDetailApi> = { "new-1": registeredDetail() }
    const fetchMock = stubBackend(details, (url) => {
      if (!url.includes("/proxy-profile")) return undefined
      details["new-1"] = afterProxy // 서버 상태가 바뀐다
      return Response.json(afterProxy.exhibitor_profile)
    })
    renderConsole()

    await userEvent.type(await openProxyDialog(), "Our studio")
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    const { url, init } = writesOf(fetchMock)[0]
    expect(url).toBe("/api/admin/events/event/organizations/new-1/proxy-profile?role=exhibitor")
    expect(init?.method).toBe("POST")
    // 운영자가 바꾼 칸만 나간다(담당자·부스·사업자등록번호 없음).
    expect(bodyOf(init)).toEqual({ intro_en: "Our studio" })

    // 대리작성 다이얼로그가 내려가고, 패널이 서버에서 새로 읽어 열린다.
    expect(await screen.findByText("현재 신청 상태")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "신청서 대리작성" })).not.toBeInTheDocument()
    // 작성 주체 표시는 목록 행·시트 머리말·패널 상태줄에 함께 보인다.
    expect(screen.getAllByText("운영자 작성").length).toBeGreaterThan(0)
    expect(within(screen.getByRole("table", { hidden: true })).getByText("승인")).toBeInTheDocument()
    expect(mockRefresh).toHaveBeenCalled()
  })

  // 미신청은 참가자가 신청서를 작성하는 중일 수 있는 상태다. 초깃값을 목록 화면이 읽어 둔 값으로 채우면
  // 참가자가 그 뒤 써 둔 초안이 보이지 않고, 옛 값에서 출발한 저장이 초안(특히 전체 교체인 제품 목록)을 덮는다.
  it("다이얼로그는 목록 화면의 값이 아니라 열 때 서버에서 읽은 값으로 채우고, 운영자가 바꾼 칸만 보낸다", async () => {
    // 목록 화면이 읽어 둔 옛 값.
    const listed = {
      organization_id: "new-1",
      website: "https://list-old.example",
      company_intro_en: "Old intro from the list",
      categories: [],
      available_languages: [],
      preferred_buyer_countries: [],
      preferred_buyer_types: [],
      products: [],
    } as unknown as AdminOrgProfile
    // 서버의 지금 값 — 참가자가 그 사이 써 둔 초안.
    const draft = registeredDetail({
      website: "https://draft.example",
      intro_en: "Draft intro",
      annual_sales_range: "krw_10_50",
      exhibition_categories: ["content_production"],
      preferred_buyer_countries: ["vietnam"],
      products: [{ name_ko: "작성 중인 제품", name_en: "Draft product" }],
    })
    const fetchMock = stubBackend({ "new-1": draft }, (url) =>
      url.includes("/proxy-profile") ? Response.json(draft.exhibitor_profile) : undefined
    )
    renderConsole({ "new-1": listed })

    expect(await openProxyDialog()).toHaveValue("Draft intro")
    expect(screen.getByLabelText("홈페이지")).toHaveValue("https://draft.example")
    await userEvent.type(screen.getByLabelText("회사소개(국문)"), "운영자가 채운 소개")
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchMock)[0].init)).toEqual({ intro_ko: "운영자가 채운 소개" })
  })

  it("저장 직전에 다시 읽어, 운영자가 바꾼 칸이 그 사이 서버에서도 바뀌었으면 보내지 않는다(충돌)", async () => {
    const product = { name_ko: "작성 중인 제품", name_en: "Draft product" }
    const details: Record<string, OperatorOrgDetailApi> = {
      "new-1": registeredDetail({ products: [product] }),
    }
    const fetchMock = stubBackend(details)
    renderConsole()

    await openProxyDialog()
    // 다이얼로그를 열어 둔 사이 참가자가 제품을 하나 더 넣었다.
    details["new-1"] = registeredDetail({
      products: [product, { name_ko: "참가자가 추가한 제품", name_en: "Added" }],
    })
    // 운영자는 열 때의 목록(1개)에서 제품을 지운다 — 보내면 "전체 = 빈 목록"이 돼 추가분까지 사라진다.
    await userEvent.click(screen.getByRole("tab", { name: "사업분야" }))
    await userEvent.click(screen.getByRole("button", { name: "작성 중인 제품 삭제" }))
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(writesOf(fetchMock)).toHaveLength(0)
    // 다이얼로그는 열린 채, 목록 상태도 미신청 그대로다.
    expect(screen.getByRole("heading", { name: "신청서 대리작성" })).toBeInTheDocument()
    expect(within(screen.getByRole("table", { hidden: true })).getByText("미신청")).toBeInTheDocument()

    // 같은 창에서 다시 눌러도 보내지 않는다(기준은 열 때 읽은 값이다).
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(writesOf(fetchMock)).toHaveLength(0)
  })

  // 본문 조립은 빈 값을 "안 건드림"으로 다뤄 키를 뺀다 — 충돌 비교까지 그 규칙으로 하면 참가자가 **지운**
  // 값을 운영자의 저장이 되살린다.
  it("다이얼로그를 연 뒤 참가자가 지운 칸에 운영자가 새 값을 넣어 저장하면 보내지 않는다(충돌)", async () => {
    const details: Record<string, OperatorOrgDetailApi> = {
      "new-1": registeredDetail({ intro_en: "Draft intro", website: "https://draft.example" }),
    }
    const fetchMock = stubBackend(details)
    renderConsole()

    const introEn = await openProxyDialog()
    expect(introEn).toHaveValue("Draft intro")
    // 참가자가 그 사이 영문 소개를 지웠다(서버 값이 빈 값이 됐다).
    details["new-1"] = registeredDetail({ intro_en: null, website: "https://draft.example" })
    await userEvent.clear(introEn)
    await userEvent.type(introEn, "Operator intro")
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    // POST는 나가지 않았다.
    expect(writesOf(fetchMock)).toHaveLength(0)
    expect(screen.getByRole("heading", { name: "신청서 대리작성" })).toBeInTheDocument()
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Operator intro")
  })

  it("운영자가 손대지 않은 칸이 서버에서 바뀐 것은 충돌이 아니다 — 고친 칸만 보내고 그 칸은 그대로 남는다", async () => {
    const product = { name_ko: "작성 중인 제품", name_en: "Draft product" }
    const details: Record<string, OperatorOrgDetailApi> = {
      "new-1": registeredDetail({ products: [product] }),
    }
    const fetchMock = stubBackend(details, (url) =>
      url.includes("/proxy-profile") ? Response.json(details["new-1"].exhibitor_profile) : undefined
    )
    renderConsole()

    await userEvent.type(await openProxyDialog(), "Operator intro")
    details["new-1"] = registeredDetail({
      products: [product, { name_ko: "참가자가 추가한 제품", name_en: "Added" }],
    })
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(1))
    // 제품은 본문에 없다 — 서버의 두 제품이 그대로 남는다.
    expect(bodyOf(writesOf(fetchMock)[0].init)).toEqual({ intro_en: "Operator intro" })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("저장 직전 재조회가 실패하면 모르는 채로 보내지 않는다", async () => {
    const details: Record<string, OperatorOrgDetailApi> = { "new-1": registeredDetail() }
    const fetchMock = stubBackend(details)
    renderConsole()

    await userEvent.type(await openProxyDialog(), "Our studio")
    delete details["new-1"] // 이제 상세 조회가 404다
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("대리작성을 저장하지 못했어요")
    expect(writesOf(fetchMock)).toHaveLength(0)
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Our studio")
    await waitFor(() => expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled())
  })

  it("서버 프로필을 읽지 못하면 폼을 그리지 않고 저장을 막는다", async () => {
    const fetchMock = stubBackend({}) // 상세 조회가 404
    renderConsole()

    await userEvent.click(screen.getByRole("button", { name: "대리작성" }))

    expect(await screen.findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.queryByLabelText("기업소개(영문)")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeDisabled()
    expect(writesOf(fetchMock)).toHaveLength(0)
  })

  it("대리작성이 실패하면(409) 다이얼로그를 닫지 않고 입력을 유지한다", async () => {
    const fetchMock = stubBackend({ "new-1": registeredDetail() }, (url) =>
      url.includes("/proxy-profile")
        ? Response.json({ detail: "대리작성은 미신청(registered) 상태에서만 가능합니다" }, { status: 409 })
        : undefined
    )
    renderConsole()

    await userEvent.type(await openProxyDialog(), "Our studio")
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole("heading", { name: "신청서 대리작성" })).toBeInTheDocument()
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Our studio")
    expect(screen.queryByText("현재 신청 상태")).not.toBeInTheDocument()
    // 목록 상태도 미신청 그대로다.
    expect(within(screen.getByRole("table", { hidden: true })).getByText("미신청")).toBeInTheDocument()
    expect(writesOf(fetchMock)).toHaveLength(1)
  })

  it("네트워크가 끊겨도 닫히지 않고 다시 저장할 수 있다", async () => {
    const fetchMock = stubBackend({ "new-1": registeredDetail() }, (url) => {
      if (url.includes("/proxy-profile")) throw new TypeError("Failed to fetch")
      return undefined
    })
    renderConsole()

    await userEvent.type(await openProxyDialog(), "Our studio")
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Our studio")
    await waitFor(() => expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled())
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(writesOf(fetchMock)).toHaveLength(2))
  })
})

// 역할 전환 — 시트의 패널은 행의 역할로 신청서를 읽으므로, 서버가 확정하기 전에 화면만 바꾸면 어긋난다.
describe("admin role switch — 서버 확정 뒤에만 바꾼다", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const exhibitor = { ...rows[0], meeting_count: 0 }

  function renderConsole() {
    return render(
      <OrganizationsConsole
        organizations={[exhibitor]}
        profiles={{}}
        eventId="event"
        event={null}
        settings={null}
        readOnly={false}
        canManageRoles
        actorName="운영자"
      />
    )
  }

  it("서버가 거절하면 역할 배지를 바꾸지 않고 알린다", async () => {
    stubBackend({ broadcast: testExhibitorDetail({}, { id: "broadcast" }) }, (url) =>
      url.endsWith("/role")
        ? Response.json({ detail: "이 기업은 이미 미팅이 있어 역할을 바꿀 수 없습니다" }, { status: 409 })
        : undefined
    )
    renderConsole()

    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await screen.findByText("현재 신청 상태")
    await userEvent.click(screen.getByRole("button", { name: "바이어로 전환" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "바이어로 전환" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "참가사로 전환" })).not.toBeInTheDocument()
  })

  it("서버가 확정하면 역할이 바뀌고 새 역할의 신청서를 다시 읽는다", async () => {
    let role: "exhibitor" | "buyer" = "exhibitor"
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") === "GET") {
        return Response.json(
          role === "exhibitor"
            ? testExhibitorDetail({}, { id: "broadcast" })
            : testBuyerDetail({}, { id: "broadcast" })
        )
      }
      if (url.endsWith("/role")) role = "buyer"
      return Response.json({})
    })
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", fetchMock)
    renderConsole()

    await userEvent.click(screen.getByRole("button", { name: "신청서 편집" }))
    await screen.findByText("미팅 불가 시간") // 참가사 패널
    await userEvent.click(screen.getByRole("button", { name: "바이어로 전환" }))

    expect(await screen.findByRole("button", { name: "참가사로 전환" })).toBeInTheDocument()
    // 바이어 신청서로 다시 읽어 그린다(바이어에는 미팅 불가 시간이 없다).
    expect(await screen.findByText("VN-0001")).toBeInTheDocument()
    expect(screen.queryByText("미팅 불가 시간")).not.toBeInTheDocument()
  })
})
