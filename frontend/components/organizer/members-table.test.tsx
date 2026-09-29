// MembersTable이 useTranslations("help.hints")를 쓰게 되면서(HelpHint 툴팁) NextIntlClientProvider
// 컨텍스트가 필요해졌다 — render-with-intl로 교체(meeting-request-modal.test.tsx와 동일 패턴).
import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MembersTable } from "./members-table"
import type { MemberRow } from "@/lib/organizer/members"

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
}))

// 내보내기 실패 토스트 검증(sub 403 → 조용한 실패 금지)용 — 다른 기존 테스트는 토스트 텍스트를
// 검증하지 않으므로(비화면 사이드이펙트로만 확인) 전역 목업으로 바꿔도 안전하다. vi.mock 팩토리는
// 파일 상단으로 호이스팅되므로 참조할 mock은 vi.hoisted로 함께 끌어올린다.
const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: mockToastError, success: vi.fn() }),
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
})

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
  // 보이면 눌러서 403만 맞는다. "비활성화"는 로컬 상태만 바꾸는 액션이라 서버 호출이 없으므로 그대로 둔다.
  it("작업 메뉴에 비활성화는 있어도 삭제는 없다(master 전용 API)", async () => {
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
    expect(screen.getByRole("menuitem", { name: "비활성화" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "삭제" })).not.toBeInTheDocument()
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

  it("제출 B층 프로필(BM-005)을 그대로 보여준다", async () => {
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
    expect(
      screen.getByText("픽셀아츠 스튜디오 소개 테스트문")
    ).toBeInTheDocument()
    expect(screen.getByText("50억원 이상")).toBeInTheDocument()
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

describe("MembersTable — 정보 수정(노출 버튼)", () => {
  beforeEach(() => { vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}")) })
  afterEach(() => { vi.restoreAllMocks() })
  it("행의 수정 버튼으로 기업명을 고치면 목록에 반영된다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", { name: "수정" })
    )
    const nameInput = screen.getByLabelText("기업명(국문)")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "픽셀아츠 스튜디오(수정)")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))
    await waitFor(() =>
      expect(screen.getByText("픽셀아츠 스튜디오(수정)")).toBeInTheDocument()
    )
  })

  it("A층 정보(담당자·사업분야)를 수정할 수 있다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("툰브릿지")).getByRole("button", { name: "수정" })
    )
    const contactInput = screen.getByLabelText("담당자(참가자 성명)")
    await userEvent.clear(contactInput)
    await userEvent.type(contactInput, "신담당 과장")
    const categoryInput = screen.getByLabelText("사업분야")
    await userEvent.clear(categoryInput)
    await userEvent.type(categoryInput, "애니메이션 유통 및 배급")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))
    await waitFor(() => {
      expect(screen.getByText("신담당 과장")).toBeInTheDocument()
      expect(
        within(rowFor("툰브릿지")).getByText("애니메이션 유통 및 배급")
      ).toBeInTheDocument()
    })
  })

  // N2 회귀 — GET .../organizations(목록)는 businessRegNo/website/address를 안 내려주므로
  // MemberRow 자체엔 그 값이 없다. 저장은 PATCH로 서버에 잘 가지만(H1 이미 검증됨), 다이얼로그를
  // 다시 열면 명단 화면이 신청서 조회용으로 이미 갖고 있는 profiles(getMemberProfiles)에서 채워야
  // 빈칸으로 보이지 않는다.
  it("사업자등록번호·웹사이트·주소는 목록에 없어도 profiles에서 채워 프리필한다", async () => {
    const profiles = {
      e3: {
        categories: [],
        businessRegNo: "123-45-67890",
        website: "https://toonbridge.example",
        address: "서울특별시 마포구 양화로 45",
      },
    }
    render(<MembersTable members={members} profiles={profiles} />)
    await userEvent.click(
      within(rowFor("툰브릿지")).getByRole("button", { name: "수정" })
    )
    expect(screen.getByLabelText("사업자등록번호")).toHaveValue("123-45-67890")
    expect(screen.getByLabelText("웹사이트")).toHaveValue("https://toonbridge.example")
    expect(screen.getByLabelText("주소")).toHaveValue("서울특별시 마포구 양화로 45")
  })
})

