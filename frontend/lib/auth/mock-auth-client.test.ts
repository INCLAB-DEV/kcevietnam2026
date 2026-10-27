import { describe, it, expect } from "vitest"
import { mockAuthClient } from "./mock-auth-client"

describe("mockAuthClient.checkDeeplinkToken (deeplink-token 계약)", () => {
  it("만료 센티넬 토큰은 expired", async () => {
    expect(await mockAuthClient.checkDeeplinkToken("expired")).toEqual({ status: "expired" })
  })

  it("위조/빈 토큰은 invalid", async () => {
    expect(await mockAuthClient.checkDeeplinkToken("invalid")).toEqual({ status: "invalid" })
    expect(await mockAuthClient.checkDeeplinkToken("")).toEqual({ status: "invalid" })
  })

  it("그 외 토큰은 valid이며 프리필용 아이디·이름을 함께 돌려준다", async () => {
    expect(await mockAuthClient.checkDeeplinkToken("a-long-random-token")).toEqual({
      status: "valid",
      username: "buyer",
      name: "김바이어",
    })
  })

  it("토큰값이 데모 계정명이면 그 계정 아이디·이름으로 프리필한다", async () => {
    expect(await mockAuthClient.checkDeeplinkToken("exhibitor")).toEqual({
      status: "valid",
      username: "exhibitor",
      name: "이참가사",
    })
  })
})

describe("mockAuthClient.startLogin (1단계: 자격검증 + 분기)", () => {
  it("최초 진입자(buyer)는 약관 단계(consent_required) + 회원ID 기반 mock 티켓을 돌려준다", async () => {
    const res = await mockAuthClient.startLogin({ username: "buyer", password: "demo1234" })
    expect(res.outcome).toBe("consent_required")
    if (res.outcome !== "consent_required") throw new Error("expected consent_required")
    expect(res.loginTicket).toBe("mock-ticket-mbr-buyer-01")
    expect(res.documents.filter((d) => d.required).map((d) => d.id)).toEqual(["tos", "privacy", "sensitive"])
    expect(res.documents.some((d) => !d.required)).toBe(true)
  })

  it("재방문 + 프로필 완료(buyer-old)는 약관 스킵하고 곧바로 succeeded", async () => {
    const res = await mockAuthClient.startLogin({ username: "buyer-old", password: "demo1234" })
    expect(res).toEqual({
      outcome: "succeeded",
      role: "buyer",
      gate: { applicationStatus: "submitted", hasProfile: true },
    })
  })

  it("재방문이지만 기업정보 미입력(buyer-wip)은 succeeded + registered/false 게이트", async () => {
    const res = await mockAuthClient.startLogin({ username: "buyer-wip", password: "demo1234" })
    expect(res).toMatchObject({
      outcome: "succeeded",
      role: "buyer",
      gate: { applicationStatus: "registered", hasProfile: false },
    })
  })

  it("비밀번호가 틀리면 rejected invalid_credentials", async () => {
    const res = await mockAuthClient.startLogin({ username: "buyer", password: "nope" })
    expect(res).toEqual({ outcome: "rejected", reason: "invalid_credentials" })
  })

  it("알 수 없는 아이디는 rejected invalid_credentials", async () => {
    const res = await mockAuthClient.startLogin({ username: "ghost", password: "demo1234" })
    expect(res).toEqual({ outcome: "rejected", reason: "invalid_credentials" })
  })

  it("deeplinkToken은 프리필 편의일 뿐 — 있어도 자격 결과에 영향 없다", async () => {
    const res = await mockAuthClient.startLogin({
      username: "buyer",
      password: "demo1234",
      deeplinkToken: "whatever",
    })
    expect(res.outcome).toBe("consent_required")
  })
})

describe("mockAuthClient.completeLogin (2단계: 약관 동의 → 세션)", () => {
  it("최초 진입자가 필수 약관을 모두 동의하면 succeeded + 역할/게이트 복원", async () => {
    const start = await mockAuthClient.startLogin({ username: "exhibitor", password: "demo1234" })
    if (start.outcome !== "consent_required") throw new Error("expected consent_required")
    const res = await mockAuthClient.completeLogin({
      loginTicket: start.loginTicket,
      acceptedDocIds: ["tos", "privacy", "sensitive"],
    })
    expect(res).toEqual({
      outcome: "succeeded",
      role: "exhibitor",
      gate: { applicationStatus: "registered", hasProfile: false },
    })
  })

  it("필수 약관 누락이면 consent_incomplete + missingRequired", async () => {
    const start = await mockAuthClient.startLogin({ username: "buyer", password: "demo1234" })
    if (start.outcome !== "consent_required") throw new Error("expected consent_required")
    const res = await mockAuthClient.completeLogin({
      loginTicket: start.loginTicket,
      acceptedDocIds: ["tos"],
    })
    expect(res).toEqual({ outcome: "consent_incomplete", missingRequired: ["privacy", "sensitive"] })
  })

  it("형식이 틀린/알 수 없는 티켓은 ticket_invalid", async () => {
    const res = await mockAuthClient.completeLogin({
      loginTicket: "bogus-ticket",
      acceptedDocIds: ["tos", "privacy", "sensitive"],
    })
    expect(res).toEqual({ outcome: "ticket_invalid", reason: "forged" })
  })
})
