// MembersTable이 useTranslations("help.hints")를 쓰게 되면서(HelpHint 툴팁) NextIntlClientProvider
// 컨텍스트가 필요해졌다 — render-with-intl로 교체(meeting-request-modal.test.tsx와 동일 패턴).
import { act, render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MembersTable } from "./members-table"
import type { MemberRow } from "@/lib/organizer/members"
import { MOCK_DELETION_IMPACT, type MemberDeletionImpact } from "@/lib/organizer/member-deletion"
import { BOOTH_BODY_KEYS, type OperatorOrgDetailApi } from "@/lib/operator/application-client"
import { TEST_SLOT_GRID, testBuyerDetail, testExhibitorDetail } from "@/lib/test/operator-application"

const mockPush = vi.fn()
// 신청서 저장·대리작성 뒤 명단을 다시 읽는 router.refresh — 저장 테스트가 호출 여부를 본다.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}))

// 내보내기 실패 토스트 검증(sub 403 → 조용한 실패 금지)용 — 다른 기존 테스트는 토스트 텍스트를
// 검증하지 않으므로(비화면 사이드이펙트로만 확인) 전역 목업으로 바꿔도 안전하다. vi.mock 팩토리는
// 파일 상단으로 호이스팅되므로 참조할 mock은 vi.hoisted로 함께 끌어올린다.
// 삭제 테스트는 "삭제했어요"(toast)·"명단에 없음"(toast.info)·실패(toast.error)가 서로 섞이지 않는지 본다.
const { mockToast, mockToastError, mockToastInfo } = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: Object.assign(mockToast, { error: mockToastError, success: vi.fn(), info: mockToastInfo }),
}))

function ex(over: Partial<MemberRow>): MemberRow {
  return {
    id: "x",
    name: "테스트",
    nameEn: "Test",
    tab: "exhibitor",
    applicationStatus: "registered",
    primaryContact: "홍길동",
    contactPhone: "010-0000-0000",
    contactEmail: "t@a.com",
    productCategory: "콘텐츠 제작",
    importedAt: "2026-06-10T09:00:00+09:00",
    profileCompletion: 0,
    matchCount: 0,
    lastActivityAt: null,
    ...over,
  }
}

const members: MemberRow[] = [
  ex({
    id: "e1",
    name: "픽셀아츠 스튜디오",
    nameEn: "PixelArts Studio",
    applicationStatus: "approved",
    productCategory: "콘텐츠 제작",
    matchCount: 7,
  }),
  ex({
    id: "e2",
    name: "한강게임즈",
    nameEn: "Hangang Games",
    applicationStatus: "submitted",
    productCategory: "게임 제작",
    matchCount: 3,
  }),
  ex({
    id: "e3",
    name: "툰브릿지",
    nameEn: "ToonBridge",
    applicationStatus: "registered",
    productCategory: "만화웹툰 제작",
    matchCount: 0,
  }),
  {
    id: "b1",
    name: "서울콘텐츠파트너스",
    nameEn: "Seoul Content Partners",
    tab: "buyer",
    applicationStatus: "approved",
    primaryContact: "조현우 사무관",
    contactPhone: "010-1111-2222",
    contactEmail: "cho@dapa.go.kr",
    productCategory: "음악 플랫폼",
    importedAt: "2026-06-02T09:00:00+09:00",
    profileCompletion: 90,
    matchCount: 9,
    lastActivityAt: "2026-06-21T09:00:00+09:00",
    buyerTypeLabel: "초청",
    language: "영어",
    stayInfo: "항공 KE081 · 롯데호텔 · 통역 영어",
    registeredBy: "직접등록",
  },
]

function bodyRows() {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1) // 헤더 제외
}

function rowFor(name: string) {
  return bodyRows().find((r) => within(r).queryByText(name))!
}

// 25개 참가사(이름 가나다 정렬 기준 회사01..25) — 페이지네이션(10/페이지) 검증용
const manyMembers: MemberRow[] = Array.from({ length: 25 }, (_, i) =>
  ex({
    id: `m${i + 1}`,
    name: `회사${String(i + 1).padStart(2, "0")}`,
    nameEn: `Co${i + 1}`,
  })
)

function buyer(over: Partial<MemberRow>): MemberRow {
  return ex({
    tab: "buyer",
    buyerTypeLabel: "사전등록",
    language: "영어",
    stayInfo: null,
    registeredBy: "직접등록",
    ...over,
  })
}

beforeEach(() => {
  mockPush.mockClear()
  mockRefresh.mockClear()
  mockToast.mockClear()
  mockToastError.mockClear()
  mockToastInfo.mockClear()
})

// 실 세션의 BFF 흉내 — 신청서 패널은 열 때마다 GET /api/organizer/members/{id}/profile을 읽는다.
// 그 밖의 요청(쓰기)은 handler가 맡고, 안 맡으면 빈 200이다. 응답은 호출마다 새로 만든다.
type BffHandler = (url: string, init: RequestInit | undefined) => Response | undefined

function stubBff(details: Record<string, OperatorOrgDetailApi>, handler: BffHandler = () => undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const read = /^\/api\/organizer\/members\/([^/]+)\/profile$/.exec(url)
    if (method === "GET" && read) {
      const detail = details[read[1]]
      return detail
        ? Response.json({ success: true, id: read[1], detail, slotGrid: TEST_SLOT_GRID })
        : Response.json({ success: false, error: "기업을 찾을 수 없습니다" }, { status: 404 })
    }
    return handler(url, init) ?? Response.json({})
  })
}

function writesOf(fetchSpy: ReturnType<typeof stubBff>) {
  return fetchSpy.mock.calls
    .map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }))
    .filter(({ init }) => (init?.method ?? "GET") !== "GET")
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(init?.body as string)

// 명단 표 — 다이얼로그가 열려 있으면 접근성 트리에서 가려지고(aria-hidden), 신청서 패널 안에도 표(미팅
// 불가 시간 격자)가 있어 role로는 고를 수 없다. 표식(data-tour)으로 직접 집는다.
function listTable() {
  return document.querySelector<HTMLElement>('[data-tour="members-table"]')!
}

describe("MembersTable — sub(무역관) 권한 게이트", () => {
  const FRANKFURT = "KOTRA 프랑크푸르트무역관"
  const subRows: MemberRow[] = [
    buyer({
      id: "b-own",
      name: "내관할바이어",
      applicationStatus: "submitted",
      registeredBy: FRANKFURT,
    }),
    buyer({
      id: "b-other",
      name: "남의관할바이어",
      registeredBy: "KOTRA 워싱턴무역관",
    }),
    ex({ id: "e1", name: "국내기업A" }),
  ]

  it("바이어 탭만 보이고 자기 관할 바이어만 노출한다", () => {
    render(
      <MembersTable
        members={subRows}
        permissionLevel="sub"
        tradeOffice={FRANKFURT}
      />
    )
    expect(
      screen.queryByRole("tab", { name: "참가사" })
    ).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "바이어" })).toBeInTheDocument()
    expect(screen.getByText("내관할바이어")).toBeInTheDocument()
    expect(screen.queryByText("남의관할바이어")).not.toBeInTheDocument()
    expect(screen.queryByText("국내기업A")).not.toBeInTheDocument()
  })

  it("심사 모달이 읽기전용 — 승인/반려 버튼이 없다(master 전용)", async () => {
    render(
      <MembersTable
        members={subRows}
        permissionLevel="sub"
        tradeOffice={FRANKFURT}
      />
    )
    await userEvent.click(
      within(rowFor("내관할바이어")).getByRole("button", {
        name: "신청서 조회",
      })
    )
    expect(screen.getByText("신청서 조회 · 심사")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "승인" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "반려" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "수정요청" })
    ).not.toBeInTheDocument()
  })

  // DELETE .../organizations/{id}도 require_event_master 전용(app/admin/router.py) — sub에게
  // 보이면 눌러서 403만 맞는다. "비활성화"는 서버에 저장되지 않는 기능이라 없앴다(2026-10-08).
  it("작업 메뉴에 삭제가 없다(master 전용 API) — 비밀번호 설정만 남는다", async () => {
    render(
      <MembersTable
        members={subRows}
        permissionLevel="sub"
        tradeOffice={FRANKFURT}
      />
    )
    await userEvent.click(
      within(rowFor("내관할바이어")).getByRole("button", {
        name: "내관할바이어 작업",
      })
    )
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "비밀번호 설정",
    ])
  })
})

describe("MembersTable — 바이어 컬럼(지정 셋)", () => {
  it("바이어 탭은 이름/소속/직위/관심분야 등 지정 컬럼을 국·영 병기로 보여준다", async () => {
    const buyers = [
      buyer({
        id: "b1",
        name: "Seoul Content Partners",
        nameEn: "Seoul Content Partners",
        applicationStatus: "approved",
        primaryContact: "조현우",
        primaryContactEn: "Hyunwoo Cho",
        contactTitle: "사무관",
        contactTitleEn: "Deputy Director",
        productCategory: "게임 제작",
      }),
    ]
    render(<MembersTable members={buyers} />)
    await userEvent.click(screen.getByRole("tab", { name: "바이어" }))
    for (const h of [
      "바이어 이름",
      "소속",
      "직위",
      "관심분야",
      "비즈매칭 신청서",
    ]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument()
    }
    // 저장소가 없어 항상 비던 컬럼(에이전트 4종·체류정보)은 표에서 뺐다(2026-09-10).
    for (const gone of ["에이전트", "에이전트 담당자", "체류정보"]) {
      expect(
        screen.queryByRole("columnheader", { name: gone })
      ).not.toBeInTheDocument()
    }
    expect(screen.getByText("게임 제작")).toBeInTheDocument()
    expect(screen.getByText("Hyunwoo Cho")).toBeInTheDocument() // 바이어 이름 영문병기
  })
})

