import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import { render as rtlRender } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { SignupForm, SignupFormSchema, type SignupFormValues } from "./signup-form"
import type { SignupClient, SignupInput, SignupResult } from "@/lib/auth/signup-client"
import enMessages from "@/messages/en.json"

const VALID: SignupFormValues = {
  role: "buyer",
  orgNameKo: "한화에어로스페이스",
  orgNameEn: "",
  name: "김바이어",
  email: "buyer@example.com",
  password: "password1",
  passwordConfirm: "password1",
  phone: "",
  termsAgreed: true,
}

describe("SignupFormSchema (검증 정본)", () => {
  it("모든 필드가 유효하면 통과한다", () => {
    expect(SignupFormSchema.safeParse(VALID).success).toBe(true)
  })

  it("role은 buyer|exhibitor만 허용 — 미선택('')은 거부", () => {
    const result = SignupFormSchema.safeParse({ ...VALID, role: "" })
    expect(result.success).toBe(false)
  })

  it("role=organizer는 런타임에도 거부한다(가입 경로에 운영자 없음)", () => {
    const result = SignupFormSchema.safeParse({ ...VALID, role: "organizer" })
    expect(result.success).toBe(false)
  })

  it("SignupFormValues['role'] 타입은 컴파일 타임에도 organizer를 막는다", () => {
    const ok: SignupFormValues["role"] = "exhibitor"
    expect(ok).toBe("exhibitor")
    // @ts-expect-error organizer는 가입 가능한 역할이 아니다 — 리터럴 유니온에 없어 대입 자체가 막힌다.
    const notAllowed: SignupFormValues["role"] = "organizer"
    expect(notAllowed).toBeDefined()
  })

  it.each([
    ["short1", false], // 7자
    ["password", false], // 숫자 없음
    ["12345678", false], // 영문 없음
    ["password1", true], // 8자 + 영문 + 숫자
    ["p1ssword", true],
  ])("비밀번호 정책 — %s → 통과 %s", (password, expected) => {
    const result = SignupFormSchema.safeParse({ ...VALID, password, passwordConfirm: password })
    expect(result.success).toBe(expected)
  })

  it("비밀번호와 확인이 다르면 passwordConfirm 경로로 오류", () => {
    const result = SignupFormSchema.safeParse({ ...VALID, passwordConfirm: "different1" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "passwordConfirm")).toBe(true)
    }
  })

  it("기업명(국문)이 비어 있으면 거부", () => {
    expect(SignupFormSchema.safeParse({ ...VALID, orgNameKo: "  " }).success).toBe(false)
  })

  it("기업명(영문)은 선택 — 비어 있어도 통과", () => {
    expect(SignupFormSchema.safeParse({ ...VALID, orgNameEn: "" }).success).toBe(true)
  })

  it("이메일 형식이 아니면 거부", () => {
    expect(SignupFormSchema.safeParse({ ...VALID, email: "not-an-email" }).success).toBe(false)
  })

  it("약관 미동의(termsAgreed=false)면 거부", () => {
    const result = SignupFormSchema.safeParse({ ...VALID, termsAgreed: false })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "termsAgreed")).toBe(true)
    }
  })

  it("전화번호는 선택 — 비어 있어도 통과", () => {
    expect(SignupFormSchema.safeParse({ ...VALID, phone: "" }).success).toBe(true)
  })
})

// 시나리오별로 결과를 갈아끼우는 fake SignupClient. 이메일 인증코드는 기본적으로 "123456"만
// 통과시킨다(#9) — 코드 자체를 다루는 테스트만 verifyEmailCode를 별도로 override한다.
function fakeClient(
  signup: (input: SignupInput) => SignupResult,
  overrides: Partial<SignupClient> = {}
): SignupClient {
  return {
    async signup(input) {
      return signup(input)
    },
    async requestEmailCode() {
      return { outcome: "sent" }
    },
    async verifyEmailCode(_email, code) {
      if (code === "123456") return { outcome: "verified", token: "test-verification-token" }
      return { outcome: "invalid_code" }
    },
    ...overrides,
  }
}

