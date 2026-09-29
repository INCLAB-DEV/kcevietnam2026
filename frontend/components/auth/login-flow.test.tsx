import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { LoginFlow } from "./login-flow"
import type {
  AuthClient,
  CompleteLoginInput,
  CompleteLoginResult,
  LoginGate,
  StartLoginInput,
  StartLoginResult,
} from "@/lib/auth/auth-types"

const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

const DOCS = [
  { id: "tos", title: "이용약관", summary: "s", version: "v1", required: true, content: "이용약관 전문" },
  { id: "privacy", title: "개인정보", summary: "s", version: "v1", required: true, content: "개인정보 전문" },
  { id: "marketing", title: "마케팅", summary: "s", version: "v1", required: false, content: "마케팅 전문" },
]

// 필수 약관(tos·privacy)이 모두 들어오면 세션 발급 성공, 아니면 미충족. 시나리오별로 결과 역할/게이트를 갈아끼운다.
function completeAs(role: "buyer" | "exhibitor", gate: LoginGate) {
  return (input: CompleteLoginInput): CompleteLoginResult => {
    const required = DOCS.filter((d) => d.required).map((d) => d.id)
    const missing = required.filter((id) => !input.acceptedDocIds.includes(id))
    return missing.length === 0
      ? { outcome: "succeeded", role, gate }
      : { outcome: "consent_incomplete", missingRequired: missing }
  }
}

// start/complete를 시나리오별로 갈아끼우는 fake 인증 경계.
function fakeClient(
  start: (input: StartLoginInput) => StartLoginResult,
  complete: (input: CompleteLoginInput) => CompleteLoginResult = completeAs("buyer", {
    applicationStatus: "registered",
    hasProfile: false,
  }),
): AuthClient {
  return {
    async checkDeeplinkToken(token) {
      if (token === "expired") return { status: "expired" }
      if (token === "invalid") return { status: "invalid" }
      return { status: "valid", username: "buyer", name: "김바이어" }
    },
    async startLogin(input) {
      return start(input)
    },
    async completeLogin(input) {
      return complete(input)
    },
  }
}

// 최초 진입(기업정보 미입력) 바이어 → 약관 단계로(consent_required). 그 외 자격은 거부.
const startBuyerFirst = (input: StartLoginInput): StartLoginResult =>
  input.username === "buyer" && input.password === "pw"
    ? { outcome: "consent_required", loginTicket: "ticket-buyer-1", documents: DOCS }
    : { outcome: "rejected", reason: "invalid_credentials" }

beforeEach(() => {
  mockPush.mockClear()
})

