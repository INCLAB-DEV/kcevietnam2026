import { describe, it, expect } from "vitest"
import { postLoginPath, landingHref } from "./role-branch"

describe("postLoginPath", () => {
  it("운영사는 /organizer로 분기한다", () => {
    expect(postLoginPath("organizer")).toBe("/organizer")
  })

  it("참가사·바이어는 입장 전 랜딩(/welcome)으로 분기한다", () => {
    // 자격(application_status)과 무관 — /welcome이 세션 상태로 화면·동선을 정한다(participant-gate 대체).
    expect(postLoginPath("buyer")).toBe("/welcome")
    expect(postLoginPath("exhibitor")).toBe("/welcome")
  })
})

describe("landingHref", () => {
  it("도착 경로에 dev 세션 시드(?as=role)를 붙인다", () => {
    expect(landingHref("organizer")).toBe("/organizer?as=organizer")
    expect(landingHref("buyer")).toBe("/welcome?as=buyer")
    expect(landingHref("exhibitor")).toBe("/welcome?as=exhibitor")
  })

  it("로그인 결과 application_status를 ?status로 함께 실어 dev 상태 쿠키에 반영한다", () => {
    expect(landingHref("buyer", "submitted")).toBe("/welcome?as=buyer&status=submitted")
    expect(landingHref("exhibitor", "registered")).toBe("/welcome?as=exhibitor&status=registered")
  })

  it("운영자는 status가 무의미하므로 ?status를 생략한다", () => {
    expect(landingHref("organizer", "submitted")).toBe("/organizer?as=organizer")
  })

  it("seedDevSession:false면 dev 시드(?as/?status) 없이 postLoginPath만 반환한다(P1-1 실 세션 로그인)", () => {
    expect(landingHref("buyer", "approved", { seedDevSession: false })).toBe("/welcome")
    expect(landingHref("exhibitor", undefined, { seedDevSession: false })).toBe("/welcome")
    expect(landingHref("organizer", undefined, { seedDevSession: false })).toBe("/organizer")
  })
})