async function verifyEmailInForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "인증코드 발송" }))
  await user.type(await screen.findByLabelText("인증코드"), "123456")
  await user.click(screen.getByRole("button", { name: "확인" }))
  await screen.findByText("인증완료")
}

async function fillValidForm() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "바이어" }))
  await user.type(screen.getByLabelText("기업명(국문)"), "한화에어로스페이스")
  await user.type(screen.getByLabelText("담당자 이름"), "김바이어")
  await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
  await verifyEmailInForm(user)
  await user.type(screen.getByLabelText("비밀번호"), "password1")
  await user.type(screen.getByLabelText("비밀번호 확인"), "password1")
  await user.click(screen.getByLabelText("위 약관에 모두 동의합니다 (필수)"))
  return user
}

describe("SignupForm (렌더·제출 흐름)", () => {
  it("필수 항목을 채우지 않고 제출하면 인라인 오류가 뜨고 client는 호출되지 않는다", async () => {
    const signup = vi.fn()
    render(<SignupForm client={fakeClient(signup)} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("기업명(국문)을 입력해주세요.")).toBeInTheDocument()
    expect(signup).not.toHaveBeenCalled()
  })

  it("성공(201) — 성공 화면과 로그인 링크를 보여준다", async () => {
    const client = fakeClient(() => ({ outcome: "succeeded" }))
    render(<SignupForm client={client} />)
    const user = await fillValidForm()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("가입이 완료됐어요")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "로그인으로" })).toHaveAttribute("href", "/login")
  })

  it("이메일 중복(409) — '이미 가입된 이메일' 에러를 인라인으로 보여준다", async () => {
    const client = fakeClient(() => ({ outcome: "email_taken" }))
    render(<SignupForm client={client} />)
    const user = await fillValidForm()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("이미 가입된 이메일이에요.")).toBeInTheDocument()
    // 성공 화면으로 넘어가지 않고 폼이 그대로 남아있다.
    expect(screen.getByRole("button", { name: "가입하기" })).toBeInTheDocument()
  })

  it("검증 실패(422) — 백엔드가 되돌린 필드별 오류를 인라인으로 보여준다", async () => {
    const client = fakeClient(() => ({
      outcome: "validation_error",
      fieldErrors: { email: "이미 사용 중인 이메일 형식입니다." },
    }))
    render(<SignupForm client={client} />)
    const user = await fillValidForm()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    await waitFor(() => {
      expect(screen.getByText("이미 사용 중인 이메일 형식입니다.")).toBeInTheDocument()
    })
  })

  it("가입 유형을 선택하지 않으면 role 오류가 뜬다", async () => {
    render(<SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("기업명(국문)"), "한화에어로스페이스")
    await user.type(screen.getByLabelText("담당자 이름"), "김바이어")
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await user.type(screen.getByLabelText("비밀번호"), "password1")
    await user.type(screen.getByLabelText("비밀번호 확인"), "password1")
    await user.click(screen.getByLabelText("위 약관에 모두 동의합니다 (필수)"))
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("가입 유형을 선택해주세요.")).toBeInTheDocument()
  })
})