describe("LoginFlow — 딥링크 토큰", () => {
  it("만료된 딥링크로 진입하면 폼 대신 안내 화면을 보여준다", async () => {
    render(<LoginFlow token="expired" client={fakeClient(startBuyerFirst)} />)
    expect(await screen.findByText("링크가 만료되었어요")).toBeInTheDocument()
    expect(screen.queryByLabelText("아이디")).not.toBeInTheDocument()
  })

  it("위조 딥링크도 안내 화면으로 막는다", async () => {
    render(<LoginFlow token="invalid" client={fakeClient(startBuyerFirst)} />)
    expect(await screen.findByText("유효하지 않은 링크예요")).toBeInTheDocument()
  })

  it("만료·무효 안내 화면에는 일반 로그인으로 빠져나갈 '아이디/비밀번호로 로그인하기' 링크가 있다", async () => {
    render(<LoginFlow token="expired" client={fakeClient(startBuyerFirst)} />)
    await screen.findByText("링크가 만료되었어요")
    expect(screen.getByRole("link", { name: "아이디/비밀번호로 로그인하기" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("유효 토큰이면 토큰이 준 아이디를 프리필하고 회원 이름으로 안내한다", async () => {
    render(<LoginFlow token="good-token" client={fakeClient(startBuyerFirst)} />)
    expect(await screen.findByLabelText("아이디")).toHaveValue("buyer")
    // 비밀번호는 비워둔다 — 사용자가 입력. 안내 문구에 회원 이름이 들어간다.
    expect(screen.getByLabelText("비밀번호")).toHaveValue("")
    expect(screen.getByText("김바이어님, 비밀번호를 입력해 계속하세요.")).toBeInTheDocument()
  })

  it("토큰이 없으면(운영사/복귀) 아이디는 빈 폼으로 노출한다", async () => {
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)
    expect(await screen.findByLabelText("아이디")).toHaveValue("")
  })

  it("프리필된 딥링크 폼은 비밀번호만 입력해 검증을 통과한다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token="good-token" client={fakeClient(startBuyerFirst)} />)
    await screen.findByLabelText("아이디")
    // 아이디(buyer)는 그대로 두고 비번만 입력 → 검증 통과(최초자라 약관 스텝 등장).
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))
    expect(await screen.findByRole("button", { name: "동의하고 시작하기" })).toBeInTheDocument()
  })
})

describe("LoginFlow — 재방문 세션(계정 선택)", () => {
  const buyerSession = {
    role: "buyer" as const,
    name: "김바이어",
    gate: { applicationStatus: "submitted" as const, hasProfile: true },
  }
  const organizerSession = {
    role: "organizer" as const,
    name: "정세훈",
    gate: { applicationStatus: "submitted" as const, hasProfile: true },
    permissionLevel: "master" as const,
  }

  it("유효 딥링크 + 기존 세션이면 폼 대신 계정 선택 화면을 보여준다", async () => {
    render(
      <LoginFlow token="good" existingSessions={[buyerSession]} client={fakeClient(startBuyerFirst)} />
    )
    expect(await screen.findByText("최근 로그인한 이력이 있어요.")).toBeInTheDocument()
    expect(screen.queryByLabelText("아이디")).not.toBeInTheDocument()
  })

  it("계정을 고르면 비번 없이 곧바로 분기한다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} existingSessions={[buyerSession]} client={fakeClient(startBuyerFirst)} />)
    await user.click(await screen.findByRole("button", { name: /김바이어님/ }))
    // 재방문 세션 gate(submitted)가 ?status로 실린다 — /welcome이 검토 대기 화면을 보게.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/welcome?as=buyer&status=submitted"))
  })

  it("계정이 여러 개면 목록으로 보여주고 고른 계정으로 분기한다", async () => {
    const user = userEvent.setup()
    render(
      <LoginFlow
        token={null}
        existingSessions={[buyerSession, organizerSession]}
        client={fakeClient(startBuyerFirst)}
      />
    )
    expect(await screen.findByRole("button", { name: /김바이어님/ })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /정세훈님/ }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin?as=organizer"))
  })

  it("'다른 계정으로 로그인'을 누르면 자격 폼으로 전환된다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} existingSessions={[buyerSession]} client={fakeClient(startBuyerFirst)} />)
    await user.click(await screen.findByRole("button", { name: "다른 계정으로 로그인" }))
    expect(screen.getByLabelText("아이디")).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe("LoginFlow — 자격 분실 복구", () => {
  it("자격 폼에 사무국 문의 링크를 제공한다", async () => {
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)
    const link = await screen.findByRole("link", { name: "로그인이 안 되나요? 사무국에 문의" })
    expect(link).toHaveAttribute("href", "mailto:kcevietnam2026@gmail.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("딥링크 프리필 폼에서는 비밀번호 찾기 링크로 문구가 바뀐다", async () => {
    render(<LoginFlow token="good" client={fakeClient(startBuyerFirst)} />)
    expect(await screen.findByRole("link", { name: "비밀번호를 잊으셨나요? 사무국에 문의" })).toHaveAttribute(
      "href",
      "mailto:kcevietnam2026@gmail.com"
    )
  })
})

describe("LoginFlow — 자격 검증", () => {
  it("아이디/비번이 틀리면 명확한 에러 메시지를 보여준다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)
    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "wrong")
    await user.click(screen.getByRole("button", { name: "로그인" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("아이디 또는 비밀번호가 올바르지 않습니다")
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("비밀번호는 기본적으로 가려져 있고, 토글 버튼으로 보기/숨기기를 전환한다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)
    const pw = screen.getByLabelText("비밀번호") as HTMLInputElement
    await user.type(pw, "demo1234")
    // 실제 값은 그대로 유지되고, 네이티브 password 타입으로 가려진다.
    expect(pw.value).toBe("demo1234")
    expect(pw.type).toBe("password")

    await user.click(screen.getByRole("button", { name: "비밀번호 표시" }))
    expect(pw.type).toBe("text")

    await user.click(screen.getByRole("button", { name: "비밀번호 숨기기" }))
    expect(pw.type).toBe("password")
  })

  it("명단에 없는 계정(not_found)은 주최측 문의 안내를 보여준다", async () => {
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "ghost" && input.password === "pw"
        ? { outcome: "not_found" }
        : { outcome: "rejected", reason: "invalid_credentials" }
    )
    render(<LoginFlow token={null} client={client} />)
    await user.type(screen.getByLabelText("아이디"), "ghost")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("명단에서 계정을 찾을 수 없습니다")
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe("LoginFlow — 약관 게이트 (최초 진입자)", () => {
  it("필수 약관 미동의 시 진행 버튼이 비활성, 모두 동의하면 분기한다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    // 약관 스텝 등장 — 필수 미동의라 진행 불가.
    const proceed = await screen.findByRole("button", { name: "동의하고 시작하기" })
    expect(proceed).toBeDisabled()

    // 필수만 동의해도 진행 가능해야 한다(선택 무관).
    await user.click(screen.getByRole("button", { name: "이용약관 동의" }))
    expect(proceed).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "개인정보 동의" }))
    expect(proceed).toBeEnabled()

    // 최초 진입자 → 약관 후 입장 전 랜딩(/welcome)으로 분기(거기서 작성 동선 안내). gate(registered) → ?status.
    await user.click(proceed)
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/welcome?as=buyer&status=registered"))
  })

  it("'전문 보기'로 약관 전문을 바텀시트에서 확인할 수 있다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))
    await screen.findByRole("button", { name: "동의하고 시작하기" })

    // 전문은 처음엔 숨겨져 있다 — '전문 보기'를 눌러야 노출된다(읽기/동의 분리).
    expect(screen.queryByText("이용약관 전문")).not.toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: /전문 보기/ })[0])
    expect(await screen.findByText("이용약관 전문")).toBeInTheDocument()
  })

  it("전문 시트에서 '동의합니다'를 누르면 시트가 닫히고 해당 약관이 동의 체크된다", async () => {
    const user = userEvent.setup()
    render(<LoginFlow token={null} client={fakeClient(startBuyerFirst)} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))
    await screen.findByRole("button", { name: "동의하고 시작하기" })

    // 아직 미동의.
    expect(screen.getByRole("button", { name: "이용약관 동의" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )

    // 전문 열고 '동의합니다' → 시트 닫힘 + 해당 약관 동의 체크.
    await user.click(screen.getAllByRole("button", { name: /전문 보기/ })[0])
    await user.click(await screen.findByRole("button", { name: "동의합니다" }))
    await waitFor(() => expect(screen.queryByText("이용약관 전문")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "이용약관 동의" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("티켓이 무효(ticket_invalid)면 에러를 보여주고 자격 폼으로 되돌린다", async () => {
    const user = userEvent.setup()
    const client = fakeClient(startBuyerFirst, () => ({ outcome: "ticket_invalid", reason: "expired" }))
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    const proceed = await screen.findByRole("button", { name: "동의하고 시작하기" })
    await user.click(screen.getByRole("button", { name: "이용약관 동의" }))
    await user.click(screen.getByRole("button", { name: "개인정보 동의" }))
    await user.click(proceed)

    // 티켓 무효 → 자격 폼으로 복귀 + 안내. 분기는 일어나지 않는다.
    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 세션이 만료되었습니다")
    expect(screen.getByLabelText("아이디")).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe("LoginFlow — 도착 분기", () => {
  it("슈퍼 어드민은 /admin으로 분기한다", async () => {
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "super-admin" && input.password === "pw"
        ? {
            outcome: "succeeded",
            role: "organizer",
            permissionLevel: "master",
            gate: { applicationStatus: "submitted", hasProfile: true },
          }
        : { outcome: "rejected", reason: "invalid_credentials" },
    )
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "super-admin")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin?as=organizer"))
  })

  it("일반 어드민은 /organizer로 분기한다", async () => {
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "admin" && input.password === "pw"
        ? {
            outcome: "succeeded",
            role: "organizer",
            permissionLevel: "sub",
            gate: { applicationStatus: "submitted", hasProfile: true },
          }
        : { outcome: "rejected", reason: "invalid_credentials" },
    )
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "admin")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/organizer?as=organizer-sub"))
  })

  it("재방문 슈퍼 어드민은 약관 스텝 없이 곧바로 /admin으로 분기한다", async () => {
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "op" && input.password === "pw"
        ? { outcome: "succeeded", role: "organizer", permissionLevel: "master", gate: { applicationStatus: "submitted", hasProfile: true } }
        : { outcome: "rejected", reason: "invalid_credentials" }
    )
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "op")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin?as=organizer"))
    expect(screen.queryByRole("button", { name: "동의하고 시작하기" })).not.toBeInTheDocument()
  })

  it("재방문 + 제출 완료 바이어는 약관 없이 입장 전 랜딩(/welcome)으로 분기한다", async () => {
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "buyer" && input.password === "pw"
        ? { outcome: "succeeded", role: "buyer", gate: { applicationStatus: "submitted", hasProfile: true } }
        : { outcome: "rejected", reason: "invalid_credentials" }
    )
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/welcome?as=buyer&status=submitted"))
    expect(screen.queryByRole("button", { name: "동의하고 시작하기" })).not.toBeInTheDocument()
  })

  it("재방문 + 미제출(registered) 바이어도 자격과 무관하게 /welcome으로 분기한다", async () => {
    // 도착 분기는 더 이상 application_status를 보지 않는다 — 입장 전 화면 선택은 /welcome 책임(FE ADR-0002).
    const user = userEvent.setup()
    const client = fakeClient((input) =>
      input.username === "buyer" && input.password === "pw"
        ? { outcome: "succeeded", role: "buyer", gate: { applicationStatus: "registered", hasProfile: false } }
        : { outcome: "rejected", reason: "invalid_credentials" }
    )
    render(<LoginFlow token={null} client={client} />)

    await user.type(screen.getByLabelText("아이디"), "buyer")
    await user.type(screen.getByLabelText("비밀번호"), "pw")
    await user.click(screen.getByRole("button", { name: "로그인" }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/welcome?as=buyer&status=registered"))
  })
})