describe("MembersTable — 단건 등록", () => {
  it("master는 참가사를 단건 등록한다(미신청으로 추가)", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: /단건 등록/ }))
    expect(screen.getByText("참가사 단건 등록")).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "새참가사")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    await waitFor(() =>
      expect(screen.getByText("새참가사")).toBeInTheDocument()
    )
  })

  // POST .../organizations(단건 등록)는 2026-09-21 지시로 이 행사의 운영자(master·sub) 공용이 됐다
  // (명단 업로드와 같은 규칙). sub는 바이어 탭만 보이므로 역할이 자연히 바이어로 묶이고, 백엔드
  // check_create_jurisdiction이 sub의 참가사 등록을 403으로 막는다.
  it("sub에게도 단건 등록 버튼이 보이고, 참가사는 고를 수 없다(바이어 전용)", async () => {
    const FRANKFURT = "KOTRA 프랑크푸르트무역관"
    render(
      <MembersTable
        members={[]}
        permissionLevel="sub"
        tradeOffice={FRANKFURT}
      />
    )
    expect(screen.queryByRole("tab", { name: "참가사" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /단건 등록/ }))
    expect(screen.getByText("바이어 단건 등록")).toBeInTheDocument()
    expect(screen.queryByText("참가사 단건 등록")).not.toBeInTheDocument()
  })
})

// 담당자 계정 비밀번호 — 단건 등록 시 선택 입력 + 등록 이후 재설정(2026-09-21 지시).
// 평문이 화면 상태 밖으로 새지 않는지(요청 본문에만 실리는지)까지 같이 고정한다.
describe("MembersTable — 단건 등록 비밀번호", () => {
  afterEach(() => vi.restoreAllMocks())

  async function openRegisterDialog(permissionLevel?: "master" | "sub") {
    render(
      permissionLevel === "sub" ? (
        <MembersTable members={[]} permissionLevel="sub" tradeOffice="KOTRA 프랑크푸르트무역관" realSession />
      ) : (
        <MembersTable members={[]} realSession />
      )
    )
    await userEvent.click(screen.getByRole("button", { name: /단건 등록/ }))
  }

  it.each([["master"], ["sub"]] as const)(
    "%s 단건 등록 폼에 비밀번호(선택) 칸이 있다",
    async (level) => {
      await openRegisterDialog(level === "sub" ? "sub" : undefined)
      expect(screen.getByLabelText("비밀번호(선택)")).toBeInTheDocument()
      expect(screen.getByLabelText("비밀번호(선택) 확인")).toBeInTheDocument()
      // 비워두면 어떻게 되는지 화면이 먼저 알려준다("조용히 로그인 불가" 금지).
      expect(screen.getByText(/비우면 이 담당자는 로그인할 수 없어요/)).toBeInTheDocument()
    }
  )

  it("비밀번호 없이도 등록된다(선택 입력)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "org-1" }), { status: 201 }))
    await openRegisterDialog()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "비번없는회사")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.name).toBe("비번없는회사")
    expect(body.password).toBeUndefined()
  })

  it("비밀번호를 넣으면 등록 요청 본문에만 실린다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "org-1" }), { status: 201 }))
    await openRegisterDialog()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "비번있는회사")
    await userEvent.type(screen.getByLabelText("이메일"), "new@buyer.example")
    await userEvent.type(screen.getByLabelText("비밀번호(선택)"), "Nabi2026pw")
    await userEvent.type(screen.getByLabelText("비밀번호(선택) 확인"), "Nabi2026pw")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe("/api/organizer/members")
    expect(JSON.parse((init as RequestInit).body as string).password).toBe("Nabi2026pw")
  })

  it("두 비밀번호가 다르면 등록하지 않는다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "org-1" }), { status: 201 }))
    await openRegisterDialog()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "오타회사")
    await userEvent.type(screen.getByLabelText("이메일"), "typo@buyer.example")
    await userEvent.type(screen.getByLabelText("비밀번호(선택)"), "Nabi2026pw")
    await userEvent.type(screen.getByLabelText("비밀번호(선택) 확인"), "Nabi2026pX")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("두 비밀번호가 서로 달라요")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("정책에 안 맞는 비밀번호는 등록하지 않는다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "org-1" }), { status: 201 }))
    await openRegisterDialog()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "짧은비번회사")
    await userEvent.type(screen.getByLabelText("이메일"), "short@buyer.example")
    await userEvent.type(screen.getByLabelText("비밀번호(선택)"), "short1")
    await userEvent.type(screen.getByLabelText("비밀번호(선택) 확인"), "short1")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("정책에 맞지 않아요")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("비밀번호만 넣고 담당자 이메일을 비우면 등록하지 않는다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "org-1" }), { status: 201 }))
    await openRegisterDialog()
    await userEvent.type(screen.getByLabelText("기업명(국문)"), "이메일없는회사")
    await userEvent.type(screen.getByLabelText("비밀번호(선택)"), "Nabi2026pw")
    await userEvent.type(screen.getByLabelText("비밀번호(선택) 확인"), "Nabi2026pw")
    await userEvent.click(screen.getByRole("button", { name: "등록" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "비밀번호를 설정하려면 담당자 이메일이 필요해요"
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("MembersTable — 비밀번호 설정(재설정)", () => {
  afterEach(() => vi.restoreAllMocks())

  const FRANKFURT = "KOTRA 프랑크푸르트무역관"
  const subRows = [buyer({ id: "b-mine", name: "내관할바이어", registeredBy: FRANKFURT })]

  async function openPasswordDialog(rowName: string) {
    await userEvent.click(within(rowFor(rowName)).getByRole("button", { name: `${rowName} 작업` }))
    await userEvent.click(screen.getByRole("menuitem", { name: "비밀번호 설정" }))
    return screen.getByRole("dialog")
  }

  it("master는 참가사 행에서도 비밀번호를 설정한다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e3", contactEmail: "t@a.com" })))
    render(<MembersTable members={members} realSession />)
    const dialog = await openPasswordDialog("툰브릿지")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe("/api/organizer/members/e3/contact-password")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ password: "Nabi2026pw" })
  })

  it("sub는 자기 관할 바이어의 비밀번호를 설정한다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "b-mine", contactEmail: "t@a.com" })))
    render(
      <MembersTable members={subRows} permissionLevel="sub" tradeOffice={FRANKFURT} realSession />
    )
    const dialog = await openPasswordDialog("내관할바이어")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "/api/organizer/members/b-mine/contact-password"
    )
  })

  it("두 비밀번호가 다르면 저장하지 않는다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    render(<MembersTable members={members} realSession />)
    const dialog = await openPasswordDialog("툰브릿지")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pX")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("두 비밀번호가 서로 달라요")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument() // 닫히지 않는다
  })

  it("서버가 거부하면 토스트로 알리고 다이얼로그를 닫지 않는다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "OPERATOR_ACCOUNT" }), { status: 409 })
    )
    render(<MembersTable members={members} realSession />)
    const dialog = await openPasswordDialog("툰브릿지")
    await userEvent.type(within(dialog).getByLabelText("비밀번호"), "Nabi2026pw")
    await userEvent.type(within(dialog).getByLabelText("비밀번호 확인"), "Nabi2026pw")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError.mock.calls.at(-1)?.[1]).toMatchObject({
      description: expect.stringContaining("운영자 계정"),
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument() // 성공한 척 닫지 않는다
  })
})

describe("MembersTable — 탭", () => {
  it("기본 참가사 탭은 exhibitor만 보여준다", () => {
    render(<MembersTable members={members} />)
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
    expect(screen.queryByText("Seoul Content Partners")).not.toBeInTheDocument()
  })

  it("바이어 탭으로 전환하면 buyer만 보여준다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("tab", { name: "바이어" }))
    expect(screen.getByText("Seoul Content Partners")).toBeInTheDocument()
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
  })
})

describe("MembersTable — 비즈매칭 상태(운영자 라벨)", () => {
  it("registered는 미신청, approved는 승인됨 배지로 구분한다", () => {
    render(<MembersTable members={members} />)
    expect(screen.getAllByText("승인됨").length).toBeGreaterThan(0)
    expect(screen.getByText("미신청")).toBeInTheDocument()
  })
})

describe("MembersTable — 신청서(B층) 조회", () => {
  it("신청서 조회 버튼은 제출 이력 행에만 뜬다(명단만 vs 신청서 작성 구분)", () => {
    render(<MembersTable members={members} />)
    // 제출 이력: 픽셀아츠 스튜디오(approved)·한강게임즈(submitted) → 버튼 있음
    expect(screen.getAllByRole("button", { name: "신청서 조회" })).toHaveLength(
      2
    )
    // 미신청(툰브릿지)은 버튼 없음
    expect(
      within(rowFor("툰브릿지")).queryByRole("button", { name: "신청서 조회" })
    ).not.toBeInTheDocument()
  })

  it("신청서 조회를 누르면 심사 모달이 열린다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", {
        name: "신청서 조회",
      })
    )
    expect(screen.getByText("신청서 조회 · 심사")).toBeInTheDocument()
  })

  // 목업 모드(실 세션 아님)에는 읽어 올 서버가 없다 — 명단 픽스처(profiles)가 패널의 시드가 된다.
  it("목업 모드: 제출 B층 프로필(BM-005) 픽스처를 패널에 그대로 보여준다", async () => {
    const profiles = {
      e1: {
        categories: ["콘텐츠 제작"],
        contactNameKo: "김민수",
        annualSales: "50억원 이상",
        companyIntroKo: "픽셀아츠 스튜디오 소개 테스트문",
        products: [
          {
            nameKo: "웹툰 시리즈 '나이트브릿지'",
            category: "만화웹툰 제작",
            hsCode: "4911.91",
          },
        ],
      },
    }
    render(<MembersTable members={members} profiles={profiles} />)
    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", {
        name: "신청서 조회",
      })
    )
    await userEvent.click(await screen.findByRole("tab", { name: "회사소개" }))
    expect(
      screen.getByText("픽셀아츠 스튜디오 소개 테스트문")
    ).toBeInTheDocument()
    expect(screen.getByText("50억원 이상")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "사업분야" }))
    expect(screen.getByText(/웹툰 시리즈/)).toBeInTheDocument()
  })

  it("승인대기중 신청서를 승인하면 목록 배지가 승인됨으로 바뀐다", async () => {
    render(<MembersTable members={members} />)
    // 한강게임즈 = submitted(승인대기중) → 모달에 승인 버튼이 뜬다
    await userEvent.click(
      within(rowFor("한강게임즈")).getByRole("button", { name: "신청서 조회" })
    )
    await userEvent.click(screen.getByRole("button", { name: "승인" }))
    await waitFor(() =>
      expect(
        within(rowFor("한강게임즈")).getByText("승인됨")
      ).toBeInTheDocument()
    )
  })
})