// 이슈 #9 — 가입 이메일 실존 인증(가입 중 코드 확인).
describe("SignupForm (이메일 인증코드, #9)", () => {
  it("다른 필드가 다 유효해도 이메일 인증 전이면 제출이 막히고 signup이 호출되지 않는다", async () => {
    const signup = vi.fn(() => ({ outcome: "succeeded" }) as SignupResult)
    render(<SignupForm client={fakeClient(signup)} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "바이어" }))
    await user.type(screen.getByLabelText("기업명(국문)"), "한화에어로스페이스")
    await user.type(screen.getByLabelText("담당자 이름"), "김바이어")
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await user.type(screen.getByLabelText("비밀번호"), "password1")
    await user.type(screen.getByLabelText("비밀번호 확인"), "password1")
    await user.click(screen.getByLabelText("위 약관에 모두 동의합니다 (필수)"))
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("이메일 인증을 먼저 완료해주세요.")).toBeInTheDocument()
    expect(signup).not.toHaveBeenCalled()
  })

  it("코드 확인에 성공하면 인증완료 배지가 뜨고 이메일 입력이 잠긴다", async () => {
    render(<SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await verifyEmailInForm(user)

    expect(screen.getByLabelText("이메일")).toHaveAttribute("readonly")
  })

  it("틀린 코드는 인라인 오류를 보여주고 인증 상태로 넘어가지 않는다", async () => {
    render(<SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await user.click(screen.getByRole("button", { name: "인증코드 발송" }))
    await user.type(await screen.findByLabelText("인증코드"), "000000")
    await user.click(screen.getByRole("button", { name: "확인" }))

    expect(await screen.findByText("인증코드가 올바르지 않거나 만료됐어요.")).toBeInTheDocument()
    expect(screen.queryByText("인증완료")).not.toBeInTheDocument()
  })

  it("인증 완료 후 이메일을 바꾸면(변경 버튼) 인증 상태가 풀린다", async () => {
    render(<SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await verifyEmailInForm(user)

    await user.click(screen.getByRole("button", { name: "변경" }))
    await user.clear(screen.getByLabelText("이메일"))
    await user.type(screen.getByLabelText("이메일"), "changed@example.com")

    expect(screen.queryByText("인증완료")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "인증코드 발송" })).toBeInTheDocument()
  })

  it("발송 요청이 rate_limited면 인라인 오류를 보여준다", async () => {
    const client = fakeClient(() => ({ outcome: "succeeded" }), {
      async requestEmailCode() {
        return { outcome: "rate_limited" }
      },
    })
    render(<SignupForm client={client} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("이메일"), "buyer@example.com")
    await user.click(screen.getByRole("button", { name: "인증코드 발송" }))

    expect(await screen.findByText("잠시 후 다시 시도해주세요.")).toBeInTheDocument()
  })

  it("가입이 403(verification_invalid)이면 인증 상태를 리셋하고 안내한다", async () => {
    const client = fakeClient(() => ({ outcome: "verification_invalid" }))
    render(<SignupForm client={client} />)
    const user = await fillValidForm()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("이메일 인증이 만료됐어요. 인증코드를 다시 확인해주세요.")).toBeInTheDocument()
    expect(screen.queryByText("인증완료")).not.toBeInTheDocument()
  })
})

// 이슈 #8 — 입력란 예시(placeholder). label 대체가 아니라 별도 힌트로 존재하는지 확인한다.
describe("SignupForm (placeholder)", () => {
  it("ko — 입력란마다 예시 placeholder가 보인다", () => {
    render(<SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />)

    expect(screen.getByPlaceholderText("예: 주식회사 나비")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("예: Sales AI Co., Ltd.")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("예: 홍길동")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("예: name@company.com")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("예: 010-1234-5678")).toBeInTheDocument()
    // label은 그대로 유지 — placeholder가 label을 대체하지 않는다.
    expect(screen.getByLabelText("기업명(국문)")).toBeInTheDocument()
  })

  it("en — placeholder도 영문으로 바뀐다", () => {
    rtlRender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SignupForm client={fakeClient(() => ({ outcome: "succeeded" }))} />
      </NextIntlClientProvider>
    )

    expect(screen.getByPlaceholderText("e.g. name@company.com")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("e.g. Hong Gildong")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("e.g. +82-10-1234-5678")).toBeInTheDocument()
  })

  it("placeholder 문구는 값이 아니다 — 빈 값 제출 시 필수 검증이 그대로 동작한다", async () => {
    const signup = vi.fn()
    render(<SignupForm client={fakeClient(signup)} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "가입하기" }))

    expect(await screen.findByText("기업명(국문)을 입력해주세요.")).toBeInTheDocument()
    expect(signup).not.toHaveBeenCalled()
  })
})
