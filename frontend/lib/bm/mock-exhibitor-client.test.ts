import { beforeEach, describe, expect, it } from "vitest"
import { __resetExhibitorStore, mockExhibitorClient } from "./mock-exhibitor-client"

const ROLE = "exh-role-1"

beforeEach(() => __resetExhibitorStore())

describe("mockExhibitorClient — 단계별 저장 / 이어쓰기", () => {
  it("여러 단계 저장 후 조회 시 각 단계 값이 보존된다", async () => {
    // 1 기본정보 · 2 회사소개 · 3 전시품목
    await mockExhibitorClient.saveStep(ROLE, 1, {
      organizationNameKo: "가상콘텐츠",
      organizationNameEn: "Virtual Content",
      attendees: [{ firstNameKo: "김담당", email: "lead@example.com" }],
    })
    await mockExhibitorClient.saveStep(ROLE, 2, { introKo: "소개", introEn: "intro" })
    await mockExhibitorClient.saveStep(ROLE, 3, {
      products: [{ nameKo: "웹툰 시리즈" }],
      exhibitionCategories: ["webtoon_production"],
    })

    const got = await mockExhibitorClient.getProfile(ROLE)
    expect(got.organizationNameKo).toBe("가상콘텐츠")
    expect(got.attendees).toEqual([{ firstNameKo: "김담당", email: "lead@example.com" }])
    expect(got.introKo).toBe("소개")
    expect(got.products).toEqual([{ nameKo: "웹툰 시리즈" }])
    expect(got.applicationStatus).toBe("registered") // 제출 전엔 미승격
  })

  it("한 단계 PATCH 는 그 단계 필드만 바꾼다", async () => {
    await mockExhibitorClient.saveStep(ROLE, 1, {
      organizationNameKo: "old",
      mainTel: "02-1",
    })
    await mockExhibitorClient.saveStep(ROLE, 1, { organizationNameKo: "new" })
    const got = await mockExhibitorClient.getProfile(ROLE)
    expect(got.organizationNameKo).toBe("new")
    expect(got.mainTel).toBe("02-1")
  })

  it("제품 빈 줄은 저장 시 제거된다(전시품목=3단계)", async () => {
    await mockExhibitorClient.saveStep(ROLE, 3, {
      products: [{ nameKo: "드론" }, { nameKo: "  " }],
    })
    const got = await mockExhibitorClient.getProfile(ROLE)
    expect(got.products).toEqual([{ nameKo: "드론" }])
  })
})

describe("mockExhibitorClient — 원자적 제출(승격)", () => {
  it("제출 시 application_status 가 submitted 로 전환된다", async () => {
    await mockExhibitorClient.saveStep(ROLE, 1, { organizationNameKo: "A" })
    const submitted = await mockExhibitorClient.submit(ROLE)
    expect(submitted.applicationStatus).toBe("submitted")
    // 저장(데이터)과 상태 전환이 함께 보존된다(반쪽 제출 없음).
    expect(submitted.organizationNameKo).toBe("A")
  })

  it("제출 시 최종 편집(patch)이 함께 반영된다", async () => {
    await mockExhibitorClient.submit(ROLE, {
      organizationNameKo: "최종",
      products: [{ nameKo: "P" }],
    })
    const got = await mockExhibitorClient.getProfile(ROLE)
    expect(got.applicationStatus).toBe("submitted")
    expect(got.organizationNameKo).toBe("최종")
    expect(got.products).toEqual([{ nameKo: "P" }])
  })

  it("이미 submitted 면 재저장해도 submitted 유지(멱등)", async () => {
    await mockExhibitorClient.submit(ROLE)
    const again = await mockExhibitorClient.submit(ROLE, { introKo: "수정" })
    expect(again.applicationStatus).toBe("submitted")
  })
})
