import { afterEach, describe, expect, it, vi } from "vitest"

import { toFormState } from "@/components/admin/proxy-profile-form"
import { createOperatorApplicationClient } from "@/lib/operator/application-client"
import { TEST_SLOT_GRID, testExhibitorDetail } from "@/lib/test/operator-application"

import {
  adminMockOrgDetail,
  createAdminApplicationTransport,
  createAdminMockApplicationTransport,
} from "./application-transport"
import type { AdminOrganization, AdminOrgProfile } from "./types"

// 관리자 콘솔의 신청서 전송 — catch-all BFF(app/api/admin/[...path])가 백엔드 본문을 그대로 통과시키므로
// 경로만 맞으면 된다. 경로는 lib/admin/api-paths.ts가 단일 소스다.

afterEach(() => vi.unstubAllGlobals())

describe("createAdminApplicationTransport", () => {
  it("상세는 행사 스코프 경로에서 읽고, 콘솔이 넘긴 격자를 함께 돌려준다", async () => {
    const detail = testExhibitorDetail({}, { id: "org-1" })
    const fetchMock = vi.fn().mockResolvedValue(Response.json(detail))
    vi.stubGlobal("fetch", fetchMock)

    const result = await createAdminApplicationTransport("event 1", "org-1", TEST_SLOT_GRID).getDetail()

    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/events/event%201/organizations/org-1")
    expect(result).toEqual({ detail, slotGrid: TEST_SLOT_GRID })
  })

  it("프로필 저장은 PATCH .../profile?role= 로 본문을 그대로 보내고 응답(저장된 프로필)을 돌려준다", async () => {
    const saved = testExhibitorDetail().exhibitor_profile
    const fetchMock = vi.fn().mockResolvedValue(Response.json(saved))
    vi.stubGlobal("fetch", fetchMock)

    const result = await createAdminApplicationTransport("event", "org-1", null).patchProfile(
      "exhibitor",
      { preferred_buyer_types: ["media"] },
    )

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/admin/events/event/organizations/org-1/profile?role=exhibitor")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ preferred_buyer_types: ["media"] })
    expect(result).toEqual(saved)
  })

  it("미팅 불가 시간은 PATCH .../unavailable-slots 로 { slots }를 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(testExhibitorDetail().exhibitor_profile))
    vi.stubGlobal("fetch", fetchMock)

    await createAdminApplicationTransport("event", "org-1", null).patchUnavailableSlots([
      "2026-10-20T10:00",
    ])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/admin/events/event/organizations/org-1/unavailable-slots")
    expect(JSON.parse(init.body as string)).toEqual({ slots: ["2026-10-20T10:00"] })
  })

  it("백엔드 거부(403)는 상태·사유 그대로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ detail: "부스 지정은 슈퍼관리자만 할 수 있습니다" }, { status: 403 }),
        ),
    )
    await expect(
      createAdminApplicationTransport("event", "org-1", null).patchProfile("exhibitor", {}),
    ).rejects.toMatchObject({ status: 403, code: "부스 지정은 슈퍼관리자만 할 수 있습니다" })
  })
})

describe("목업 모드 — 목록 픽스처를 패널의 시드로", () => {
  const org: AdminOrganization = {
    id: "org-1",
    event_id: "event",
    role: "exhibitor",
    name_ko: "픽셀아츠 스튜디오",
    name_en: "PixelArts Studio",
    country: null,
    application_status: "approved",
    proxy_written: true,
    proxy_written_by: "운영자",
    proxy_written_at: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    category: null,
    business_field_codes: [],
    content_category: "broadcasting",
    booth_label: null,
    registered_by: null,
    meeting_count: 0,
    unavailable_slots: ["2026-10-20T10:00"],
    updated_at: "",
  }
  const profile = {
    organization_id: "org-1",
    business_reg_no: "123-45-67890",
    website: "https://pixelarts.example",
    company_intro_ko: "소개",
    categories: ["content_production"],
    booth_location: "A-12",
    available_languages: ["en"],
    preferred_buyer_countries: ["vietnam"],
    preferred_buyer_types: ["media"],
    interpreter_need: false,
    products: [],
    exhibitor_attendees: [{ first_name_ko: "민수", last_name_ko: "김" }],
    exhibitor_products: [{ name_ko: "나이트브릿지", hs_description: "인쇄물" }],
  } as unknown as AdminOrgProfile

  it("참가사 행·프로필을 상세 형상으로 옮긴다(담당자·제품은 백엔드 원본 행 그대로)", () => {
    const detail = adminMockOrgDetail(org, profile)

    expect(detail).toMatchObject({
      id: "org-1",
      is_exhibitor: true,
      is_buyer: false,
      application_status: "approved",
      proxy_written_by_organizer_id: "mock-organizer",
      buyer_profile: null,
    })
    expect(detail.exhibitor_profile).toMatchObject({
      organization_name_ko: "픽셀아츠 스튜디오",
      business_reg_no: "123-45-67890",
      booth_location: "A-12",
      content_category: "broadcasting",
      exhibition_categories: ["content_production"],
      preferred_buyer_countries: ["vietnam"],
      unavailable_meeting_slots: ["2026-10-20T10:00"],
      attendees: [{ first_name_ko: "민수", last_name_ko: "김" }],
      products: [{ name_ko: "나이트브릿지", hs_description: "인쇄물" }],
    })
  })

  it("바이어는 미응답인 통역 필요를 false로 지어내지 않는다(프로필이 없으면 null)", () => {
    const buyer = adminMockOrgDetail({ ...org, role: "buyer" }, null)
    expect(buyer.exhibitor_profile).toBeNull()
    expect(buyer.buyer_profile?.contact_interpreter_need).toBeNull()
    expect(buyer.buyer_profile?.org_types).toEqual([])
  })

  it("인메모리 전송 위에서 공용 어댑터가 그대로 돌고, 대리작성 폼과 같은 프로필을 본다", async () => {
    const transport = createAdminMockApplicationTransport(org, profile, TEST_SLOT_GRID)
    const client = createOperatorApplicationClient("exhibitor", transport, { canAssignBooth: true })
    if (client.role !== "exhibitor") throw new Error("expected exhibitor client")

    const loaded = await client.getProfile()
    expect(loaded.slotGrid).toEqual(TEST_SLOT_GRID)
    expect(loaded.profile.boothLocation).toBe("A-12")
    // 대리작성 다이얼로그도 같은 전송의 상세에서 폼을 만든다(목업 모드 — 열 때 이 저장소에서 읽는다).
    const proxyForm = toFormState((await transport.getDetail()).detail, "exhibitor")
    expect(loaded.profile.products?.[0].nameKo).toBe(proxyForm.products[0].name_ko)

    const saved = await client.saveUnavailableSlots(["2026-10-21T11:00"], loaded)
    expect(saved.profile.unavailableMeetingSlots).toEqual(["2026-10-21T11:00"])
  })
})