describe("MembersTable — 정보 수정 서버 영속(H1 회귀)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("저장하면 실제로 PATCH .../profile 네트워크 요청이 나간다(참가사, 미신청→대리작성)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "org-toonbridge" }) } as unknown as Response)
    // 툰브릿지 = registered(미신청) → 대리작성(proxy) 모드여야 한다.
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("툰브릿지")).getByRole("button", { name: "수정" })
    )
    await userEvent.type(screen.getByLabelText("웹사이트"), "https://toonbridge.example")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("/api/organizer/members/e3/profile"),
      )
      expect(call).toBeDefined()
      const init = call![1] as RequestInit
      expect(init.method).toBe("PATCH")
      const body = JSON.parse(init.body as string)
      expect(body.role).toBe("exhibitor")
      expect(body.mode).toBe("proxy") // registered(미신청) → 대리작성
      expect(body.patch.website).toBe("https://toonbridge.example")
    })
  })

  it("이미 제출한 기업은 직접 수정(edit) 모드로 보낸다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "org-pixelarts" }) } as unknown as Response)
    // 픽셀아츠 스튜디오 = approved(제출 이력 있음) → 직접 수정(edit) 모드.
    render(<MembersTable members={members} />)
    await userEvent.click(
      within(rowFor("픽셀아츠 스튜디오")).getByRole("button", { name: "수정" })
    )
    await userEvent.type(screen.getByLabelText("웹사이트"), "https://pixelarts.example")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("/api/organizer/members/e1/profile"),
      )
      expect(call).toBeDefined()
      const body = JSON.parse((call![1] as RequestInit).body as string)
      expect(body.mode).toBe("edit")
    })
  })

  it("보낼 안전 필드가 하나도 없으면 프로필 PATCH를 생략한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response)
    const bare: MemberRow[] = [
      ex({
        id: "e-bare",
        name: "빈값기업",
        primaryContact: null,
        contactEmail: null,
        contactPhone: null,
      }),
    ]
    render(<MembersTable members={bare} />)
    await userEvent.click(
      within(rowFor("빈값기업")).getByRole("button", { name: "수정" })
    )
    // 매핑 대상 필드(웹사이트·담당자·이메일 등)는 전부 비워두고, 매핑 대상이 아닌 필드(HS코드)만 채운다.
    await userEvent.type(screen.getByLabelText("HS코드/품목설명"), "9503.00")
    await userEvent.click(screen.getByRole("button", { name: "저장" }))
    await waitFor(() => expect(screen.getByText("빈값기업")).toBeInTheDocument())
    expect(
      fetchSpy.mock.calls.some(([url]) => String(url).includes("/profile")),
    ).toBe(false)
  })
})

describe("MembersTable — 비활성화", () => {
  it("비활성화하면 목록에서 사라진다", async () => {
    render(<MembersTable members={members} />)
    await userEvent.click(
      screen.getByRole("button", { name: "한강게임즈 작업" })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: "비활성화" }))
    await waitFor(() =>
      expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument()
    )
  })
})

describe("MembersTable — 삭제", () => {
  afterEach(() => vi.restoreAllMocks())

  it("서버 삭제 성공 시 목록에서 제거한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "org-toonbridge" }),
    } as unknown as Response)
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "툰브릿지 작업" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))
    await waitFor(() =>
      expect(screen.queryByText("툰브릿지")).not.toBeInTheDocument()
    )
  })

  it("서버 삭제 실패(409 미팅 보유) 시 목록에 그대로 남긴다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "ORG_HAS_MEETINGS" }),
    } as unknown as Response)
    render(<MembersTable members={members} />)
    await userEvent.click(screen.getByRole("button", { name: "툰브릿지 작업" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))
    // 서버가 거부하면 낙관적으로 지우지 않는다 — "삭제된 척" 오해 방지.
    await waitFor(() =>
      expect(screen.getByText("툰브릿지")).toBeInTheDocument()
    )
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 500 }))
    render(<MembersTable members={[ex({ id: "e-category", name: "합성", contentCategory: "broadcasting" })]} realSession />)
    await userEvent.click(within(rowFor("합성")).getByRole("button", { name: "수정" }))
    await userEvent.click(within(screen.getByRole("dialog")).getByLabelText("카테고리"))
    await userEvent.click(screen.getByRole("option", { name: "애니메이션/캐릭터" }))
    await userEvent.click(screen.getByRole("button", { name: "저장" }))
    expect(within(screen.getByRole("table", { hidden: true })).getByText("방송")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
