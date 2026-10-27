import { act, fireEvent, render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { LoginFlow } from "./login-flow"
import { httpAuthClient } from "@/lib/auth/http-auth-client"
import { LoginRequestError } from "@/lib/auth/login-errors"
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

// ── 요청 실패 ───────────────────────────────────────────────────────────────────
// 2026-10-02 부하 테스트: 백엔드가 몰림으로 500을 내자 startLogin이 예외로 끝났고, 화면이 그걸 받지 않아 버튼이
// 계속 도는 채로 멈췄다. 이제 실패 종류별로 안내하고 폼을 풀어 바로 다시 시도할 수 있게 한다. 몰림 거절
// (503 login_busy·server_busy)은 화면이 먼저 무작위 간격으로 자동 재시도한다(lib/auth/login-retry) — 아래 가짜 타이머 블록.
const BUSY = "로그인 요청이 많아요. 잠시 후 다시 시도해 주세요."
const UNAVAILABLE = "잠시 후 다시 시도해주세요. 인증 서버가 일시적으로 응답하지 않습니다."
const WAITING = "접속자가 많아 잠시 기다리는 중이에요…"

async function submitCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("아이디"), "buyer")
  await user.type(screen.getByLabelText("비밀번호"), "pw")
  await user.click(screen.getByRole("button", { name: "로그인" }))
}

const busyError = (code = "login_busy", path = "/api/auth/login/start") => new LoginRequestError(path, 503, code)