describe("MembersTable — 행 클릭 → OP-003", () => {
  it("행을 클릭하면 /organizer/members/:id로 이동한다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByText("픽셀아츠 스튜디오"))
    expect(mockPush).toHaveBeenCalledWith("/organizer/members/e1")
  })
})

describe("MembersTable — 검색·필터·정렬", () => {
  it("기업명으로 검색한다(debounce 후)", async () => {
    render(<MembersTable members={members} />)
    await userEvent.type(screen.getByRole("searchbox"), "픽셀아츠")
    await waitFor(() => {
      expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
      expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument()
    })
  })

  it("승인 상태 필터(미신청)는 미신청만 남긴다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "승인 상태" }))
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "미신청" })
    )
    expect(screen.getByText("툰브릿지")).toBeInTheDocument()
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
  })

  it("사업분야 필터(게임 제작)로 거른다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "사업분야" }))
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "게임 제작" })
    )
    expect(screen.getByText("한강게임즈")).toBeInTheDocument()
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
  })

  it("매칭 보유만 필터는 matchCount 0을 제외한다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "매칭 보유만" }))
    expect(screen.queryByText("툰브릿지")).not.toBeInTheDocument()
  })

  it("매칭 건수순 정렬이 매칭 많은 기업을 위로 올린다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: /승인 상태순/ }))
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "매칭 건수순" })
    )
    expect(
      within(bodyRows()[0]).getByText("픽셀아츠 스튜디오")
    ).toBeInTheDocument()
  })
})

// 고객 요청(2026-10-08): "[행사 운영]에서도 참가기업의 신청서를 조회할 수 있는데, 모든 항목이 보이기는
// 하지만 수정할 수가 없네요. 여기서도 내용을 수정할 수 있게 해 주세요."
// "신청서 조회·심사" 다이얼로그의 본문이 관리자 콘솔과 함께 쓰는 패널이다(패널 자체의 동작은
// components/operator/application-panel.test.tsx). 여기선 이 콘솔의 배선을 본다.
describe("MembersTable — 신청서 조회·수정(실 세션)", () => {
  afterEach(() => vi.restoreAllMocks())

  const details = {
    e1: testExhibitorDetail({ organization_name_ko: "픽셀아츠 스튜디오" }, { id: "e1" }),
    b1: testBuyerDetail({ organization_name_ko: "서울콘텐츠파트너스" }, { id: "b1" }),
  }

  async function openReview(name: string, button = "신청서 조회") {
    await userEvent.click(within(rowFor(name)).getByRole("button", { name: button }))
    await screen.findByText("현재 신청 상태")
    return screen.getByRole("dialog")
  }

  async function sectionDialog(title: string) {
    await screen.findByRole("heading", { name: title })
    return screen.getAllByRole("dialog").at(-1)!
  }

  it("신청서 조회를 열면 서버에서 그 기업의 신청서를 새로 읽어 모든 항목을 보여 준다", async () => {
    const fetchSpy = stubBff(details)
    render(<MembersTable members={members} realSession />)

    const modal = await openReview("픽셀아츠 스튜디오")

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(
      "/api/organizer/members/e1/profile"
    )
    expect(within(modal).getByText("신청서 조회 · 심사")).toBeInTheDocument()
    expect(within(modal).getByText("미팅 불가 시간")).toBeInTheDocument()
    await userEvent.click(within(modal).getByRole("tab", { name: "타겟" }))
    expect(within(modal).getByText("베트남, 태국")).toBeInTheDocument()
    expect(within(modal).getByText("방송·미디어")).toBeInTheDocument()
  })

  it("승인된 신청서도 구획을 고쳐 저장할 수 있다 — 직접 수정(edit)으로 전체 페이로드가 나간다", async () => {
    const saved = testExhibitorDetail({
      preferred_buyer_countries: ["vietnam", "thailand", "japan"],
    }).exhibitor_profile
    const fetchSpy = stubBff(details, (url, init) =>
      url === "/api/organizer/members/e1/profile" && init?.method === "PATCH"
        ? Response.json({ success: true, id: "e1", profile: saved })
        : undefined
    )
    render(<MembersTable members={members} realSession />)

    const modal = await openReview("픽셀아츠 스튜디오")
    await userEvent.click(within(modal).getByRole("tab", { name: "타겟" }))
    await userEvent.click(within(modal).getByRole("button", { name: "타겟 수정" }))
    const dialog = await sectionDialog("타겟 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "일본" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    const { url, init } = writesOf(fetchSpy)[0]
    expect(url).toBe("/api/organizer/members/e1/profile")
    expect(init?.method).toBe("PATCH")
    expect(bodyOf(init)).toEqual({
      role: "exhibitor",
      mode: "edit", // 상태를 바꾸지 않는 직접 수정 — 승인된 건도 승인 그대로다
      patch: {
        preferred_buyer_countries: ["vietnam", "thailand", "japan"],
        preferred_buyer_types: ["media"],
      },
    })
    // 서버 응답으로 다시 그리고 명단도 서버에서 다시 읽는다.
    expect(await within(modal).findByText("베트남, 태국, 일본")).toBeInTheDocument()
    expect(mockRefresh).toHaveBeenCalled()
    // 승인 상태는 그대로다(명단 첫 행 = 픽셀아츠 스튜디오).
    expect(within(listTable()).getAllByText("승인됨").length).toBeGreaterThan(0)
  })

  it("행의 '수정'은 신청서가 있는 행이면 같은 패널을 연다", async () => {
    stubBff(details)
    render(<MembersTable members={members} realSession />)

    const modal = await openReview("픽셀아츠 스튜디오", "수정")

    expect(within(modal).getByText("신청서 조회 · 심사")).toBeInTheDocument()
    expect(within(modal).getByRole("button", { name: "기본정보 수정" })).toBeInTheDocument()
    // 예전의 간이 수정 폼(저장되지 않는 칸이 있던)은 뜨지 않는다.
    expect(screen.queryByLabelText("HS코드/품목설명")).not.toBeInTheDocument()
  })

  it("master는 미팅 불가 시간을 고친다 — 전용 BFF로 전체 목록이 나간다", async () => {
    const saved = testExhibitorDetail({
      unavailable_meeting_slots: ["2026-10-20T10:00", "2026-10-21T11:00"],
    }).exhibitor_profile
    const fetchSpy = stubBff(details, (url) =>
      url === "/api/organizer/members/e1/unavailable-slots"
        ? Response.json({ success: true, id: "e1", profile: saved })
        : undefined
    )
    render(<MembersTable members={members} realSession />)

    const modal = await openReview("픽셀아츠 스튜디오")
    await userEvent.click(within(modal).getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(writesOf(fetchSpy)[0].url).toBe("/api/organizer/members/e1/unavailable-slots")
    expect(bodyOf(writesOf(fetchSpy)[0].init)).toEqual({
      slots: ["2026-10-20T10:00", "2026-10-21T11:00"],
    })
    expect(await within(modal).findByText("불가 2칸")).toBeInTheDocument()
  })

  it("sub는 자기 바이어의 신청서를 고칠 수 있다 — 본문에 부스 키는 없다", async () => {
    const fetchSpy = stubBff(details, (url, init) =>
      url === "/api/organizer/members/b1/profile" && init?.method === "PATCH"
        ? Response.json({ success: true, id: "b1", profile: testBuyerDetail().buyer_profile })
        : undefined
    )
    render(<MembersTable members={members} permissionLevel="sub" realSession />)

    const modal = await openReview("서울콘텐츠파트너스")
    // 심사 버튼은 master 전용이다.
    expect(within(modal).queryByRole("button", { name: "승인" })).not.toBeInTheDocument()
    await userEvent.click(within(modal).getByRole("button", { name: "기본정보 수정" }))
    const dialog = await sectionDialog("기본정보 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    const body = bodyOf(writesOf(fetchSpy)[0].init)
    expect(body.role).toBe("buyer")
    expect(body.mode).toBe("edit")
    expect(body.patch.org_types).toEqual(["media", "private_commercial", "exhibition_agent"])
    for (const key of BOOTH_BODY_KEYS) expect(body.patch).not.toHaveProperty(key)
  })

  it("저장이 거부되면(403 관할 밖) 권한 안내를 띄우고 다이얼로그·입력을 유지한다", async () => {
    stubBff(details, (url, init) =>
      url === "/api/organizer/members/b1/profile" && init?.method === "PATCH"
        ? Response.json({ success: false, error: "이 바이어는 관할 밖입니다" }, { status: 403 })
        : undefined
    )
    render(<MembersTable members={members} permissionLevel="sub" realSession />)

    const modal = await openReview("서울콘텐츠파트너스")
    await userEvent.click(within(modal).getByRole("button", { name: "기본정보 수정" }))
    const dialog = await sectionDialog("기본정보 수정")
    await userEvent.type(within(dialog).getByLabelText("직위 (국문)"), "이사")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError.mock.calls[0][0]).toContain("이 기업을 수정할 권한이 없습니다")
    expect(within(dialog).getByLabelText("직위 (국문)")).toHaveValue("이사")
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it("BFF가 저장된 프로필을 돌려주지 않으면 저장된 것으로 치지 않는다", async () => {
    // 세션이 없는 목 분기는 { success: true }만 답한다 — 저장소가 없으므로 실제로는 저장되지 않았다.
    stubBff(details, (url, init) =>
      url === "/api/organizer/members/e1/profile" && init?.method === "PATCH"
        ? Response.json({ success: true, id: "e1" })
        : undefined
    )
    render(<MembersTable members={members} realSession />)

    const modal = await openReview("픽셀아츠 스튜디오")
    await userEvent.click(within(modal).getByRole("button", { name: "기본정보 수정" }))
    const dialog = await sectionDialog("기본정보 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.getByRole("heading", { name: "기본정보 수정" })).toBeInTheDocument()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it("신청서를 못 읽으면(403) 옛 값을 그리지 않고 안내한다", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, error: "이 바이어는 관할 밖입니다" }, { status: 403 })
    )
    render(<MembersTable members={members} realSession />)

    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", { name: "신청서 조회" })
    )

    expect(await screen.findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.getByText(/이 기업을 열람할 권한이 없습니다/)).toBeInTheDocument()
  })
})

describe("MembersTable — 신청서 수정(목업 모드)", () => {
  it("패널에서 기업명을 고치면 명단에 반영된다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", { name: "수정" })
    )
    await userEvent.click(await screen.findByRole("button", { name: "기업명 수정" }))
    await screen.findByRole("heading", { name: "기업명 수정" })
    const dialog = screen.getAllByRole("dialog").at(-1)!
    const nameInput = within(dialog).getByLabelText("기업명(국문)")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "픽셀아츠 스튜디오(수정)")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() =>
      expect(within(listTable()).getByText("픽셀아츠 스튜디오(수정)")).toBeInTheDocument()
    )
  })
})

