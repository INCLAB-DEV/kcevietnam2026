import { beforeEach, describe, expect, it } from "vitest"
import { __resetBuyerStore, mockBuyerClient } from "./mock-buyer-client"

const ROLE = "buyer-role-1"

beforeEach(() => __resetBuyerStore())

describe("mockBuyerClient — 단계별 저장 / 이어쓰기", () => {
  it("여러 단계 저장 후 조회 시 각 단계 값이 보존된다", async () => {
    await mockBuyerClient.saveStep(ROLE, 1, {
      contactNameEn: "Jane Park",
      contactEmail: "jane@example.com",
      organizationNameEn: "Seoul Content Partners",
    })
    await mockBuyerClient.saveStep(ROLE, 2, {
      interestCategories: ["game_production"],
      companyIntroEn: "intro",
    })

    const got = await mockBuyerClient.getProfile(ROLE)
    expect(got.draft.contactNameEn).toBe("Jane Park")
    expect(got.draft.organizationNameEn).toBe("Seoul Content Partners")
    expect(got.draft.interestCategories).toEqual(["game_production"])
    expect(got.draft.companyIntroEn).toBe("intro")
    expect(got.status).toBe("registered") // 제출 전엔 미승격
  })

  it("한 단계 PATCH는 그 단계 필드만 바꾼다", async () => {
    await mockBuyerClient.saveStep(ROLE, 1, { contactNameEn: "old", tel: "02-1" })
    await mockBuyerClient.saveStep(ROLE, 1, { contactNameEn: "new" })
    const got = await mockBuyerClient.getProfile(ROLE)
    expect(got.draft.contactNameEn).toBe("new")
    expect(got.draft.tel).toBe("02-1")
  })
})

describe("mockBuyerClient — 원자적 제출(승격)", () => {
  it("제출 시 status가 submitted로 전환된다", async () => {
    await mockBuyerClient.saveStep(ROLE, 1, { contactNameEn: "Jane" })
    const submitted = await mockBuyerClient.submit(ROLE)
    expect(submitted.status).toBe("submitted")
    // 저장(데이터)과 상태 전환이 함께 보존된다(반쪽 제출 없음).
    expect(submitted.draft.contactNameEn).toBe("Jane")
  })

  it("제출 시 최종 편집(patch)이 함께 반영된다", async () => {
    await mockBuyerClient.submit(ROLE, { contactNameEn: "최종", contactEmail: "final@example.com" })
    const got = await mockBuyerClient.getProfile(ROLE)
    expect(got.status).toBe("submitted")
    expect(got.draft.contactNameEn).toBe("최종")
    expect(got.draft.contactEmail).toBe("final@example.com")
  })

  it("이미 submitted면 재저장해도 submitted 유지(멱등)", async () => {
    await mockBuyerClient.submit(ROLE)
    const again = await mockBuyerClient.submit(ROLE, { companyIntroEn: "수정" })
    expect(again.status).toBe("submitted")
  })
})
