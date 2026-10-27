import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperatorApplicationClient } from "@/lib/operator/application-client"
import { TEST_SLOT_GRID, testBuyerDetail, testExhibitorDetail } from "@/lib/test/operator-application"

import {
  createOrganizerApplicationTransport,
  createOrganizerMockApplicationTransport,
  organizerMockOrgDetail,
} from "./application-transport"
import type { MemberRow } from "./members"

// 행사 운영 콘솔의 신청서 전송 — BFF 봉투({ success, detail | profile })를 벗겨 공용 어댑터에 넘긴다.
// "저장된 프로필이 응답에 없으면 저장을 확인할 수 없다"를 실패로 다루는 것이 핵심이다.

afterEach(() => vi.unstubAllGlobals())

describe("createOrganizerApplicationTransport", () => {
  it("GET /profile의 상세와 격자를 그대로 돌려준다", async () => {
    const detail = testExhibitorDetail({}, { id: "org-1" })
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, id: "org-1", detail, slotGrid: TEST_SLOT_GRID }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await createOrganizerApplicationTransport("org-1").getDetail()

    expect(fetchMock.mock.calls[0][0]).toBe("/api/organizer/members/org-1/profile")
    expect(result).toEqual({ detail, slotGrid: TEST_SLOT_GRID })
  })

  it("프로필 저장은 { role, mode: 'edit', patch }로 보내고 응답의 저장된 프로필을 돌려준다", async () => {
    const saved = testBuyerDetail().buyer_profile
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, id: "org-2", profile: saved }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await createOrganizerApplicationTransport("org-2").patchProfile("buyer", {
      org_types: ["media", "other"],
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/organizer/members/org-2/profile")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({
      role: "buyer",
      mode: "edit",
      patch: { org_types: ["media", "other"] },
    })
    expect(result).toEqual(saved)
  })

  it("미팅 불가 시간은 전용 BFF로 { slots }를 보낸다", async () => {
    const saved = testExhibitorDetail().exhibitor_profile
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, profile: saved }))
    vi.stubGlobal("fetch", fetchMock)

    await createOrganizerApplicationTransport("org-1").patchUnavailableSlots(["2026-10-20T10:00"])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/organizer/members/org-1/unavailable-slots")
    expect(JSON.parse(init.body as string)).toEqual({ slots: ["2026-10-20T10:00"] })
  })

  it("응답에 저장된 프로필이 없으면 성공으로 치지 않는다(저장 확인 실패)", async () => {
    // 세션 쿠키가 없는 목 분기 — 저장소가 없어 프로필 없이 { success: true }만 답한다.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, id: "org-1" })))
    const transport = createOrganizerApplicationTransport("org-1")

    await expect(transport.patchProfile("exhibitor", {})).rejects.toMatchObject({
      status: 502,
      code: "save_unconfirmed",
    })
  })

  it("응답에 상세가 없으면 읽기 실패로 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })))
    await expect(createOrganizerApplicationTransport("org-1").getDetail()).rejects.toMatchObject({
      code: "no_detail",
    })
  })

  it("BFF의 실패(403)는 상태·사유 그대로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: false, error: "이 바이어는 관할 밖입니다" }, { status: 403 }),
        ),
    )
    await expect(
      createOrganizerApplicationTransport("org-1").patchProfile("buyer", {}),
    ).rejects.toMatchObject({ status: 403, code: "이 바이어는 관할 밖입니다" })
  })
})

describe("목업 모드 — 명단 픽스처를 패널의 시드로", () => {
  const row: MemberRow = {
    id: "e1",
    name: "픽셀아츠 스튜디오",
    nameEn: "PixelArts Studio",
    tab: "exhibitor",
    applicationStatus: "approved",
    primaryContact: "김민수",
    contactPhone: null,
    contactEmail: null,
    productCategory: "콘텐츠 제작",
    importedAt: "",
    profileCompletion: 0,
    matchCount: 0,
    lastActivityAt: null,
  }

  it("참가사 행·프로필을 상세 형상으로 옮긴다(없는 칸은 지어내지 않는다)", () => {
    const detail = organizerMockOrgDetail(row, {
      categories: ["콘텐츠 제작"],
      annualSales: "50억원 이상",
      companyIntroKo: "소개",
      availableLanguages: "영어, 베트남어",
      preferredBuyerCountries: "베트남, 태국",
      products: [{ nameKo: "나이트브릿지", category: "만화웹툰 제작" }],
    })

    expect(detail.is_exhibitor).toBe(true)
    expect(detail.buyer_profile).toBeNull()
    expect(detail.exhibitor_profile).toMatchObject({
      organization_name_ko: "픽셀아츠 스튜디오",
      organization_name_en: "PixelArts Studio",
      application_status: "approved",
      intro_ko: "소개",
      annual_sales_range: "50억원 이상", // 조회용 라벨을 그대로 얹는다(목업 전용)
      available_languages: ["영어", "베트남어"],
      preferred_buyer_countries: ["베트남", "태국"],
      business_reg_no: null,
    })
    expect(detail.exhibitor_profile?.products).toEqual([
      {
        name_ko: "나이트브릿지",
        name_en: null,
        business_field: "만화웹툰 제작",
        hs_code: null,
        hs_description: null,
        price_range: null,
      },
    ])
  })

  it("인메모리 전송 위에서 공용 어댑터가 그대로 돈다 — 고친 값이 다시 읽힌다", async () => {
    const transport = createOrganizerMockApplicationTransport(row, null)
    const client = createOperatorApplicationClient("exhibitor", transport, { canAssignBooth: true })
    if (client.role !== "exhibitor") throw new Error("expected exhibitor client")

    const loaded = await client.getProfile()
    await client.saveOperatorFields({ organizationNameKo: "픽셀아츠(주)" }, loaded)

    const reopened = createOperatorApplicationClient("exhibitor", transport, { canAssignBooth: true })
    const again = await reopened.getProfile()
    expect(again.role === "exhibitor" && again.profile.organizationNameKo).toBe("픽셀아츠(주)")
  })
})