// 미신청(registered) 행의 "수정" = 대리작성. 예전 폼은 저장되지 않는 칸(기업명·사업분야·HS코드·KST·부스·
// 바이어유형·체류·담당자 전화)을 그대로 보여 줬고, 보낼 필드가 없으면 요청 없이 상태 배지만 바꿨다.
// 서버가 돌려주는 미신청 기업의 상세 — 프로필 행이 없어도 백엔드는 빈 프로필을 돌려준다.
// profile로 "참가자가 써 둔 초안" 값을 얹는다.
function registeredDetail(
  id: string,
  tab: "exhibitor" | "buyer",
  profile: Record<string, unknown> = {},
): OperatorOrgDetailApi {
  const base = { org_event_role_id: `role-${id}`, application_status: "registered", ...profile }
  return {
    id,
    org_event_role_id: `role-${id}`,
    event_id: "event",
    name_ko: null,
    name_en: null,
    is_exhibitor: tab === "exhibitor",
    is_buyer: tab === "buyer",
    application_status: "registered",
    proxy_written_by_organizer_id: null,
    exhibitor_profile: tab === "exhibitor" ? base : null,
    buyer_profile: tab === "buyer" ? base : null,
  } as unknown as OperatorOrgDetailApi
}

describe("MembersTable — 미신청 행 대리작성", () => {
  afterEach(() => vi.restoreAllMocks())

  // 대리작성 폼을 열고, 서버 프로필 읽기가 끝나 칸이 그려질 때까지 기다린다.
  async function openProxy(name: string) {
    await userEvent.click(within(rowFor(name)).getByRole("button", { name: "수정" }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByLabelText("기업명(국문)")
    return dialog
  }

  // 대리작성(PATCH mode=proxy)이 성공하면 서버 상태가 승인으로 바뀐 것처럼 상세를 갈아 끼운다.
  function approveOnProxy(details: Record<string, OperatorOrgDetailApi>, id: string): BffHandler {
    return (url, init) => {
      if (url !== `/api/organizer/members/${id}/profile` || init?.method !== "PATCH") return undefined
      details[id] = testExhibitorDetail({ application_status: "approved" }, { id })
      return Response.json({ success: true, id, profile: details[id].exhibitor_profile })
    }
  }

  it("저장되는 칸만 보여 준다 — 저장되지 않던 칸은 없다", async () => {
    render(<MembersTable members={members} />)
    const dialog = await openProxy("툰브릿지")

    expect(within(dialog).getByText("참가사 신청서 대리작성")).toBeInTheDocument()
    for (const label of ["기업명(국문)", "기업명(영문)", "사업자등록번호", "웹사이트", "대표 전화번호", "회사 이메일", "카테고리", "주소"]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument()
    }
    for (const label of [
      "사업분야",
      "HS코드/품목설명",
      "KST 상담 가능 시간",
      "부스(홀·관·부스번호)",
      "전화번호",
      "담당자(참가자 성명)",
    ]) {
      expect(within(dialog).queryByLabelText(label)).not.toBeInTheDocument()
    }
    // 저장하면 상태가 바뀐다는 것을 먼저 알린다.
    expect(within(dialog).getByText(/상태가 '승인됨'으로 바뀌고/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "대리작성 후 승인" })).toBeInTheDocument()
  })

  it("바이어 대리작성 폼에는 바이어유형·언어·체류정보 칸이 없다", async () => {
    render(
      <MembersTable
        members={[buyer({ id: "b-new", name: "신규바이어", applicationStatus: "registered" })]}
      />
    )
    await userEvent.click(screen.getByRole("tab", { name: "바이어" }))
    const dialog = await openProxy("신규바이어")

    expect(within(dialog).getByLabelText("담당자(참가자 성명)")).toBeInTheDocument()
    for (const label of ["바이어유형", "언어(통역)", "체류정보(항공·숙박·통역)", "관심분야"]) {
      expect(within(dialog).queryByLabelText(label)).not.toBeInTheDocument()
    }
  })

  it("저장하면 대리작성(proxy) 요청이 나간다 — 운영자가 입력한 칸만 실린다", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", { organization_name_ko: "툰브릿지" }) }
    const fetchSpy = stubBff(details, approveOnProxy(details, "e3"))
    render(<MembersTable members={members} realSession />)
    const dialog = await openProxy("툰브릿지")
    // 서버에 회사 이메일이 없다 — 명단 행에 이메일(t@a.com)이 있어도 칸은 비어 있다.
    expect(within(dialog).getByLabelText("회사 이메일")).toHaveValue("")
    await userEvent.type(within(dialog).getByLabelText("웹사이트"), "https://toonbridge.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    const { url, init } = writesOf(fetchSpy)[0]
    expect(url).toBe("/api/organizer/members/e3/profile")
    expect(init?.method).toBe("PATCH")
    const body = bodyOf(init)
    expect(body.role).toBe("exhibitor")
    expect(body.mode).toBe("proxy") // registered(미신청) → 대리작성
    // 손대지 않은 기업명도, 명단 행의 이메일도 보내지 않는다.
    expect(body.patch).toEqual({ website: "https://toonbridge.example" })
  })

  it("기업명을 고치면 실제로 저장된다(organization_name_ko)", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", { organization_name_ko: "툰브릿지" }) }
    const fetchSpy = stubBff(details, approveOnProxy(details, "e3"))
    render(<MembersTable members={members} realSession />)
    const dialog = await openProxy("툰브릿지")
    const nameInput = within(dialog).getByLabelText("기업명(국문)")
    expect(nameInput).toHaveValue("툰브릿지")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "툰브릿지(주)")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init).patch.organization_name_ko).toBe("툰브릿지(주)")
  })

  it("채운 칸이 없어도 요청을 보낸다 — 보내지 않고 상태 배지만 바꾸지 않는다", async () => {
    const details = {
      "e-bare": registeredDetail("e-bare", "exhibitor", { organization_name_ko: "빈값기업" }),
    }
    const fetchSpy = stubBff(details, approveOnProxy(details, "e-bare"))
    const bare: MemberRow[] = [
      ex({ id: "e-bare", name: "빈값기업", primaryContact: null, contactEmail: null, contactPhone: null }),
    ]
    render(<MembersTable members={bare} realSession />)
    const dialog = await openProxy("빈값기업")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init)).toEqual({ role: "exhibitor", mode: "proxy", patch: {} })
  })

  // 대리작성은 저장과 함께 상태가 전이한다(master면 즉시 승인 → 매칭 대상). 서버에 기업명이 하나도 없는데
  // 폼에도 입력이 없으면 이름 없는 기업이 승인된다 — 보내지 않는다.
  it("서버에 기업명이 없고 폼에도 입력이 없으면 요청을 보내지 않고 기업명을 입력하라고 안내한다", async () => {
    const details = { "e-bare": registeredDetail("e-bare", "exhibitor") } // 국문·영문 이름이 모두 없다
    const fetchSpy = stubBff(details, approveOnProxy(details, "e-bare"))
    const bare: MemberRow[] = [
      // 명단은 이름이 없는 기업을 표시용 대체값으로 보여 준다 — 그 값은 폼에 채워지지 않는다.
      ex({ id: "e-bare", name: "(이름 없음)", nameEn: undefined, primaryContact: null, contactEmail: null }),
    ]
    render(<MembersTable members={bare} realSession />)
    const dialog = await openProxy("(이름 없음)")
    expect(within(dialog).getByLabelText("기업명(국문)")).toHaveValue("")
    expect(within(dialog).getByLabelText("기업명(영문)")).toHaveValue("")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("기업명을 입력해 주세요")
    expect(writesOf(fetchSpy)).toHaveLength(0)
    expect(screen.getByText("참가사 신청서 대리작성")).toBeInTheDocument()
    expect(within(listTable()).getByText("미신청")).toBeInTheDocument()

    // 이름을 입력하면 안내가 사라지고 저장된다.
    await userEvent.type(within(dialog).getByLabelText("기업명(국문)"), "새이름기업")
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init).patch).toEqual({ organization_name_ko: "새이름기업" })
  })

  it("대리작성이 성공하면 곧바로 같은 기업의 신청서 편집 패널이 열린다", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", { organization_name_ko: "툰브릿지" }) }
    stubBff(details, approveOnProxy(details, "e3"))
    render(<MembersTable members={members} realSession />)
    const dialog = await openProxy("툰브릿지")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    // 대리작성 폼이 내려가고 패널이 서버에서 새로 읽어 열린다.
    expect(await screen.findByText("현재 신청 상태")).toBeInTheDocument()
    expect(screen.getByText("신청서 조회 · 심사")).toBeInTheDocument()
    expect(screen.queryByText("참가사 신청서 대리작성")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "기본정보 수정" })).toBeInTheDocument()
    expect(mockRefresh).toHaveBeenCalled()
    // 툰브릿지가 승인됨으로 바뀌어, 승인됨 배지가 둘이 됐다(픽셀아츠 + 툰브릿지).
    expect(within(listTable()).getAllByText("승인됨")).toHaveLength(2)
  })

  it("대리작성이 실패하면 폼과 입력을 유지하고 상태 배지를 바꾸지 않는다", async () => {
    stubBff({ e3: registeredDetail("e3", "exhibitor", { organization_name_ko: "툰브릿지" }) }, (url, init) =>
      url === "/api/organizer/members/e3/profile" && init?.method === "PATCH"
        ? Response.json({ success: false, error: "http_409" }, { status: 409 })
        : undefined
    )
    render(<MembersTable members={members} realSession />)
    const dialog = await openProxy("툰브릿지")
    await userEvent.type(within(dialog).getByLabelText("웹사이트"), "https://toonbridge.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.getByText("참가사 신청서 대리작성")).toBeInTheDocument()
    expect(screen.getByLabelText("웹사이트")).toHaveValue("https://toonbridge.example")
    expect(screen.queryByText("현재 신청 상태")).not.toBeInTheDocument()
    expect(within(listTable()).getByText("미신청")).toBeInTheDocument()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it("sub의 대리작성은 '대리작성 후 제출'이고 상태가 승인대기중으로 바뀐다고 알린다", async () => {
    render(
      <MembersTable
        members={[buyer({ id: "b-new", name: "신규바이어", applicationStatus: "registered", registeredBy: "무역관" })]}
        permissionLevel="sub"
        tradeOffice="무역관"
      />
    )
    const dialog = await openProxy("신규바이어")
    expect(within(dialog).getByRole("button", { name: "대리작성 후 제출" })).toBeInTheDocument()
    expect(within(dialog).getByText(/상태가 '승인대기중'으로 바뀌고/)).toBeInTheDocument()
  })
})

// 미신청은 참가자가 신청서를 작성하는 중일 수 있는 상태다. 예전엔 폼 초깃값이 명단 행에서 왔고 폼에 값이
// 있으면 전부 보내, 운영자가 아무것도 안 고쳐도 참가자가 써 둔 초안을 명단 값으로 덮었다(리뷰 지적 A).
describe("MembersTable — 대리작성은 서버의 현재 프로필을 기준으로 한다", () => {
  afterEach(() => vi.restoreAllMocks())

  // 참가자가 써 둔 초안 — 명단 행(ex 기본값: 이메일 t@a.com 등)과 값이 다르다.
  const DRAFT = {
    organization_name_ko: "툰브릿지",
    organization_name_en: "ToonBridge",
    business_reg_no: "111-22-33333",
    website: "https://draft.example",
    company_email: "draft@toonbridge.example",
    main_tel: "02-111-1111",
    address_ko: "초안 주소",
    content_category: "broadcasting",
  }
  // 명단 행 — 초안과 다른 옛 값들.
  const roster: MemberRow[] = [
    ex({
      id: "e3",
      name: "툰브릿지",
      nameEn: "ToonBridge",
      contactEmail: "roster@toonbridge.example",
      mainTel: "02-999-9999",
      businessRegNo: "999-99-99999",
      website: "https://roster.example",
      address: "명단 주소",
      contentCategory: "game",
    }),
  ]

  async function openProxy() {
    await userEvent.click(within(rowFor("툰브릿지")).getByRole("button", { name: "수정" }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByLabelText("기업명(국문)")
    return dialog
  }

  const proxyOk: BffHandler = (url, init) =>
    url === "/api/organizer/members/e3/profile" && init?.method === "PATCH"
      ? Response.json({
          success: true,
          id: "e3",
          profile: testExhibitorDetail({ application_status: "approved" }, { id: "e3" }).exhibitor_profile,
        })
      : undefined

  it("폼은 명단 값이 아니라 서버 값으로 채워지고, 아무것도 안 고치고 저장하면 그 값들이 본문에 없다", async () => {
    const fetchSpy = stubBff({ e3: registeredDetail("e3", "exhibitor", DRAFT) }, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()

    expect(within(dialog).getByLabelText("사업자등록번호")).toHaveValue("111-22-33333")
    expect(within(dialog).getByLabelText("웹사이트")).toHaveValue("https://draft.example")
    expect(within(dialog).getByLabelText("회사 이메일")).toHaveValue("draft@toonbridge.example")
    expect(within(dialog).getByLabelText("대표 전화번호")).toHaveValue("02-111-1111")
    expect(within(dialog).getByLabelText("주소")).toHaveValue("초안 주소")

    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    // 상태 전이만 일어난다 — 참가자의 초안은 한 칸도 되보내지 않는다.
    expect(bodyOf(writesOf(fetchSpy)[0].init)).toEqual({ role: "exhibitor", mode: "proxy", patch: {} })
  })

  it("한 칸만 고치면 그 칸만 보낸다", async () => {
    const fetchSpy = stubBff({ e3: registeredDetail("e3", "exhibitor", DRAFT) }, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()
    const address = within(dialog).getByLabelText("주소")
    await userEvent.clear(address)
    await userEvent.type(address, "운영자가 고친 주소")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init).patch).toEqual({ address_ko: "운영자가 고친 주소" })
  })

  // 명단 행의 값은 같은 컬럼에서 온 것이 아니다 — 예: 명단의 이메일은 "회사 이메일 or 담당자 이메일 or 회원
  // 이메일"의 파생값이라, 빈 회사 이메일 칸을 그 값으로 채우면 담당자 개인 이메일이 company_email로 저장된다.
  it("서버 칸이 비어 있으면 명단 행에 값이 있어도 빈 칸으로 보이고, 무수정 저장 본문에 그 칸이 없다", async () => {
    const partial = {
      ...DRAFT,
      business_reg_no: null,
      company_email: null,
      main_tel: null,
      content_category: null,
    }
    const fetchSpy = stubBff({ e3: registeredDetail("e3", "exhibitor", partial) }, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()
    // 명단 행에는 사업자등록번호·이메일·대표 전화·카테고리가 있지만(roster) 칸은 비어 있다.
    expect(within(dialog).getByLabelText("사업자등록번호")).toHaveValue("")
    expect(within(dialog).getByLabelText("회사 이메일")).toHaveValue("")
    expect(within(dialog).getByLabelText("대표 전화번호")).toHaveValue("")
    // 값이 있던 칸은 서버 값 그대로다.
    expect(within(dialog).getByLabelText("웹사이트")).toHaveValue("https://draft.example")

    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init)).toEqual({ role: "exhibitor", mode: "proxy", patch: {} })
  })

  it("비어 있던 칸은 운영자가 입력했을 때만 저장된다", async () => {
    const partial = { ...DRAFT, company_email: null }
    const fetchSpy = stubBff({ e3: registeredDetail("e3", "exhibitor", partial) }, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()
    await userEvent.type(within(dialog).getByLabelText("회사 이메일"), "office@toonbridge.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init).patch).toEqual({
      company_email: "office@toonbridge.example",
    })
  })

  it("고친 칸을 참가자가 그 사이 지웠으면(서버 값이 비었으면) 보내지 않는다(충돌)", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", DRAFT) }
    const fetchSpy = stubBff(details, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()

    details.e3 = registeredDetail("e3", "exhibitor", { ...DRAFT, website: null })
    const website = within(dialog).getByLabelText("웹사이트")
    await userEvent.clear(website)
    await userEvent.type(website, "https://operator.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError.mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(writesOf(fetchSpy)).toHaveLength(0)
  })

  it("서버 프로필을 읽지 못하면 폼을 그리지 않고 저장을 막는다 — 다시 불러오면 열린다", async () => {
    const details: Record<string, OperatorOrgDetailApi> = {}
    const fetchSpy = stubBff(details, proxyOk) // 상세 조회가 404
    render(<MembersTable members={roster} realSession />)
    await userEvent.click(within(rowFor("툰브릿지")).getByRole("button", { name: "수정" }))
    const dialog = await screen.findByRole("dialog")

    expect(await within(dialog).findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(within(dialog).queryByLabelText("웹사이트")).not.toBeInTheDocument()
    const save = within(dialog).getByRole("button", { name: "대리작성 후 승인" })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(writesOf(fetchSpy)).toHaveLength(0)

    details.e3 = registeredDetail("e3", "exhibitor", DRAFT)
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 불러오기" }))
    expect(await within(dialog).findByLabelText("웹사이트")).toHaveValue("https://draft.example")
    expect(within(dialog).getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled()
  })

  it("저장 직전에 다시 읽어, 고친 칸이 그 사이 서버에서도 바뀌었으면 보내지 않는다(충돌)", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", DRAFT) }
    const fetchSpy = stubBff(details, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()

    // 다이얼로그를 열어 둔 사이 참가자가 웹사이트를 고쳤다.
    details.e3 = registeredDetail("e3", "exhibitor", { ...DRAFT, website: "https://participant-new.example" })
    const website = within(dialog).getByLabelText("웹사이트")
    await userEvent.clear(website)
    await userEvent.type(website, "https://operator.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError.mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(writesOf(fetchSpy)).toHaveLength(0)
    expect(screen.getByText("참가사 신청서 대리작성")).toBeInTheDocument()
    expect(screen.getByLabelText("웹사이트")).toHaveValue("https://operator.example")
    expect(within(listTable()).getByText("미신청")).toBeInTheDocument()
  })

  it("손대지 않은 칸이 서버에서 바뀐 것은 충돌이 아니다 — 고친 칸만 보낸다", async () => {
    const details = { e3: registeredDetail("e3", "exhibitor", DRAFT) }
    const fetchSpy = stubBff(details, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()

    details.e3 = registeredDetail("e3", "exhibitor", { ...DRAFT, address_ko: "참가자가 고친 주소" })
    const website = within(dialog).getByLabelText("웹사이트")
    await userEvent.clear(website)
    await userEvent.type(website, "https://operator.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    // 주소는 본문에 없다 — 참가자가 고친 주소가 그대로 남는다.
    expect(bodyOf(writesOf(fetchSpy)[0].init).patch).toEqual({ website: "https://operator.example" })
  })

  it("저장 직전 재조회가 실패하면 모르는 채로 보내지 않는다", async () => {
    const details: Record<string, OperatorOrgDetailApi> = {
      e3: registeredDetail("e3", "exhibitor", DRAFT),
    }
    const fetchSpy = stubBff(details, proxyOk)
    render(<MembersTable members={roster} realSession />)
    const dialog = await openProxy()
    await userEvent.type(within(dialog).getByLabelText("웹사이트"), "/new")
    delete details.e3 // 이제 상세 조회가 404다
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError.mock.calls[0][0]).toBe("대리작성을 저장하지 못했어요")
    expect(writesOf(fetchSpy)).toHaveLength(0)
    expect(screen.getByLabelText("웹사이트")).toHaveValue("https://draft.example/new")
  })

  it("바이어: 신청자 성명·이메일도 서버 값이 먼저다 — 무수정 저장은 초안을 덮지 않는다", async () => {
    const draft = {
      organization_name_en: "Hanoi Media",
      contact_name_ko: "응우옌 반 안",
      contact_email: "an@hanoimedia.example",
    }
    const fetchSpy = stubBff({ "b-new": registeredDetail("b-new", "buyer", draft) }, (url, init) =>
      url === "/api/organizer/members/b-new/profile" && init?.method === "PATCH"
        ? Response.json({
            success: true,
            id: "b-new",
            profile: testBuyerDetail({ application_status: "approved" }, { id: "b-new" }).buyer_profile,
          })
        : undefined
    )
    render(
      <MembersTable
        members={[
          buyer({
            id: "b-new",
            name: "Hanoi Media",
            applicationStatus: "registered",
            primaryContact: "명단 담당자",
            contactEmail: "roster@hanoimedia.example",
          }),
        ]}
        realSession
      />
    )
    await userEvent.click(screen.getByRole("tab", { name: "바이어" }))
    await userEvent.click(within(rowFor("Hanoi Media")).getByRole("button", { name: "수정" }))
    const dialog = await screen.findByRole("dialog")

    expect(await within(dialog).findByLabelText("담당자(참가자 성명)")).toHaveValue("응우옌 반 안")
    expect(within(dialog).getByLabelText("이메일")).toHaveValue("an@hanoimedia.example")
    // 국문 기업명이 서버에 없다 — 명단의 표시용 이름(영문명)을 국문 칸에 채우지 않는다.
    expect(within(dialog).getByLabelText("기업명(국문)")).toHaveValue("")
    await userEvent.click(within(dialog).getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(writesOf(fetchSpy)).toHaveLength(1))
    expect(bodyOf(writesOf(fetchSpy)[0].init)).toEqual({ role: "buyer", mode: "proxy", patch: {} })
  })
})

describe("MembersTable — 단건 등록 폼", () => {
  afterEach(() => vi.restoreAllMocks())

  it("실 세션에서 등록이 실패하면 폼과 입력을 그대로 둔다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "http_409" }), { status: 409 })
    )
    render(<MembersTable members={members} realSession />)
    await userEvent.click(screen.getByRole("button", { name: /단건 등록/ }))
    const dialog = screen.getByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("기업명(국문)"), "중복 이메일 기업")
    await userEvent.type(within(dialog).getByLabelText("이메일"), "dup@corp.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.getByText("참가사 단건 등록")).toBeInTheDocument()
    expect(screen.getByLabelText("기업명(국문)")).toHaveValue("중복 이메일 기업")
    expect(screen.getByLabelText("이메일")).toHaveValue("dup@corp.example")
  })

  it("등록 요청에 실리는 칸만 보여 준다(신청서 항목은 받지 않는다)", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: /단건 등록/ }))
    const dialog = screen.getByRole("dialog")

    for (const label of ["기업명(국문)", "기업명(영문)", "담당자(참가자 성명)", "전화번호", "이메일"]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument()
    }
    for (const label of [
      "사업자등록번호",
      "웹사이트",
      "대표 전화번호",
      "사업분야",
      "HS코드/품목설명",
      "KST 상담 가능 시간",
      "주소",
      "부스(홀·관·부스번호)",
    ]) {
      expect(within(dialog).queryByLabelText(label)).not.toBeInTheDocument()
    }
  })
})

describe("MembersTable — 행 작업 메뉴", () => {
  // "비활성화"는 화면에서 행만 숨기고 서버에는 아무것도 저장하지 않았다(새로고침하면 돌아오고 배정
  // 대상에서도 빠지지 않았다). 저장되지 않는 기능은 남기지 않는다.
  it("'비활성화'가 없다 — 비밀번호 설정과 삭제만 있다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "한강게임즈 작업" }))
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "비밀번호 설정",
      "삭제",
    ])
    expect(screen.queryByText("비활성화")).not.toBeInTheDocument()
  })
})

