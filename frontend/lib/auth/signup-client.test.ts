import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  mockSignupClient,
  httpSignupClient,
  DUPLICATE_EMAIL_SENTINEL,
  type SignupInput,
} from "./signup-client"

const BASE_INPUT: SignupInput = {
  email: "buyer@example.com",
  password: "password1",
  name: "김바이어",
  orgNameKo: "한화에어로스페이스",
  role: "buyer",
  emailVerificationToken: "verify-token",
}

describe("mockSignupClient (가입 mock — 성공·409 시뮬레이션)", () => {
  it("일반 이메일은 succeeded", async () => {
    const res = await mockSignupClient.signup(BASE_INPUT)
    expect(res).toEqual({ outcome: "succeeded" })
  })

  it("중복 이메일 센티넬은 email_taken(409)", async () => {
    const res = await mockSignupClient.signup({ ...BASE_INPUT, email: DUPLICATE_EMAIL_SENTINEL })
    expect(res).toEqual({ outcome: "email_taken" })
  })

  it("중복 이메일 판정은 대소문자·공백에 무관하다", async () => {
    const res = await mockSignupClient.signup({ ...BASE_INPUT, email: "  Taken@NABI.DEMO  " })
    expect(res).toEqual({ outcome: "email_taken" })
  })
})

describe("httpSignupClient (BFF 계약 매핑)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("201 → succeeded, snake_case body로 POST /api/auth/signup 호출", async () => {
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({}) })
    const res = await httpSignupClient.signup({ ...BASE_INPUT, orgNameEn: "Hanwha", phone: "010" })
    expect(res).toEqual({ outcome: "succeeded" })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/signup",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      email: "buyer@example.com",
      password: "password1",
      name: "김바이어",
      phone: "010",
      org_name_ko: "한화에어로스페이스",
      org_name_en: "Hanwha",
      role: "buyer",
      email_verification_token: "verify-token",
    })
  })

  it("409 → email_taken", async () => {
    fetchMock.mockResolvedValue({ status: 409, json: async () => ({}) })
    const res = await httpSignupClient.signup(BASE_INPUT)
    expect(res).toEqual({ outcome: "email_taken" })
  })

  it("422(FastAPI pydantic 형태) → 필드별 인라인 에러로 매핑", async () => {
    fetchMock.mockResolvedValue({
      status: 422,
      json: async () => ({
        detail: [
          { loc: ["body", "email"], msg: "잘못된 이메일 형식입니다.", type: "value_error" },
          { loc: ["body", "org_name_ko"], msg: "필수 항목입니다.", type: "missing" },
        ],
      }),
    })
    const res = await httpSignupClient.signup(BASE_INPUT)
    expect(res).toEqual({
      outcome: "validation_error",
      fieldErrors: {
        email: "잘못된 이메일 형식입니다.",
        orgNameKo: "필수 항목입니다.",
      },
    })
  })

  it("그 외 상태코드는 throw", async () => {
    fetchMock.mockResolvedValue({ status: 500, json: async () => ({}) })
    await expect(httpSignupClient.signup(BASE_INPUT)).rejects.toThrow("signup request failed (500)")
  })

  it("403 → verification_invalid (#9 — 인증 토큰 위조·만료·소진·불일치)", async () => {
    fetchMock.mockResolvedValue({ status: 403, json: async () => ({}) })
    const res = await httpSignupClient.signup(BASE_INPUT)
    expect(res).toEqual({ outcome: "verification_invalid" })
  })
})

describe("httpSignupClient — 이메일 인증코드(#9)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("requestEmailCode 200 → sent, POST /api/auth/signup/email-code", async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({}) })
    const res = await httpSignupClient.requestEmailCode("buyer@example.com")
    expect(res).toEqual({ outcome: "sent" })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/signup/email-code",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("requestEmailCode 429 → rate_limited", async () => {
    fetchMock.mockResolvedValue({ status: 429, json: async () => ({}) })
    const res = await httpSignupClient.requestEmailCode("buyer@example.com")
    expect(res).toEqual({ outcome: "rate_limited" })
  })

  it("requestEmailCode 422 → invalid_email", async () => {
    fetchMock.mockResolvedValue({ status: 422, json: async () => ({}) })
    const res = await httpSignupClient.requestEmailCode("not-an-email")
    expect(res).toEqual({ outcome: "invalid_email" })
  })

  it("verifyEmailCode 200 → verified with token, POST /api/auth/signup/email-code/verify", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: "verified", verification_token: "tok-123" }),
    })
    const res = await httpSignupClient.verifyEmailCode("buyer@example.com", "123456")
    expect(res).toEqual({ outcome: "verified", token: "tok-123" })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/signup/email-code/verify",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("verifyEmailCode 422 → invalid_code", async () => {
    fetchMock.mockResolvedValue({ status: 422, json: async () => ({}) })
    const res = await httpSignupClient.verifyEmailCode("buyer@example.com", "000000")
    expect(res).toEqual({ outcome: "invalid_code" })
  })
})