describe("LoginFlow — 요청 실패(재시도하지 않는 오류)", () => {
  it("몰림을 밝히지 않은 5xx(평문 500을 BFF가 바꾼 오류·백엔드 연결 실패 502)는 인증 서버 일시 장애 안내", async () => {
    const user = userEvent.setup()
    let status = 500
    const client = fakeClient(() => {
      throw new LoginRequestError("/api/auth/login/start", status, status === 500 ? "upstream_error" : "upstream_unavailable")
    })
    render(<LoginFlow token={null} client={client} />)

    await submitCredentials(user)
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE)

    status = 502
    await user.click(screen.getByRole("button", { name: "로그인" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE))
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
  })

  it("응답을 못 받은 네트워크 오류는 인증 서버 일시 장애 안내", async () => {
    const user = userEvent.setup()
    const client = fakeClient(() => {
      throw new TypeError("Failed to fetch")
    })
    render(<LoginFlow token={null} client={client} />)

    await submitCredentials(user)

    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE)
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
  })

  it("약관 동의(complete)가 실패하면 자격 폼으로 되돌리고 같은 안내를 띄운다", async () => {
    const user = userEvent.setup()
    const client = fakeClient(startBuyerFirst, () => {
      throw busyError("login_busy", "/api/auth/login/complete")
    })
    render(<LoginFlow token={null} client={client} />)

    await submitCredentials(user)
    const proceed = await screen.findByRole("button", { name: "동의하고 시작하기" })
    await user.click(screen.getByRole("button", { name: "이용약관 동의" }))
    await user.click(screen.getByRole("button", { name: "개인정보 동의" }))
    await user.click(proceed)

    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY)
    expect(screen.getByLabelText("아이디")).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe("LoginFlow — 몰림 자동 재시도(가짜 타이머)", () => {
  // ⚠ 이 블록은 user-event·findBy·waitFor를 쓰지 않는다 — RTL의 비동기 래퍼가 setTimeout(0)을 기다리는데, vitest
  // 가짜 타이머에선 그 타이머가 저절로 흐르지 않아(RTL은 jest 전역이 있을 때만 대신 넘긴다) 테스트가 멈춘다.
  // 그래서 fireEvent(동기·act 포함)로 입력하고, 시간은 vi.advanceTimersByTimeAsync로만 넘겨 결과를 동기 조회한다 —
  // 실제 시간이 흘러도 결과가 바뀌지 않는 결정적 테스트다.
  // Math.random을 0으로 고정 — 대기가 1000 → 1120 → 1254 → 1405ms로 정해져 한 단계씩 넘길 수 있다(범위 자체는
  // lib/auth/login-retry.test.ts가 잠근다). 끝까지 넘길 땐 최악 합계(약 20초)보다 넉넉히 30초를 넘긴다.
  let randomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
  })

  afterEach(() => {
    randomSpy.mockRestore()
    vi.useRealTimers()
  })

  // 가짜 시간을 ms만큼 넘기고, 그사이 풀린 약속(요청 응답·재시도)과 화면 갱신을 act 안에서 끝까지 처리한다.
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  async function typeAndSubmit(username = "buyer", password = "pw") {
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: username } })
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: password } })
    fireEvent.click(screen.getByRole("button", { name: "로그인" }))
    await advance(0) // 첫 요청의 응답(가짜 클라이언트는 즉시)까지 처리
  }

  async function agreeAndProceed() {
    fireEvent.click(screen.getByRole("button", { name: "이용약관 동의" }))
    fireEvent.click(screen.getByRole("button", { name: "개인정보 동의" }))
    fireEvent.click(screen.getByRole("button", { name: "동의하고 시작하기" }))
    await advance(0)
  }

  // 처음 n번은 거절(error)하고 그다음부터 startBuyerFirst로 답하는 시작 단계 — 몇 번 불렸는지 센다.
  function startFailingTimes(n: number, error: () => Error = () => busyError()) {
    const calls = { count: 0 }
    const start = (input: StartLoginInput): StartLoginResult => {
      calls.count += 1
      if (calls.count <= n) throw error()
      return startBuyerFirst(input)
    }
    return { calls, start }
  }

  it("busy → busy → 성공: 기다리는 동안 상태 문구·잠긴 버튼, 오류는 한 번도 안 보이고 약관 단계로 이어진다", async () => {
    const { calls, start } = startFailingTimes(2)
    render(<LoginFlow token={null} client={fakeClient(start)} />)

    await typeAndSubmit()

    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
    expect(screen.getByRole("button", { name: "로그인" })).toBeDisabled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(calls.count).toBe(1)

    await advance(999)
    expect(calls.count).toBe(1) // 첫 대기(1000ms)가 끝나기 전엔 다시 보내지 않는다
    await advance(1) // 첫 대기 끝 → 두 번째 시도(또 busy)
    expect(calls.count).toBe(2)
    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
    expect(screen.getByRole("button", { name: "로그인" })).toBeDisabled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    await advance(1120) // 두 번째 대기 끝 → 세 번째 시도(성공)
    expect(calls.count).toBe(3)
    expect(screen.getByRole("button", { name: "동의하고 시작하기" })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })

  it("5번 모두 busy면(재시도 4번 소진) '로그인 요청이 많아요'를 띄우고 버튼을 푼다", async () => {
    const { calls, start } = startFailingTimes(Number.POSITIVE_INFINITY)
    render(<LoginFlow token={null} client={fakeClient(start)} />)

    await typeAndSubmit()
    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
    await advance(30_000)

    expect(calls.count).toBe(5)
    expect(screen.getByRole("alert")).toHaveTextContent(BUSY)
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
    expect(mockPush).not.toHaveBeenCalled()

    // 더 넘겨도 혼자 다시 보내지 않는다 — 다음 시도는 사용자가 누를 때.
    await advance(30_000)
    expect(calls.count).toBe(5)
  })

  it("server_busy도 같은 몰림으로 보고 재시도한 뒤 안내한다", async () => {
    const { calls, start } = startFailingTimes(Number.POSITIVE_INFINITY, () => busyError("server_busy"))
    render(<LoginFlow token={null} client={fakeClient(start)} />)

    await typeAndSubmit()
    await advance(30_000)

    expect(calls.count).toBe(5)
    expect(screen.getByRole("alert")).toHaveTextContent(BUSY)
  })

  it("아이디/비번 거부는 다시 보내지 않는다(1번, 대기 문구 없이 바로 안내)", async () => {
    let calls = 0
    const client = fakeClient(() => {
      calls += 1
      return { outcome: "rejected", reason: "invalid_credentials" }
    })
    render(<LoginFlow token={null} client={client} />)

    await typeAndSubmit()

    expect(screen.getByRole("alert")).toHaveTextContent("아이디 또는 비밀번호가 올바르지 않습니다")
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
    await advance(30_000)
    expect(calls).toBe(1)
  })

  it("일반 5xx·코드 없는 503은 다시 보내지 않는다", async () => {
    for (const [failure, message] of [
      [new LoginRequestError("/api/auth/login/start", 500, "upstream_error"), UNAVAILABLE],
      [new LoginRequestError("/api/auth/login/start", 503, null), BUSY],
    ] as const) {
      let calls = 0
      const client = fakeClient(() => {
        calls += 1
        throw failure
      })
      const { unmount } = render(<LoginFlow token={null} client={client} />)

      await typeAndSubmit()
      expect(screen.getByRole("alert")).toHaveTextContent(message)
      expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
      await advance(30_000)
      expect(calls).toBe(1)
      unmount()
    }
  })

  it("약관 동의(complete)의 몰림 거절은 자동 재시도하지 않는다(티켓이 일회성이라 같은 요청을 다시 보낼 수 없다)", async () => {
    let completeCalls = 0
    const client = fakeClient(startBuyerFirst, () => {
      completeCalls += 1
      throw busyError("login_busy", "/api/auth/login/complete")
    })
    render(<LoginFlow token={null} client={client} />)

    await typeAndSubmit()
    await agreeAndProceed()

    expect(screen.getByRole("alert")).toHaveTextContent(BUSY)
    expect(screen.getByLabelText("아이디")).toBeInTheDocument()
    await advance(30_000)
    expect(completeCalls).toBe(1)
  })

  it("기다리는 중에 입력을 고치면 재시도를 그만두고 버튼을 푼다(오류 문구 없이)", async () => {
    const { calls, start } = startFailingTimes(Number.POSITIVE_INFINITY)
    render(<LoginFlow token={null} client={fakeClient(start)} />)

    await typeAndSubmit()
    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw2" } })
    await advance(0)

    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
    await advance(30_000)
    expect(calls.count).toBe(1)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    // 고친 값으로 다시 누르면 새 시도가 처음부터 시작된다(대기 문구도 다시).
    fireEvent.click(screen.getByRole("button", { name: "로그인" }))
    await advance(0)
    expect(calls.count).toBe(2)
    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
  })

  it("요청이 오가는 중에 입력을 고치면 그 응답은 버린다(옛 입력의 결과로 넘어가지 않는다)", async () => {
    let calls = 0
    let respond: (result: StartLoginResult) => void = () => {}
    const client: AuthClient = {
      ...fakeClient(startBuyerFirst),
      startLogin() {
        calls += 1
        return new Promise<StartLoginResult>((resolve) => {
          respond = resolve
        })
      },
    }
    render(<LoginFlow token={null} client={client} />)

    await typeAndSubmit()
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "buyer2" } })
    await act(async () => {
      respond({ outcome: "consent_required", loginTicket: "ticket-stale", documents: DOCS })
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(calls).toBe(1)
    expect(screen.queryByRole("button", { name: "동의하고 시작하기" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("아이디")).toHaveValue("buyer2")
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
  })

  it("화면을 떠나면(언마운트) 더 보내지 않는다", async () => {
    const { calls, start } = startFailingTimes(Number.POSITIVE_INFINITY)
    const { unmount } = render(<LoginFlow token={null} client={fakeClient(start)} />)

    await typeAndSubmit()
    expect(screen.getByRole("status")).toHaveTextContent(WAITING)
    unmount()
    await advance(30_000)

    expect(calls.count).toBe(1)
  })

  describe("실 http 어댑터 + BFF 응답", () => {
    // fetch 응답은 Response 대신 http 어댑터가 읽는 필드만 가진 객체로 준다(change-password-client.test와 같은 방식) —
    // Response 본문 스트림 읽기는 가짜 타이머 아래에서 타이밍이 흔들릴 수 있다.
    const fetchMock = vi.fn()
    const busyResponse = () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: { code: "login_busy", message: BUSY } }),
    })

    beforeEach(() => {
      fetchMock.mockReset()
      vi.stubGlobal("fetch", fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("BFF가 503 login_busy를 한 번 주고 다음에 결과를 주면 오류 없이 약관 단계로 이어진다", async () => {
      fetchMock.mockResolvedValueOnce(busyResponse()).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ outcome: "consent_required", login_ticket: "ticket-1", documents: DOCS }),
      })
      render(<LoginFlow token={null} client={httpAuthClient} />)

      await typeAndSubmit()
      expect(screen.getByRole("status")).toHaveTextContent(WAITING)
      await advance(1000)

      expect(screen.getByRole("button", { name: "동의하고 시작하기" })).toBeInTheDocument()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/login/start", expect.objectContaining({ method: "POST" }))
    })

    it("BFF가 계속 503 login_busy면 재시도 4번 뒤 '로그인 요청이 많아요'가 뜬다", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(busyResponse()))
      render(<LoginFlow token={null} client={httpAuthClient} />)

      await typeAndSubmit()
      await advance(30_000)

      expect(screen.getByRole("alert")).toHaveTextContent(BUSY)
      expect(fetchMock).toHaveBeenCalledTimes(5)
    })

    // 그만둔 로그인 시도는 결과만 버려서는 부족하다 — 요청이 살아 있으면 뒤늦게 도착한 응답의 Set-Cookie가 그만둔
    // 계정의 세션을 브라우저에 심는다. 그래서 그만두는 순간 요청 자체(fetch)를 끊는다.
    describe("그만두면 요청 자체를 끊는다", () => {
      // 실제 fetch처럼: 응답 없이 매달려 있다가 signal이 끊기면 그 사유(AbortError)로 거절한다.
      const hangUntilAborted = (_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      const signalOfCall = (nth: number) => (fetchMock.mock.calls[nth - 1][1] as RequestInit).signal as AbortSignal

      it("첫 요청이 오가는 중에 입력을 고치면 요청이 끊긴다 — 오류 문구도 이동도 없이 폼이 풀린다", async () => {
        fetchMock.mockImplementation(hangUntilAborted)
        render(<LoginFlow token={null} client={httpAuthClient} />)

        await typeAndSubmit()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(signalOfCall(1).aborted).toBe(false)
        expect(screen.getByRole("button", { name: "로그인" })).toBeDisabled()

        fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "pw2" } })
        await advance(0)

        expect(signalOfCall(1).aborted).toBe(true)
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
        expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
        expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled()
        expect(mockPush).not.toHaveBeenCalled()

        // 끊긴 요청을 혼자 다시 보내지 않고, 뒤늦게 오류 문구가 뜨지도 않는다.
        await advance(30_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      })

      it("고친 값으로 다시 누르면 끊기지 않은 새 signal로 새 요청이 나가고 그 결과로 이어진다", async () => {
        fetchMock.mockImplementationOnce(hangUntilAborted).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ outcome: "consent_required", login_ticket: "ticket-2", documents: DOCS }),
        })
        render(<LoginFlow token={null} client={httpAuthClient} />)

        await typeAndSubmit()
        fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "buyer2" } })
        await advance(0)
        fireEvent.click(screen.getByRole("button", { name: "로그인" }))
        await advance(0)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(signalOfCall(1).aborted).toBe(true)
        expect(signalOfCall(2).aborted).toBe(false)
        expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).username).toBe("buyer2")
        expect(screen.getByRole("button", { name: "동의하고 시작하기" })).toBeInTheDocument()
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      })

      it("화면을 떠나면(언마운트) 진행 중인 요청이 끊긴다", async () => {
        fetchMock.mockImplementation(hangUntilAborted)
        const { unmount } = render(<LoginFlow token={null} client={httpAuthClient} />)

        await typeAndSubmit()
        expect(signalOfCall(1).aborted).toBe(false)
        unmount()

        expect(signalOfCall(1).aborted).toBe(true)
        await advance(30_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(mockPush).not.toHaveBeenCalled()
      })
    })
  })
})