describe("MembersTable — 삭제", () => {
  afterEach(() => vi.restoreAllMocks())

  // 삭제 흐름의 BFF 흉내 — 확인 다이얼로그가 열릴 때 삭제 영향(GET .../deletion-impact)을 읽고,
  // 삭제를 누르면 DELETE를 보낸다. 응답은 호출마다 새로 만든다(impact는 요청 URL로 기업을 가를 수 있다).
  function stubDeleteBff(handlers: {
    impact: (url: string) => Response | Promise<Response>
    remove?: () => Response | Promise<Response>
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && String(input).endsWith("/deletion-impact")) {
        return handlers.impact(String(input))
      }
      if (method === "DELETE") {
        return (handlers.remove ?? (() => Response.json({ success: true, id: "e3" })))()
      }
      return Response.json({})
    })
  }

  const impactOf = (over: Partial<MemberDeletionImpact> = {}) =>
    Response.json({ success: true, id: "e3", impact: { ...MOCK_DELETION_IMPACT, ...over } })

  const requestsOf = (fetchSpy: ReturnType<typeof stubDeleteBff>, method: string) =>
    fetchSpy.mock.calls
      .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method)
      .map(([url]) => String(url))

  async function openDeleteDialog(name: string) {
    await userEvent.click(screen.getByRole("button", { name: `${name} 작업` }))
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }))
    return screen.getByRole("dialog")
  }

  const deleteButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "삭제" })
  const listHas = (name: string) => within(listTable()).queryByText(name) !== null

  it("다이얼로그를 열면 그 기업의 삭제 영향을 서버에서 읽어, 함께 지워지는 것을 보여 준다", async () => {
    const fetchSpy = stubDeleteBff({
      impact: () =>
        impactOf({ closedMeetingCount: 2, reviewCount: 1, notificationCount: 3, memberCount: 1 }),
    })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(
      await within(dialog).findByText(
        "취소·거절된 미팅 2건과 회의록 1건·알림 3건이 함께 삭제됩니다.",
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByText("로그인 계정 1개도 삭제됩니다.")).toBeInTheDocument()
    expect(within(dialog).getByText("되돌릴 수 없습니다.")).toBeInTheDocument()
    expect(requestsOf(fetchSpy, "GET")).toEqual(["/api/organizer/members/e3/deletion-impact"])
    expect(requestsOf(fetchSpy, "DELETE")).toEqual([]) // 열기만 해서는 아무것도 지우지 않는다
  })

  it("서버가 삭제를 확인한 뒤에만 목록에서 뺀다", async () => {
    let answer!: (response: Response) => void
    const fetchSpy = stubDeleteBff({
      impact: () => impactOf(),
      remove: () => new Promise<Response>((resolve) => (answer = resolve)),
    })
    render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    // 요청은 나갔지만 서버가 아직 답하지 않았다 — 행도 다이얼로그도 그대로다(낙관적으로 지우지 않는다).
    await waitFor(() =>
      expect(requestsOf(fetchSpy, "DELETE")).toEqual(["/api/organizer/members/e3"]),
    )
    expect(listHas("툰브릿지")).toBe(true)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(mockRefresh).not.toHaveBeenCalled()

    answer(Response.json({ success: true, id: "e3" }))

    await waitFor(() => expect(listHas("툰브릿지")).toBe(false))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mockRefresh).toHaveBeenCalledTimes(1) // 실 세션은 명단을 서버에서 다시 읽는다
    expect(listHas("한강게임즈")).toBe(true)
  })

  it("예정 미팅이 있으면 이유와 할 일을 보여 주고 삭제 버튼을 막는다", async () => {
    const fetchSpy = stubDeleteBff({
      impact: () => impactOf({ deletable: false, scheduledCount: 2, completedCount: 1 }),
    })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(
      await within(dialog).findByText(
        "예정된 미팅이 2건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요.",
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "완료된 미팅이 1건 있어 삭제할 수 없습니다(상대 기업의 회의록이 함께 사라집니다).",
      ),
    ).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    await userEvent.click(deleteButton(dialog))
    expect(requestsOf(fetchSpy, "DELETE")).toEqual([])
    expect(listHas("툰브릿지")).toBe(true)
  })

  it("삭제 영향을 읽지 못하면 실패를 알리고 삭제를 막는다 — 다시 확인하면 읽는다", async () => {
    let attempts = 0
    const fetchSpy = stubDeleteBff({
      impact: () =>
        ++attempts === 1
          ? Response.json({ success: false, error: "http_500" }, { status: 500 })
          : impactOf(),
    })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(await within(dialog).findByText("삭제 영향을 확인하지 못했어요")).toBeInTheDocument()
    expect(within(dialog).queryByText(/함께 삭제/)).not.toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    await userEvent.click(deleteButton(dialog))
    expect(requestsOf(fetchSpy, "DELETE")).toEqual([])

    await userEvent.click(within(dialog).getByRole("button", { name: "다시 확인" }))
    expect(await within(dialog).findByText("함께 삭제되는 미팅은 없습니다.")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeEnabled()
  })

  it("모양이 어긋난 삭제 영향 응답도 읽지 못한 것이다(빠진 칸을 0으로 보지 않는다)", async () => {
    stubDeleteBff({ impact: () => Response.json({ success: true, impact: { deletable: true } }) })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(await within(dialog).findByText("삭제 영향을 확인하지 못했어요")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
  })

  it("미리보기 뒤 미팅이 확정돼 서버가 거부하면(409) 건수를 담아 안내하고 행은 그대로 둔다", async () => {
    stubDeleteBff({
      impact: () => impactOf({ closedMeetingCount: 1 }),
      remove: () =>
        Response.json(
          {
            success: false,
            error: "ORG_HAS_MEETINGS",
            message: "예정된 미팅이 1건 있어 삭제할 수 없습니다 — 미팅을 먼저 취소해 주세요",
            scheduledCount: 1,
            completedCount: 0,
          },
          { status: 409 },
        ),
    })
    render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    const blocker = "예정된 미팅이 1건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요."
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("'툰브릿지'을(를) 삭제하지 못했어요", {
        description: blocker,
      }),
    )
    // 다이얼로그도 낡은 "삭제 가능" 대신 지금의 막힘 상태를 보여 준다.
    expect(await within(dialog).findByText(blocker)).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    expect(listHas("툰브릿지")).toBe(true)
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it("완료 미팅 때문에 거부되면 그 이유를 말한다 — 예전의 '미팅을 먼저 정리해 주세요'는 쓰지 않는다", async () => {
    stubDeleteBff({
      impact: () => impactOf(),
      remove: () =>
        Response.json(
          { success: false, error: "ORG_HAS_MEETINGS", scheduledCount: 1, completedCount: 2 },
          { status: 409 },
        ),
    })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    const description = mockToastError.mock.calls[0][1].description as string
    expect(description).toContain("예정된 미팅이 1건 있습니다.")
    expect(description).toContain("완료된 미팅이 2건 있어 삭제할 수 없습니다")
    expect(description).not.toContain("미팅을 먼저 정리해 주세요")
    expect(listHas("툰브릿지")).toBe(true)
  })

  it("그 밖의 거부(409 ORG_DELETE_CONFLICT)는 서버가 준 이유를 그대로 알리고, 다시 시도할 수 있다", async () => {
    const message = "다른 작업과 겹쳐 삭제하지 못했습니다 — 아무것도 삭제되지 않았습니다. 잠시 후 다시 시도해 주세요"
    stubDeleteBff({
      impact: () => impactOf(),
      remove: () =>
        Response.json({ success: false, error: "ORG_DELETE_CONFLICT", message }, { status: 409 }),
    })
    render(<MembersTable members={members} />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("'툰브릿지'을(를) 삭제하지 못했어요", {
        description: message,
      }),
    )
    expect(listHas("툰브릿지")).toBe(true)
    await waitFor(() => expect(deleteButton(dialog)).toBeEnabled())
  })

  // ── 이 행사 명단에 없는 기업(구조화된 404 ORG_NOT_FOUND) — 행을 숨기지 않고 명단을 다시 읽는다 ──
  // 404만으로는 다른 운영자가 먼저 지웠는지, 다른 탭에서 행사가 바뀌어 요청이 다른 행사로 갔는지 모른다
  // (선택 행사는 쿠키다). 화면이 행을 숨기면 원래 행사에 멀쩡히 있는 기업이 사라져 보인다.

  const notFoundHint =
    "다른 운영자가 먼저 삭제했거나 다른 탭에서 행사를 바꿨을 수 있어요. 명단을 새로 불러왔어요."

  it("삭제가 '명단에 없음'(404 ORG_NOT_FOUND)이면 창을 닫고 명단을 다시 읽는다 — 행을 임의로 숨기지 않는다", async () => {
    stubDeleteBff({
      impact: () => impactOf(),
      remove: () =>
        Response.json(
          { success: false, error: "ORG_NOT_FOUND", message: "기업을 찾을 수 없습니다" },
          { status: 404 },
        ),
    })
    const { rerender } = render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(mockRefresh).toHaveBeenCalledTimes(1) // 실 세션은 명단을 서버에서 다시 읽는다
    expect(listHas("툰브릿지")).toBe(true) // 화면이 정하지 않는다 — 다시 읽은 명단이 정한다
    expect(mockToastInfo).toHaveBeenCalledTimes(1)
    expect(mockToastInfo).toHaveBeenCalledWith("'툰브릿지'을(를) 이 행사 명단에서 찾을 수 없어요", {
      description: notFoundHint,
    })
    // 삭제 완료도, 실패도 아니다.
    expect(mockToast).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()

    // 정말 지워졌다면 다시 읽은 명단에서 빠진다(서버가 정한 명단을 그대로 보여 준다).
    rerender(<MembersTable members={members.filter((m) => m.id !== "e3")} realSession />)
    expect(listHas("툰브릿지")).toBe(false)
    expect(listHas("한강게임즈")).toBe(true)
  })

  it("삭제의 평문 404(http_404 — 라우팅·배포 불일치 등)는 일반 실패다: 창을 두고 다시 시도하게 하고 행은 그대로", async () => {
    stubDeleteBff({
      impact: () => impactOf(),
      remove: () =>
        Response.json({ success: false, error: "http_404", message: "Not Found" }, { status: 404 }),
    })
    render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")
    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("'툰브릿지'을(를) 삭제하지 못했어요", {
        description: "삭제에 실패했어요. 잠시 후 다시 시도해 주세요.",
      }),
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await waitFor(() => expect(deleteButton(dialog)).toBeEnabled())
    expect(listHas("툰브릿지")).toBe(true)
    expect(mockRefresh).not.toHaveBeenCalled()
    expect(mockToastInfo).not.toHaveBeenCalled()
  })

  it("열어 보니 '명단에 없음'(미리보기 404 ORG_NOT_FOUND)이면 안내하고 삭제를 막고 명단을 다시 읽는다 — 행은 숨기지 않는다", async () => {
    const fetchSpy = stubDeleteBff({
      impact: () => Response.json({ success: false, error: "ORG_NOT_FOUND" }, { status: 404 }),
    })
    const { rerender } = render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(
      await within(dialog).findByText("이 행사 명단에서 찾을 수 없는 기업이에요"),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(notFoundHint)).toBeInTheDocument()
    // 일반 실패("확인하지 못했어요" + 다시 확인)와 다르다 — 다시 읽어도 소용없다.
    expect(within(dialog).queryByText("삭제 영향을 확인하지 못했어요")).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "다시 확인" })).not.toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
    expect(listHas("툰브릿지")).toBe(true)

    // 다시 읽은 명단이 내려와 다시 그려져도(새 함수가 내려온다) 또 다시 읽게 하지 않는다 — 한 번 알린다.
    rerender(<MembersTable members={[...members]} realSession />)
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(requestsOf(fetchSpy, "GET")).toEqual(["/api/organizer/members/e3/deletion-impact"])

    await userEvent.click(deleteButton(dialog))
    expect(requestsOf(fetchSpy, "DELETE")).toEqual([])

    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
    expect(listHas("툰브릿지")).toBe(true)
  })

  it("미리보기의 평문 404(http_404)는 일반 실패다 — 다시 확인할 수 있고 명단은 다시 읽지 않는다", async () => {
    let attempts = 0
    stubDeleteBff({
      impact: () =>
        ++attempts === 1
          ? Response.json({ success: false, error: "http_404" }, { status: 404 })
          : impactOf(),
    })
    render(<MembersTable members={members} realSession />)

    const dialog = await openDeleteDialog("툰브릿지")

    expect(await within(dialog).findByText("삭제 영향을 확인하지 못했어요")).toBeInTheDocument()
    expect(
      within(dialog).queryByText("이 행사 명단에서 찾을 수 없는 기업이에요"),
    ).not.toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    expect(mockRefresh).not.toHaveBeenCalled()
    expect(listHas("툰브릿지")).toBe(true)

    await userEvent.click(within(dialog).getByRole("button", { name: "다시 확인" }))
    expect(await within(dialog).findByText("함께 삭제되는 미팅은 없습니다.")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeEnabled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  // ── 창 재사용 — 다른 기업을 열면 그 기업의 삭제 영향만 새로 읽는다 ──

  const blockedTwice = "예정된 미팅이 2건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요."

  it("A를 열었다 닫고 B를 열면 B의 삭제 영향을 새로 읽어 B의 것만 보여 준다", async () => {
    const fetchSpy = stubDeleteBff({
      impact: (url) =>
        url.includes("/e3/")
          ? impactOf({ deletable: false, scheduledCount: 2 })
          : impactOf({ closedMeetingCount: 1 }),
    })
    render(<MembersTable members={members} />)

    const first = await openDeleteDialog("툰브릿지")
    expect(await within(first).findByText(blockedTwice)).toBeInTheDocument()
    await userEvent.click(within(first).getByRole("button", { name: "취소" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    const second = await openDeleteDialog("한강게임즈")
    expect(
      within(second).getByText("'한강게임즈'을(를) 이 행사 명단에서 삭제합니다."),
    ).toBeInTheDocument()
    expect(
      await within(second).findByText("취소·거절된 미팅 1건이 함께 삭제됩니다."),
    ).toBeInTheDocument()
    expect(within(second).queryByText(blockedTwice)).not.toBeInTheDocument()
    expect(deleteButton(second)).toBeEnabled()
    expect(requestsOf(fetchSpy, "GET")).toEqual([
      "/api/organizer/members/e3/deletion-impact",
      "/api/organizer/members/e2/deletion-impact",
    ])
  })

  it("늦게 도착한 A의 응답은 B의 창에 섞이지 않고, 명단이 다시 그려져도 B를 다시 읽지 않는다", async () => {
    let answerFirst!: (response: Response) => void
    const fetchSpy = stubDeleteBff({
      impact: (url) =>
        url.includes("/e3/")
          ? new Promise<Response>((resolve) => (answerFirst = resolve))
          : impactOf({ closedMeetingCount: 1 }),
    })
    const { rerender } = render(<MembersTable members={members} />)

    // A(툰브릿지)는 응답을 받기 전에 닫는다.
    const first = await openDeleteDialog("툰브릿지")
    expect(within(first).getByLabelText("삭제하면 함께 지워지는 것을 확인하는 중")).toBeInTheDocument()
    await userEvent.click(within(first).getByRole("button", { name: "취소" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    const second = await openDeleteDialog("한강게임즈")
    expect(
      await within(second).findByText("취소·거절된 미팅 1건이 함께 삭제됩니다."),
    ).toBeInTheDocument()

    // A의 응답(막힘)이 이제야 온다.
    await act(async () => {
      answerFirst(impactOf({ deletable: false, scheduledCount: 2 }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // 부모가 다시 그려진다(새 loadImpact 함수가 내려온다).
    rerender(<MembersTable members={[...members]} />)

    expect(within(second).getByText("취소·거절된 미팅 1건이 함께 삭제됩니다.")).toBeInTheDocument()
    expect(within(second).queryByText(blockedTwice)).not.toBeInTheDocument()
    expect(
      within(second).queryByLabelText("삭제하면 함께 지워지는 것을 확인하는 중"),
    ).not.toBeInTheDocument()
    expect(deleteButton(second)).toBeEnabled()
    expect(requestsOf(fetchSpy, "GET")).toEqual([
      "/api/organizer/members/e3/deletion-impact",
      "/api/organizer/members/e2/deletion-impact",
    ])
  })
})

describe("MembersTable — 내보내기", () => {
  // 내보내기는 엑셀 하나로 단순화했다(CSV 제거, 2026-09-10) — 드롭다운 없이 버튼 한 번.
  it("엑셀 내보내기 버튼을 제공한다", () => {
    render(<MembersTable members={members} />)
    expect(
      screen.getByRole("button", { name: /엑셀로 내보내기/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("menuitem", { name: "CSV로 내보내기" })
    ).not.toBeInTheDocument()
  })

  it("sub에게도 엑셀 내보내기 버튼을 보여준다(관할 바이어만 서버가 좁혀 내려준다)", () => {
    render(
      <MembersTable
        members={[]}
        permissionLevel="sub"
        tradeOffice="KOTRA 프랑크푸르트무역관"
      />
    )
    expect(
      screen.getByRole("button", { name: /엑셀로 내보내기/ })
    ).toBeInTheDocument()
  })

  it("실 세션에서 내보내기 요청이 실패하면(예: 403) 토스트로 알린다 — 조용히 실패하지 않는다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
    )
    render(<MembersTable members={members} realSession />)
    await userEvent.click(screen.getByRole("button", { name: /엑셀로 내보내기/ }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    vi.restoreAllMocks()
  })
})

describe("MembersTable — 페이지네이션", () => {
  it("10개 초과면 한 페이지에 10개만 보이고 페이지 표시가 나온다", () => {
    render(<MembersTable members={manyMembers} />)
    expect(bodyRows()).toHaveLength(10)
    expect(screen.getByText(/25개 기업/)).toBeInTheDocument()
    expect(screen.getByText(/1\/3 페이지/)).toBeInTheDocument()
    expect(screen.getByText("회사01")).toBeInTheDocument()
    expect(screen.queryByText("회사11")).not.toBeInTheDocument()
  })

  it("다음 페이지로 이동하면 다음 10개를 보여준다", async () => {
    render(<MembersTable members={manyMembers} />)
    await userEvent.click(screen.getByRole("link", { name: "Go to next page" }))
    expect(screen.getByText("회사11")).toBeInTheDocument()
    expect(screen.queryByText("회사01")).not.toBeInTheDocument()
    expect(screen.getByText(/2\/3 페이지/)).toBeInTheDocument()
  })

  it("필터를 바꾸면 1페이지로 돌아간다", async () => {
    render(<MembersTable members={manyMembers} />)
    await userEvent.click(screen.getByRole("link", { name: "3" }))
    expect(screen.getByText(/3\/3 페이지/)).toBeInTheDocument()
    await userEvent.type(screen.getByRole("searchbox"), "회사")
    await waitFor(() =>
      expect(screen.getByText(/1\/3 페이지/)).toBeInTheDocument()
    )
  })
})

// 명단 업로드는 /admin/organizations와 같은 공용 다이얼로그(components/roster)·같은 BFF·같은 FastAPI 핸들러를
// 쓴다 — 흐름 자체(미리보기·공통 비밀번호·행별 결과·적용)는 components/roster/roster-upload.test.tsx가 검증하고,
// 여기선 이 콘솔이 그 다이얼로그를 열어 운영자의 첫 행사(event_id 미지정)로 올리는지만 본다.
// (예전의 클라 로컬 CSV 병합 목업 경로는 서버 파서와 헤더 별칭이 어긋나 제거했다.)
describe("MembersTable — 명단 업로드(어드민 콘솔과 같은 공용 다이얼로그)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("공용 다이얼로그로 미리보기를 요청하고 서버 집계를 보여준다", async () => {
    const result = { added: 1, updated: 0, unchanged: 1, skipped: 0, changes: [], rows: [] }
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result }))
    vi.stubGlobal("fetch", fetchMock)
    render(<MembersTable members={members} realSession />)

    await userEvent.click(screen.getByRole("button", { name: "명단 업로드" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.upload(
      within(dialog).getByLabelText("명단 파일"),
      new File(["id,role,name_ko\r\nex-100,참가기업,새콘텐츠기업"], "roster.csv", { type: "text/csv" })
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "참가기업 명단" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "미리보기" }))

    await waitFor(() =>
      expect(within(dialog).getByText("신규 1 · 갱신 0 · 무변경 1 · 건너뜀 0")).toBeInTheDocument()
    )
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/organizer/members/roster")
    expect((init.body as FormData).get("dry_run")).toBe("true")
  })
})

describe("카테고리 필터 → 실 엑셀 요청", () => {
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
  afterEach(() => vi.restoreAllMocks())
  it("교차 필터의 전체 페이지 결과와 코드값을 서버에 전달한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 503 }))
    const rows = manyMembers.map((r) => ({ ...r, contentCategory: "broadcasting", businessFields: ["content_production", "animation_distribution"] }))
    render(<MembersTable members={rows} realSession />)
    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(3)
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "방송" }))
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("button", { name: "사업분야" }))
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(8)
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "콘텐츠 제작" }))
    await userEvent.keyboard("{Escape}")
    expect(bodyRows()).toHaveLength(10)
    await userEvent.click(screen.getByRole("button", { name: "엑셀로 내보내기" }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes("/export"))!
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body).toMatchObject({ tab: "exhibitor", content_categories: ["broadcasting"], business_fields: ["content_production"] })
    expect(body.ordered_ids).toHaveLength(25)
  })

  it("카테고리 수정 실패 시 목록 값을 바꾸지 않는다", async () => {
    // 대리작성 폼은 열 때 서버 프로필을 읽는다 — 읽기는 성공하고 저장(PATCH)만 실패한다.
    stubBff(
      {
        "e-category": registeredDetail("e-category", "exhibitor", {
          organization_name_ko: "합성",
          content_category: "broadcasting",
        }),
      },
      (url, init) => (init?.method === "PATCH" ? new Response("fail", { status: 500 }) : undefined)
    )
    render(<MembersTable members={[ex({ id: "e-category", name: "합성", contentCategory: "broadcasting" })]} realSession />)
    await userEvent.click(within(rowFor("합성")).getByRole("button", { name: "수정" }))
    await userEvent.click(await within(await screen.findByRole("dialog")).findByLabelText("카테고리"))
    await userEvent.click(screen.getByRole("option", { name: "애니메이션/캐릭터" }))
    await userEvent.click(screen.getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(within(screen.getByRole("table", { hidden: true })).getByText("방송")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
