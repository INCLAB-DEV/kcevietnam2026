import { afterEach, describe, expect, it, vi } from "vitest"

import { stepPatch as buyerStepPatch } from "@/lib/apply/form-state"
import { stepSavePayload } from "@/lib/bm/profile-form-state"
import type { EditableStep } from "@/lib/bm/types"

import {
  BOOTH_BODY_KEYS,
  OperatorConflictError,
  OperatorRequestError,
  createOperatorApplicationClient,
  createOperatorBuyerClient,
  createOperatorExhibitorClient,
  isOperatorConflict,
  isOperatorForbidden,
  operatorJson,
  sameOperatorValue,
  saveUnavailableSlotsChecked,
  type ApiBuyerProfile,
  type ApiExhibitorProfile,
  type OperatorApplicationTransport,
  type OperatorBuyerApplication,
  type OperatorExhibitorApplication,
  type OperatorOrgDetailApi,
} from "./application-client"
import { createMockOperatorTransport } from "./mock-transport"

// 운영자 신청서 편집 어댑터 — "읽어서 그대로 저장하면 서버 값이 하나도 안 바뀐다"(왕복 무손실)와
// 권한·지움 규칙을 본문(body) 수준에서 고정한다. 담당자·제품·분야는 백엔드가 전체 교체라, 여기서
// 한 줄이라도 빠지면 운영 데이터가 삭제된다.

// 참가사 — 폼이 보여 주지 않는 칸(성·부서·영문 직책·메신저·구 카테고리·HS 설명)까지 전부 채운 서버 값.
const EXHIBITOR_API: ApiExhibitorProfile = {
  org_event_role_id: "role-ex",
  application_status: "approved",
  organization_name_ko: "픽셀아츠 스튜디오",
  organization_name_en: "PixelArts Studio",
  business_reg_no: "123-45-67890",
  booth_hall: "7",
  booth_pavilion: "콘텐츠관",
  booth_location: "A-12",
  booth_type: "독립부스",
  booth_count: 2,
  representative_name_ko: "김대표",
  representative_name_en: "Kim Daepyo",
  company_email: "hello@pixelarts.example",
  zip_code: "04038",
  address_detail: "5층",
  business_type: "서비스",
  business_item: "콘텐츠 제작",
  website: "https://pixelarts.example",
  main_tel: "02-000-0000",
  fax: "02-000-0001",
  address_ko: "서울특별시 마포구 양화로 45",
  address_en: "45 Yanghwa-ro, Mapo-gu, Seoul",
  annual_sales_range: "krw_10_50",
  employee_range: "e_11_50",
  available_languages: ["en", "vi"],
  org_types: ["private_commercial", "media"],
  exhibition_categories: ["content_production", "game_production", "webtoon_production"],
  content_category: "broadcasting",
  products: [
    {
      name_ko: "나이트브릿지",
      name_en: "Night Bridge",
      business_field: "webtoon_production",
      category_ko: "웹툰",
      category_en: "Webtoon",
      hs_code: "4911.91",
      hs_description: "인쇄물",
      spec: "시즌 1 · 60화",
      spec_en: "Season 1, 60 episodes",
      price_range: "krw_10_30m",
    },
    {
      name_ko: "픽셀런",
      name_en: "Pixel Run",
      business_field: "game_production",
      category_ko: "모바일 게임",
      category_en: "Mobile game",
      hs_code: "9504.50",
      hs_description: "비디오 게임",
      spec: "iOS/Android",
      spec_en: "iOS/Android",
      price_range: "krw_30_50m",
    },
    {
      name_ko: "스튜디오 다큐",
      name_en: "Studio Documentary",
      business_field: "content_production",
      category_ko: "다큐멘터리",
      category_en: "Documentary",
      hs_code: "3706.10",
      hs_description: "영화 필름",
      spec: "50분 × 4편",
      spec_en: "4 x 50 min",
      price_range: "krw_0_10m",
    },
  ],
  intro_ko: "웹툰·게임·다큐를 만드는 스튜디오입니다.",
  intro_en: "A studio making webtoons, games and documentaries.",
  preferred_buyer_countries: ["vietnam", "thailand", "indonesia"],
  preferred_buyer_types: ["media", "private_commercial"],
  unavailable_meeting_slots: ["2026-10-20T10:00", "2026-10-21T14:00"],
  attendees: [
    {
      last_name_ko: "김",
      last_name_en: "Kim",
      first_name_ko: "민수",
      first_name_en: "Minsu",
      division_ko: "해외사업팀",
      division_en: "Global Business",
      title_ko: "팀장",
      title_en: "Team Lead",
      email: "minsu@pixelarts.example",
      tel: "02-000-0002",
      mobile: "010-0000-0002",
      whatsapp_id: "minsu.kim",
      languages: ["ko", "en"],
    },
    {
      last_name_ko: "이",
      last_name_en: "Lee",
      first_name_ko: "서연",
      first_name_en: "Seoyeon",
      division_ko: "라이선싱팀",
      division_en: "Licensing",
      title_ko: "매니저",
      title_en: "Manager",
      email: "seoyeon@pixelarts.example",
      tel: "02-000-0003",
      mobile: "010-0000-0003",
      whatsapp_id: "seoyeon.lee",
      languages: ["en", "vi"],
    },
    {
      last_name_ko: "박",
      last_name_en: "Park",
      first_name_ko: "지훈",
      first_name_en: "Jihoon",
      division_ko: "제작팀",
      division_en: "Production",
      title_ko: "PD",
      title_en: "Producer",
      email: "jihoon@pixelarts.example",
      tel: "02-000-0004",
      mobile: "010-0000-0004",
      whatsapp_id: "jihoon.park",
      languages: ["ja"],
    },
  ],
} as ApiExhibitorProfile

const BUYER_API: ApiBuyerProfile = {
  org_event_role_id: "role-by",
  application_status: "approved",
  organization_name_ko: "하노이미디어",
  organization_name_en: "Hanoi Media",
  business_reg_no: "VN-0001",
  website: "https://hanoimedia.example",
  contact_name_ko: "응우옌 반 안",
  contact_name_en: "Nguyen Van An",
  contact_title_ko: "구매 이사",
  contact_title_en: "Purchasing Director",
  contact_email: "an@hanoimedia.example",
  contact_language: "vi",
  contact_interpreter_need: true,
  continent: "asia",
  country: "Vietnam",
  city_state: "Hanoi",
  zip_code: "100000",
  address1: "1 Trang Tien",
  address2: "Floor 3",
  tel: "+84-24-0000-0000",
  last_year_best_buyer: "no",
  annual_sales_range: "usd_1m_5m",
  employee_range: "e_51_100",
  business_perf_korea_3y: "usd_1_1m",
  travelers_korea_3y: "t_0_500",
  org_types: ["media", "private_commercial", "exhibition_agent"],
  interest_categories: ["animation_distribution", "content_production", "music_platform"],
  company_intro_ko: "베트남 방송·배급사입니다.",
  company_intro_en: "A Vietnamese broadcaster and distributor.",
  budget_range: "usd_100k_500k",
  adoption_timeline: "2027_h1",
  note: "VIP",
  participation_route: "re_1_2",
  new_acquisition_channel: null,
  kst_available_time: "10:00-17:00",
  attendees: [
    {
      first_name: "Linh",
      last_name: "Tran",
      division: "Acquisition",
      job_title: "Manager",
      email: "linh@hanoimedia.example",
      tel: "+84-24-0000-0001",
      mobile: "+84-90-000-0001",
      whatsapp_id: "linh.tran",
      messenger_id: "linh.t",
      languages: ["en", "vi"],
      interpreter_need: true,
      interpreter_languages: ["vi"],
    },
    {
      first_name: "Minh",
      last_name: "Pham",
      division: "Programming",
      job_title: "Director",
      email: "minh@hanoimedia.example",
      tel: "+84-24-0000-0002",
      mobile: "+84-90-000-0002",
      whatsapp_id: "minh.pham",
      messenger_id: "minh.p",
      languages: ["vi"],
      interpreter_need: false,
      interpreter_languages: [],
    },
  ],
  recommended_buyers: [
    {
      continent: "asia",
      country: "Thailand",
      organization: "Bangkok TV",
      person_in_charge: "Somchai",
      email: "somchai@bangkoktv.example",
      tel: "+66-2-000-0000",
    },
  ],
} as ApiBuyerProfile

function detailOf(over: Partial<OperatorOrgDetailApi> = {}): OperatorOrgDetailApi {
  return {
    id: "org-1",
    org_event_role_id: "role-1",
    event_id: "event-1",
    name_ko: "기업",
    name_en: "Org",
    is_exhibitor: true,
    is_buyer: false,
    application_status: "approved",
    proxy_written_by_organizer_id: null,
    exhibitor_profile: structuredClone(EXHIBITOR_API),
    buyer_profile: null,
    ...over,
  }
}

function buyerDetail(): OperatorOrgDetailApi {
  return detailOf({
    is_exhibitor: false,
    is_buyer: true,
    exhibitor_profile: null,
    buyer_profile: structuredClone(BUYER_API),
  })
}

// 본문이 실제로 나가는 모양(JSON)으로 본다 — undefined 키는 전송되지 않는다.
const wire = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>

// 전송을 감싸 PATCH 본문을 기록한다(저장소는 인메모리 목업 전송 — 백엔드 부분 저장을 흉내 낸다).
function recording(seed: OperatorOrgDetailApi) {
  const inner = createMockOperatorTransport(seed)
  const bodies: Record<string, unknown>[] = []
  const slotCalls: string[][] = []
  const transport: OperatorApplicationTransport = {
    getDetail: () => inner.getDetail(),
    async patchProfile(role, body) {
      bodies.push(wire(body))
      return inner.patchProfile(role, wire(body))
    },
    async patchUnavailableSlots(slots) {
      slotCalls.push(slots)
      return inner.patchUnavailableSlots(slots)
    },
  }
  return { transport, bodies, slotCalls, inner }
}

describe("운영자 신청서 어댑터 — 참가사 왕복 무손실", () => {
  it("읽은 값을 그대로 구획마다 저장해도 서버 프로필이 한 글자도 바뀌지 않는다", async () => {
    const { transport, bodies, inner } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    for (const step of [1, 2, 3, 4] as EditableStep[]) {
      await client.saveStep(step, stepSavePayload(loaded.profile, step), loaded)
    }

    expect(bodies).toHaveLength(4)
    const after = (await inner.getDetail()).detail.exhibitor_profile
    expect(after).toEqual(EXHIBITOR_API)

    // ⚠ 위 단언만으로는 부족하다 — 가짜 서버는 본문에 든 키만 덮어써서, 본문이 통째로 비어도 저장소는
    // 시드 그대로다. 그래서 **본문 자체**를 본다: 구획마다 그 구획의 칸이 빠짐없이, 서버 값 그대로 나갔는가.
    const expectedKeys: string[][] = [
      [
        "business_reg_no",
        "organization_name_ko",
        "organization_name_en",
        "representative_name_ko",
        "representative_name_en",
        "company_email",
        "main_tel",
        "fax",
        "zip_code",
        "address_ko",
        "address_detail",
        "address_en",
        "business_type",
        "business_item",
        "attendees",
      ],
      ["intro_ko", "intro_en", "website", "annual_sales_range", "employee_range", "available_languages"],
      ["products", "exhibition_categories", "content_category"],
      ["preferred_buyer_countries", "preferred_buyer_types"],
    ]
    const server = EXHIBITOR_API as unknown as Record<string, unknown>
    bodies.forEach((body, index) => {
      expect(Object.keys(body).sort()).toEqual([...expectedKeys[index]].sort())
      for (const [key, value] of Object.entries(body)) expect(value).toEqual(server[key])
    })
  })

  it("담당자 3명·제품 3개·분야 3개·선호 국가/구분·상담 가능 언어를 전부, 숨은 칸까지 실어 보낸다", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    await client.saveStep(1, stepSavePayload(loaded.profile, 1), loaded)
    await client.saveStep(2, stepSavePayload(loaded.profile, 2), loaded)
    await client.saveStep(3, stepSavePayload(loaded.profile, 3), loaded)
    await client.saveStep(4, stepSavePayload(loaded.profile, 4), loaded)
    const [step1, step2, step3, step4] = bodies

    // 폼은 담당자의 이름·직책·이메일·휴대폰만 보여 주지만, 성·부서·영문 직책·메신저·언어도 그대로 돌아간다.
    expect(step1.attendees).toEqual(EXHIBITOR_API.attendees)
    expect(step2.available_languages).toEqual(["en", "vi"])
    // 제품의 구 카테고리·HS 설명·영문 사양도 폼에 없는 칸이다.
    expect(step3.products).toEqual(EXHIBITOR_API.products)
    expect(step3.exhibition_categories).toEqual([
      "content_production",
      "game_production",
      "webtoon_production",
    ])
    expect(step3.content_category).toBe("broadcasting")
    expect(step4.preferred_buyer_countries).toEqual(["vietnam", "thailand", "indonesia"])
    expect(step4.preferred_buyer_types).toEqual(["media", "private_commercial"])
  })

  it("한 명만 고쳐도 나머지 담당자가 본문에 그대로 남는다(전체 교체에 일부만 보내지 않는다)", async () => {
    const { transport, bodies, inner } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: false })
    const loaded = await client.getProfile()

    const attendees = (loaded.profile.attendees ?? []).map((a, i) =>
      i === 1 ? { ...a, titleKo: "수석 매니저" } : a,
    )
    const next = await client.saveStep(
      1,
      stepSavePayload({ ...loaded.profile, attendees }, 1),
      loaded,
    )

    const sent = bodies[0].attendees as Record<string, unknown>[]
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual(EXHIBITOR_API.attendees?.[0])
    expect(sent[1]).toEqual({ ...EXHIBITOR_API.attendees?.[1], title_ko: "수석 매니저" })
    expect(sent[2]).toEqual(EXHIBITOR_API.attendees?.[2])
    // 화면은 서버 응답으로 갱신된다.
    expect(next.profile.attendees?.[1].titleKo).toBe("수석 매니저")
    expect((await inner.getDetail()).detail.exhibitor_profile?.attendees).toHaveLength(3)
  })

  it("거의 빈 프로필(미입력 null·빈 목록)도 그대로 저장하면 빈 채로 남는다(값을 지어내지 않는다)", async () => {
    const sparse: ApiExhibitorProfile = {
      org_event_role_id: "role-ex",
      application_status: "submitted",
      organization_name_ko: "빈값기업",
      organization_name_en: null,
      business_reg_no: null,
      website: null,
      intro_ko: null,
      annual_sales_range: null,
      content_category: null,
      booth_count: null,
      available_languages: [],
      org_types: [],
      exhibition_categories: [],
      products: [],
      preferred_buyer_countries: [],
      preferred_buyer_types: [],
      unavailable_meeting_slots: [],
      attendees: [],
    }
    const { transport, bodies, inner } = recording(detailOf({ exhibitor_profile: sparse }))
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    for (const step of [1, 2, 3, 4] as EditableStep[]) {
      await client.saveStep(step, stepSavePayload(loaded.profile, step), loaded)
    }

    // 스칼라는 하나도 실리지 않는다(기업명만 원래 값 그대로) — 빈 칸에 ""나 null을 새로 쓰지 않는다.
    expect(bodies[0]).toEqual({ organization_name_ko: "빈값기업", attendees: [] })
    expect(bodies[1]).toEqual({ available_languages: [] })
    expect(bodies[2]).toEqual({ products: [], exhibition_categories: [] })
    expect(bodies[3]).toEqual({ preferred_buyer_countries: [], preferred_buyer_types: [] })
    expect((await inner.getDetail()).detail.exhibitor_profile).toEqual(sparse)
  })

  it("구획 저장 본문에는 미팅 불가 시간이 없다(프로필 PATCH가 받지 않는다 — 422)", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()
    await client.saveStep(4, stepSavePayload(loaded.profile, 4), loaded)
    expect(bodies[0]).not.toHaveProperty("unavailable_meeting_slots")
  })
})

describe("운영자 신청서 어댑터 — 바이어 왕복 무손실", () => {
  it("읽은 값을 그대로 저장해도 구분 3개·관심분야 3개가 유지되고 서버 프로필이 바뀌지 않는다", async () => {
    const { transport, bodies, inner } = recording(buyerDetail())
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    await client.saveStep(1, buyerStepPatch(1, loaded.draft), loaded)
    await client.saveStep(2, buyerStepPatch(2, loaded.draft), loaded)

    expect(bodies[0].org_types).toEqual(["media", "private_commercial", "exhibition_agent"])
    expect(bodies[1].interest_categories).toEqual([
      "animation_distribution",
      "content_production",
      "music_platform",
    ])
    // 가짜 서버는 본문의 키만 덮어쓴다 — 저장소가 그대로라는 것만으로는 "보냈다"가 증명되지 않는다.
    // 본문에 그 구획의 칸이 빠짐없이, 서버 값 그대로 실렸는지 본다.
    const expectedKeys: string[][] = [
      [
        "contact_name_ko",
        "contact_name_en",
        "contact_title_ko",
        "contact_title_en",
        "contact_email",
        "contact_language",
        "contact_interpreter_need",
        "organization_name_ko",
        "organization_name_en",
        "country",
        "tel",
        "org_types",
        "annual_sales_range",
        "employee_range",
      ],
      ["interest_categories", "company_intro_ko", "company_intro_en", "budget_range", "adoption_timeline"],
    ]
    const server = BUYER_API as unknown as Record<string, unknown>
    bodies.forEach((body, index) => {
      expect(Object.keys(body).sort()).toEqual([...expectedKeys[index]].sort())
      for (const [key, value] of Object.entries(body)) expect(value).toEqual(server[key])
    })
    // 폼에 없는 목록(참석자·추천 바이어)은 본문에 싣지 않는다 — 서버 값을 건드리지 않는다.
    for (const body of bodies) {
      expect(body).not.toHaveProperty("attendees")
      expect(body).not.toHaveProperty("recommended_buyers")
    }
    expect((await inner.getDetail()).detail.buyer_profile).toEqual(BUYER_API)
  })

  it("거의 빈 신청서도 그대로 저장하면 빈 채로 남는다(통역 필요 미응답 null을 false로 바꾸지 않는다)", async () => {
    const sparse: ApiBuyerProfile = {
      org_event_role_id: "role-by",
      application_status: "submitted",
      organization_name_ko: null,
      organization_name_en: "Sparse Buyer",
      contact_name_en: "A",
      contact_interpreter_need: null,
      annual_sales_range: null,
      org_types: [],
      interest_categories: [],
      attendees: [],
      recommended_buyers: [],
    }
    const seed = buyerDetail()
    seed.buyer_profile = sparse
    const { transport, bodies, inner } = recording(seed)
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    await client.saveStep(1, buyerStepPatch(1, loaded.draft), loaded)
    await client.saveStep(2, buyerStepPatch(2, loaded.draft), loaded)

    expect(bodies[0]).toEqual({
      contact_name_en: "A",
      contact_interpreter_need: null,
      organization_name_en: "Sparse Buyer",
      org_types: [],
    })
    expect(bodies[1]).toEqual({ interest_categories: [] })
    expect((await inner.getDetail()).detail.buyer_profile).toEqual(sparse)
  })

  it("운영자 전용 항목(사업자등록번호·웹사이트·주소)을 저장하고 서버 응답으로 갱신한다", async () => {
    const { transport, bodies } = recording(buyerDetail())
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    const next = await client.saveOperatorFields(
      { businessRegNo: " VN-0002 ", website: "", address1: "2 Trang Tien" },
      loaded,
    )

    // 공백은 떼고, 비운 칸은 null(지움)로 간다. 넘기지 않은 칸(address2)은 본문에 없다.
    expect(bodies[0]).toEqual({ business_reg_no: "VN-0002", website: null, address1: "2 Trang Tien" })
    expect(next.draft.businessRegNo).toBe("VN-0002")
    expect(next.draft.website).toBe("")
    expect(next.draft.address2).toBe("Floor 3")
  })
})

describe("운영자 신청서 어댑터 — 부스는 master 전용", () => {
  it("sub의 본문에는 어떤 경로로도 부스 키가 들어가지 않는다", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: false })
    const loaded = await client.getProfile()

    // ① 구획 저장 — 드래프트가 부스 값을 들고 있어도 본문에는 없다.
    for (const step of [1, 2, 3, 4] as EditableStep[]) {
      await client.saveStep(step, stepSavePayload(loaded.profile, step), loaded)
    }
    // ② 페이로드 정리를 거치지 않은 드래프트 전체를 실수로 넘겨도 걸러진다.
    await client.saveStep(1, { ...loaded.profile, hall: "9", boothLocation: "Z-99" }, loaded)
    // ③ 운영자 전용 항목에 부스를 섞어 보내도 기업명만 나간다.
    await client.saveOperatorFields(
      {
        organizationNameKo: "픽셀아츠",
        hall: "9",
        pavilion: "다른관",
        boothLocation: "Z-99",
        boothType: "조립부스",
        boothCount: 9,
      },
      loaded,
    )

    expect(bodies).toHaveLength(6)
    for (const body of bodies) {
      for (const key of BOOTH_BODY_KEYS) expect(body).not.toHaveProperty(key)
    }
    expect(bodies[5]).toEqual({ organization_name_ko: "픽셀아츠" })
  })

  it("master는 운영자 전용 항목으로 부스 다섯 칸을 저장한다(지움 포함)", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    const next = await client.saveOperatorFields(
      { hall: "8", pavilion: "", boothLocation: "B-01", boothType: "조립부스", boothCount: null },
      loaded,
    )

    expect(bodies[0]).toEqual({
      booth_hall: "8",
      booth_pavilion: null,
      booth_location: "B-01",
      booth_type: "조립부스",
      booth_count: null,
    })
    expect(next.profile.hall).toBe("8")
    expect(next.profile.pavilion).toBeUndefined()
    expect(next.profile.boothCount).toBeUndefined()
  })

  it("master라도 구획 저장으로는 부스를 보내지 않는다(스텝 다이얼로그는 부스를 고칠 수 없다)", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()
    await client.saveStep(1, { ...loaded.profile, hall: "9" }, loaded)
    for (const key of BOOTH_BODY_KEYS) expect(bodies[0]).not.toHaveProperty(key)
  })
})

describe("운영자 신청서 어댑터 — 값 지우기", () => {
  it("참가사: 서버에 값이 있는데 폼에서 비운 칸은 null로 보낸다(텍스트·선택 칸 모두)", async () => {
    const { transport, bodies, inner } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    // 텍스트는 ""로, 선택 칸은 undefined로 비워진다(참가자 폼의 실제 값 모양).
    const edited = { ...loaded.profile, website: "", annualSalesRange: undefined }
    const next = await client.saveStep(2, stepSavePayload(edited, 2), loaded)

    expect(bodies[0].website).toBeNull()
    expect(bodies[0].annual_sales_range).toBeNull()
    // 손대지 않은 칸은 그대로.
    expect(bodies[0].employee_range).toBe("e_11_50")
    expect(next.profile.website).toBeUndefined()
    expect(next.profile.annualSalesRange).toBeUndefined()
    const stored = (await inner.getDetail()).detail.exhibitor_profile
    expect(stored?.website).toBeNull()
    expect(stored?.intro_ko).toBe(EXHIBITOR_API.intro_ko)
  })

  it("바이어: 참가자 매핑이 빼던 빈 문자열도 서버 값이 있으면 null로 지운다", async () => {
    const { transport, bodies } = recording(buyerDetail())
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    const edited = { ...loaded.draft, contactTitleKo: "", annualSalesRange: "" as const }
    const next = await client.saveStep(1, buyerStepPatch(1, edited), loaded)

    expect(bodies[0].contact_title_ko).toBeNull()
    expect(bodies[0].annual_sales_range).toBeNull()
    expect(bodies[0].contact_title_en).toBe("Purchasing Director")
    expect(next.draft.contactTitleKo).toBe("")
    expect(next.draft.annualSalesRange).toBe("")
  })

  it("원래 비어 있던 칸은 지움으로 바꾸지 않는다(null을 지어내지 않는다)", async () => {
    const seed = buyerDetail()
    seed.buyer_profile = { ...BUYER_API, contact_title_ko: null, annual_sales_range: null }
    const { transport, bodies } = recording(seed)
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    await client.saveStep(1, buyerStepPatch(1, loaded.draft), loaded)

    expect(bodies[0]).not.toHaveProperty("contact_title_ko")
    expect(bodies[0]).not.toHaveProperty("annual_sales_range")
  })
})

// 지움을 열어 준 대가로 생긴 위험 하나를 막는다 — 있던 기업명을 둘 다 지우면 이름 없는 기업이 된다.
describe("운영자 신청서 어댑터 — 기업명은 둘 다 지울 수 없다", () => {
  it("참가사: 국문·영문을 모두 비운 저장은 보내지 않고 name_required로 실패한다", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    await expect(
      client.saveOperatorFields({ organizationNameKo: "", organizationNameEn: " " }, loaded),
    ).rejects.toMatchObject({ status: 422, code: "name_required" })
    expect(bodies).toHaveLength(0)
  })

  it("참가사: 하나만 지우는 것은 된다(영문명만 남기기) — 남은 이름이 없어지는 두 번째 지움은 막는다", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    const next = await client.saveOperatorFields({ organizationNameKo: "" }, loaded)
    expect(bodies[0]).toEqual({ organization_name_ko: null })
    expect(next.profile.organizationNameEn).toBe(EXHIBITOR_API.organization_name_en)

    // 이제 영문명 하나만 남았다 — 그것마저 지우는 저장은 보내지 않는다(다이얼로그를 다시 연 기준 = next).
    await expect(
      client.saveOperatorFields({ organizationNameEn: "" }, next),
    ).rejects.toMatchObject({ code: "name_required" })
    expect(bodies).toHaveLength(1)
  })

  it("참가사: 기본정보 구획 저장이 기업명을 둘 다 비워 보내려 하면 막는다(바이어 경로와 같은 규칙)", async () => {
    const { transport, bodies } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    // 화면에서는 기업명이 읽기 전용이라 지금은 이런 페이로드가 나오지 않는다 — 폼이 바뀌어도 규칙은 남는다.
    const blanked = { ...loaded.profile, organizationNameKo: "", organizationNameEn: "" }
    await expect(client.saveStep(1, stepSavePayload(blanked, 1), loaded)).rejects.toMatchObject({
      status: 422,
      code: "name_required",
    })
    expect(bodies).toHaveLength(0)

    // 기업명을 건드리지 않는 구획(회사소개)은 영향이 없다.
    await client.saveStep(2, stepSavePayload(loaded.profile, 2), loaded)
    expect(bodies).toHaveLength(1)
  })

  it("바이어: 기본정보 구획에서 소속(국문·영문)을 모두 비운 저장은 보내지 않는다", async () => {
    const { transport, bodies } = recording(buyerDetail())
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    const blanked = { ...loaded.draft, organizationNameKo: "", organizationNameEn: "" }
    await expect(client.saveStep(1, buyerStepPatch(1, blanked), loaded)).rejects.toMatchObject({
      status: 422,
      code: "name_required",
    })
    expect(bodies).toHaveLength(0)

    // 하나만 비우는 것은 된다.
    const next = await client.saveStep(
      1,
      buyerStepPatch(1, { ...loaded.draft, organizationNameKo: "" }),
      loaded,
    )
    expect(bodies[0].organization_name_ko).toBeNull()
    expect(next.draft.organizationNameEn).toBe(BUYER_API.organization_name_en)
  })

  it("원래부터 이름이 없던 기업은 막지 않는다(필수 누락으로 저장을 막지 않는다)", async () => {
    const seed = buyerDetail()
    seed.buyer_profile = { ...BUYER_API, organization_name_ko: null, organization_name_en: null }
    const { transport, bodies } = recording(seed)
    const client = createOperatorBuyerClient(transport)
    const loaded = await client.getProfile()

    await client.saveStep(
      1,
      buyerStepPatch(1, { ...loaded.draft, contactTitleKo: "구매 이사" }),
      loaded,
    )

    expect(bodies).toHaveLength(1)
    expect(bodies[0].contact_title_ko).toBe("구매 이사")
  })
})

describe("운영자 신청서 어댑터 — 서버가 정본", () => {
  it("저장 결과는 보낸 값이 아니라 서버 응답으로 만든다(상태 포함)", async () => {
    const inner = createMockOperatorTransport(detailOf())
    const transport: OperatorApplicationTransport = {
      getDetail: () => inner.getDetail(),
      // 서버가 값을 다듬어 돌려준 상황 — 화면은 보낸 값이 아니라 이 응답을 보여야 한다.
      async patchProfile() {
        return { ...EXHIBITOR_API, intro_ko: "서버가 저장한 값", application_status: "approved" }
      },
      patchUnavailableSlots: (slots) => inner.patchUnavailableSlots(slots),
    }
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    const next = await client.saveStep(
      2,
      stepSavePayload({ ...loaded.profile, introKo: "내가 입력한 값" }, 2),
      loaded,
    )

    expect(next.profile.introKo).toBe("서버가 저장한 값")
    expect(next.status).toBe("approved")
  })

  it("저장이 실패하면 그대로 던지고, 다음 저장의 기준값도 옛 서버 값 그대로다", async () => {
    const { transport, bodies } = recording(detailOf())
    let fail = true
    const flaky: OperatorApplicationTransport = {
      ...transport,
      async patchProfile(role, body) {
        if (fail) throw new OperatorRequestError(403, "이 바이어는 관할 밖입니다")
        return transport.patchProfile(role, body)
      },
    }
    const client = createOperatorExhibitorClient(flaky, { canAssignBooth: true })
    const loaded = await client.getProfile()
    const edited = stepSavePayload({ ...loaded.profile, website: "" }, 2)

    const error = await client.saveStep(2, edited, loaded).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OperatorRequestError)
    expect(isOperatorForbidden(error)).toBe(true)
    expect(bodies).toHaveLength(0)

    // 재시도 — 실패가 기준값을 바꾸지 않았으므로 여전히 "서버에 값이 있다 → 지움"으로 판정한다.
    fail = false
    await client.saveStep(2, edited, loaded)
    expect(bodies[0].website).toBeNull()
  })

  it("미팅 불가 시간은 전용 엔드포인트로 전체를 보내고 응답으로 갱신한다", async () => {
    const { transport, bodies, slotCalls } = recording(detailOf())
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    const next = await client.saveUnavailableSlots(["2026-10-22T11:00", "2026-10-20T10:00"], loaded)

    expect(slotCalls).toEqual([["2026-10-20T10:00", "2026-10-22T11:00"]])
    expect(bodies).toHaveLength(0)
    expect(next.profile.unavailableMeetingSlots).toEqual(["2026-10-20T10:00", "2026-10-22T11:00"])
  })

  it("행의 역할과 서버 프로필이 어긋나면(역할 전환) 다른 역할의 값으로 채우지 않고 실패한다", async () => {
    const asExhibitor = createOperatorApplicationClient(
      "exhibitor",
      createMockOperatorTransport(buyerDetail()),
      { canAssignBooth: true },
    )
    await expect(asExhibitor.getProfile()).rejects.toMatchObject({ status: 409, code: "role_mismatch" })

    const asBuyer = createOperatorApplicationClient(
      "buyer",
      createMockOperatorTransport(detailOf()),
      { canAssignBooth: true },
    )
    await expect(asBuyer.getProfile()).rejects.toMatchObject({ status: 409, code: "role_mismatch" })
  })
})

// 동시 수정 — 패널을 열어 둔 사이 다른 운영자·참가자가 바꾼 것을, 열 때의 값에서 출발한 저장이 지우지 못한다.
// 서버 한 대(변경 가능한 인메모리 저장소)에 **독립 클라이언트 둘**을 붙여 본다: A가 읽고, B가 바꾸고, A가 저장.
describe("운영자 신청서 어댑터 — 동시 수정(열어 둔 사이 다른 곳에서 바뀜)", () => {
  // 같은 서버를 보는 연결 하나 — 연결마다 나간 PATCH 본문·불가 시간 저장을 따로 적는다.
  function connect(server: OperatorApplicationTransport) {
    const bodies: Record<string, unknown>[] = []
    const slotCalls: string[][] = []
    const transport: OperatorApplicationTransport = {
      getDetail: () => server.getDetail(),
      async patchProfile(role, body) {
        bodies.push(wire(body))
        return server.patchProfile(role, wire(body))
      },
      async patchUnavailableSlots(slots) {
        slotCalls.push(slots)
        return server.patchUnavailableSlots(slots)
      },
    }
    return { transport, bodies, slotCalls }
  }

  function twoExhibitorClients() {
    const server = createMockOperatorTransport(detailOf())
    const a = connect(server)
    const b = connect(server)
    return {
      server,
      a: { ...a, client: createOperatorExhibitorClient(a.transport, { canAssignBooth: true }) },
      b: { ...b, client: createOperatorExhibitorClient(b.transport, { canAssignBooth: true }) },
    }
  }

  const NEW_PRODUCT = { nameKo: "B가 추가한 제품", nameEn: "Added by B" }

  it("제품: B가 추가한 뒤 A가 같은 구획을 저장하면 거부되고, B의 추가분이 서버에 남는다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()

    // B(다른 운영자·참가자)가 제품을 하나 추가해 저장한다.
    await b.client.saveStep(
      3,
      stepSavePayload(
        { ...seenByB.profile, products: [...(seenByB.profile.products ?? []), NEW_PRODUCT] },
        3,
      ),
      seenByB,
    )
    expect((await server.getDetail()).detail.exhibitor_profile?.products).toHaveLength(4)

    // A는 열 때의 목록(3개)에서 첫 제품 이름만 고쳐 저장한다 — 보내면 B의 제품이 삭제된다.
    const edited = (seenByA.profile.products ?? []).map((p, i) =>
      i === 0 ? { ...p, nameKo: "A가 고친 이름" } : p,
    )
    const error = await a.client
      .saveStep(3, stepSavePayload({ ...seenByA.profile, products: edited }, 3), seenByA)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(OperatorConflictError)
    expect(isOperatorConflict(error)).toBe(true)
    expect(error).toMatchObject({ status: 409, code: "edit_conflict" })
    // 아무것도 보내지 않았다.
    expect(a.bodies).toHaveLength(0)
    const stored = (await server.getDetail()).detail.exhibitor_profile
    expect(stored?.products).toHaveLength(4)
    expect(stored?.products?.[0].name_ko).toBe("나이트브릿지")
    expect(stored?.products?.[3].name_ko).toBe("B가 추가한 제품")
    // A의 패널이 다시 그릴 최신 스냅샷이 오류에 실려 온다.
    const latest = (error as OperatorConflictError<OperatorExhibitorApplication>).latest
    expect(latest.profile.products).toHaveLength(4)
    expect(latest.profile.products?.[3].nameKo).toBe("B가 추가한 제품")
  })

  it("충돌한 창에서 다시 눌러도 풀리지 않는다 — 닫았다 다시 연 기준(최신 스냅샷)으로만 저장된다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    await b.client.saveStep(
      3,
      stepSavePayload(
        { ...seenByB.profile, products: [...(seenByB.profile.products ?? []), NEW_PRODUCT] },
        3,
      ),
      seenByB,
    )

    const stale = stepSavePayload(seenByA.profile, 3)
    const first = await a.client.saveStep(3, stale, seenByA).catch((e: unknown) => e)
    expect(isOperatorConflict(first)).toBe(true)
    // 같은 창(= 같은 기준)에서 다시 저장 — 여전히 충돌이다. 패널이 최신이 됐다고 옛 입력이 통과하면 안 된다.
    const second = await a.client.saveStep(3, stale, seenByA).catch((e: unknown) => e)
    expect(isOperatorConflict(second)).toBe(true)
    expect(a.bodies).toHaveLength(0)

    // 닫았다 다시 열면 폼이 최신(4개)에서 출발하고 기준도 최신이다 — 이제 저장된다.
    const reopened = (first as OperatorConflictError<OperatorExhibitorApplication>).latest
    const renamed = (reopened.profile.products ?? []).map((p, i) =>
      i === 0 ? { ...p, nameKo: "A가 고친 이름" } : p,
    )
    const next = await a.client.saveStep(
      3,
      stepSavePayload({ ...reopened.profile, products: renamed }, 3),
      reopened,
    )
    expect(a.bodies).toHaveLength(1)
    expect(next.profile.products).toHaveLength(4)
    const stored = (await server.getDetail()).detail.exhibitor_profile?.products
    expect(stored?.map((p) => p.name_ko)).toEqual([
      "A가 고친 이름",
      "픽셀런",
      "스튜디오 다큐",
      "B가 추가한 제품",
    ])
  })

  it("담당자: B가 한 명을 추가하면 A의 기본정보 저장과 담당자 추가 정보 저장이 모두 거부된다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    const added = { firstNameKo: "새담당", email: "new@pixelarts.example" }
    await b.client.saveStep(
      1,
      stepSavePayload(
        { ...seenByB.profile, attendees: [...(seenByB.profile.attendees ?? []), added] },
        1,
      ),
      seenByB,
    )

    const viaStep = await a.client
      .saveStep(1, stepSavePayload({ ...seenByA.profile, fax: "02-999-9999" }, 1), seenByA)
      .catch((e: unknown) => e)
    const viaExtras = await a.client
      .saveAttendees(
        (seenByA.profile.attendees ?? []).map((p) => ({ ...p, tel: "02-111-1111" })),
        seenByA,
      )
      .catch((e: unknown) => e)

    expect(isOperatorConflict(viaStep)).toBe(true)
    expect(isOperatorConflict(viaExtras)).toBe(true)
    expect(a.bodies).toHaveLength(0)
    const stored = (await server.getDetail()).detail.exhibitor_profile
    expect(stored?.attendees).toHaveLength(4)
    expect(stored?.attendees?.[3].first_name_ko).toBe("새담당")
    expect(stored?.fax).toBe(EXHIBITOR_API.fax)
  })

  it("분야·선호 국가/구분·상담 가능 언어: 다른 곳에서 바뀐 목록을 옛 목록으로 되돌리지 않는다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    await b.client.saveStep(
      2,
      stepSavePayload({ ...seenByB.profile, availableLanguages: ["en"] }, 2),
      seenByB,
    )
    const afterStep2 = await b.client.getProfile()
    await b.client.saveStep(
      3,
      stepSavePayload(
        {
          ...afterStep2.profile,
          exhibitionCategories: [...(afterStep2.profile.exhibitionCategories ?? []), "music_production"],
        },
        3,
      ),
      afterStep2,
    )
    const afterStep3 = await b.client.getProfile()
    await b.client.saveStep(
      4,
      stepSavePayload({ ...afterStep3.profile, preferredBuyerCountries: ["vietnam", "japan"] }, 4),
      afterStep3,
    )

    for (const step of [2, 3, 4] as EditableStep[]) {
      const error = await a.client
        .saveStep(step, stepSavePayload(seenByA.profile, step), seenByA)
        .catch((e: unknown) => e)
      expect(isOperatorConflict(error)).toBe(true)
    }
    expect(a.bodies).toHaveLength(0)
    const stored = (await server.getDetail()).detail.exhibitor_profile
    expect(stored?.available_languages).toEqual(["en"])
    expect(stored?.exhibition_categories).toContain("music_production")
    expect(stored?.preferred_buyer_countries).toEqual(["vietnam", "japan"])
  })

  it("스칼라도 같다 — 같은 구획의 다른 칸이 바뀌었으면 옛 값을 되보내지 않는다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    await b.client.saveStep(
      2,
      stepSavePayload({ ...seenByB.profile, introKo: "B가 고친 소개" }, 2),
      seenByB,
    )

    // A는 홈페이지만 고쳤지만, 구획 저장은 소개(국문)도 함께 보낸다 — 열 때의 옛 소개가 되돌아간다.
    const error = await a.client
      .saveStep(2, stepSavePayload({ ...seenByA.profile, website: "https://a.example" }, 2), seenByA)
      .catch((e: unknown) => e)

    expect(isOperatorConflict(error)).toBe(true)
    const stored = (await server.getDetail()).detail.exhibitor_profile
    expect(stored?.intro_ko).toBe("B가 고친 소개")
    expect(stored?.website).toBe(EXHIBITOR_API.website)
  })

  it("다른 구획만 바뀐 경우는 막지 않는다 — 그 구획의 칸만 본다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    // B는 회사소개(2)·타겟(4)·부스·미팅 불가 시간을 바꾼다.
    await b.client.saveStep(2, stepSavePayload({ ...seenByB.profile, introKo: "B의 소개" }, 2), seenByB)
    await b.client.saveStep(
      4,
      stepSavePayload({ ...seenByB.profile, preferredBuyerCountries: ["japan"] }, 4),
      seenByB,
    )
    await b.client.saveOperatorFields({ boothLocation: "B-99" }, seenByB)
    await b.client.saveUnavailableSlots(["2026-10-21T10:00"], seenByB)

    // A는 사업분야(3)와 기업명을 저장한다 — B가 건드린 칸과 겹치지 않으므로 통과한다.
    const renamed = (seenByA.profile.products ?? []).map((p, i) =>
      i === 0 ? { ...p, nameKo: "A가 고친 이름" } : p,
    )
    await a.client.saveStep(3, stepSavePayload({ ...seenByA.profile, products: renamed }, 3), seenByA)
    await a.client.saveOperatorFields({ organizationNameEn: "PixelArts Inc." }, seenByA)

    expect(a.bodies).toHaveLength(2)
    const stored = (await server.getDetail()).detail.exhibitor_profile
    // 둘 다 남는다.
    expect(stored?.products?.[0].name_ko).toBe("A가 고친 이름")
    expect(stored?.organization_name_en).toBe("PixelArts Inc.")
    expect(stored?.intro_ko).toBe("B의 소개")
    expect(stored?.preferred_buyer_countries).toEqual(["japan"])
    expect(stored?.booth_location).toBe("B-99")
    expect(stored?.unavailable_meeting_slots).toEqual(["2026-10-21T10:00"])
  })

  it("운영자 전용 항목(참가사): 실제로 보내는 칸만 견준다 — 옆 칸이 바뀐 것은 막지 않는다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    // B가 국문 기업명과 부스위치를 고쳤다.
    await b.client.saveOperatorFields({ organizationNameKo: "픽셀아츠(주)" }, seenByB)
    const afterName = await b.client.getProfile()
    await b.client.saveOperatorFields({ boothLocation: "B-99" }, afterName)

    // A는 같은 다이얼로그의 **다른 칸**(영문 기업명·부스타입)을 고친다 — 그 칸만 보내므로 통과한다.
    await a.client.saveOperatorFields({ organizationNameEn: "PixelArts Inc." }, seenByA)
    await a.client.saveOperatorFields({ boothType: "조립부스" }, seenByA)
    expect(a.bodies).toEqual([{ organization_name_en: "PixelArts Inc." }, { booth_type: "조립부스" }])

    // 같은 칸을 고치려 하면 충돌이다 — 보내면 B의 값이 사라진다.
    const sameName = await a.client
      .saveOperatorFields({ organizationNameKo: "픽셀아츠 주식회사" }, seenByA)
      .catch((e: unknown) => e)
    const sameBooth = await a.client
      .saveOperatorFields({ boothLocation: "A-01" }, seenByA)
      .catch((e: unknown) => e)
    expect(isOperatorConflict(sameName)).toBe(true)
    expect(isOperatorConflict(sameBooth)).toBe(true)
    expect(a.bodies).toHaveLength(2)

    // 넷 다 남는다 — B의 두 칸도, A의 두 칸도.
    const stored = (await server.getDetail()).detail.exhibitor_profile
    expect(stored?.organization_name_ko).toBe("픽셀아츠(주)")
    expect(stored?.booth_location).toBe("B-99")
    expect(stored?.organization_name_en).toBe("PixelArts Inc.")
    expect(stored?.booth_type).toBe("조립부스")
  })

  it("운영자 전용 항목(참가사): 견주지 않은 옆 칸이 그 사이 비워져 이름이 다 사라지게 되면 막는다", async () => {
    const { a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    await b.client.saveOperatorFields({ organizationNameEn: "" }, seenByB) // B가 영문명을 지웠다

    // A는 국문명을 지우려 한다 — 영문명 칸은 보내지 않아 견주지 않지만, 이름 지킴은 방금 읽은 값으로 본다.
    await expect(
      a.client.saveOperatorFields({ organizationNameKo: "" }, seenByA),
    ).rejects.toMatchObject({ code: "name_required" })
    expect(a.bodies).toHaveLength(0)
  })

  it("운영자 전용 항목(바이어): 웹사이트만 고칠 때 다른 사람이 주소를 바꾼 것은 막지 않고, 같은 칸이면 충돌이다", async () => {
    const server = createMockOperatorTransport(buyerDetail())
    const a = connect(server)
    const b = connect(server)
    const clientA = createOperatorBuyerClient(a.transport)
    const clientB = createOperatorBuyerClient(b.transport)
    const seenByA = await clientA.getProfile()
    const seenByB = await clientB.getProfile()
    await clientB.saveOperatorFields({ address1: "B가 고친 주소" }, seenByB)

    // 웹사이트만 고친다 — 본문에 주소가 없으므로 B의 주소를 덮지 않는다. 저장된다.
    const next = await clientA.saveOperatorFields({ website: "https://a.example" }, seenByA)
    expect(a.bodies).toEqual([{ website: "https://a.example" }])
    expect(next.draft.address1).toBe("B가 고친 주소") // 화면은 응답(최신)으로 다시 그려진다

    // 같은 칸(주소)을 열 때의 값에서 고치려 하면 충돌이다.
    const error = await clientA
      .saveOperatorFields({ address1: "A가 고친 주소" }, seenByA)
      .catch((e: unknown) => e)
    expect(isOperatorConflict(error)).toBe(true)
    expect(a.bodies).toHaveLength(1)
    const stored = (await server.getDetail()).detail.buyer_profile
    expect(stored?.address1).toBe("B가 고친 주소")
    expect(stored?.website).toBe("https://a.example")
  })

  it("미팅 불가 시간: B가 바꾼 뒤 A가 칸을 누르면 저장되지 않고, 최신 목록이 실려 온다", async () => {
    const { server, a, b } = twoExhibitorClients()
    const seenByA = await a.client.getProfile()
    const seenByB = await b.client.getProfile()
    await b.client.saveUnavailableSlots(["2026-10-21T10:00", "2026-10-21T10:30"], seenByB)

    // A의 화면에는 아직 불가 시간이 없다 — 한 칸을 눌러 "전체 = 그 한 칸"을 보내면 B의 두 칸이 사라진다.
    const error = await a.client
      .saveUnavailableSlots(["2026-10-20T09:00"], seenByA)
      .catch((e: unknown) => e)

    expect(isOperatorConflict(error)).toBe(true)
    expect(a.slotCalls).toHaveLength(0)
    expect((await server.getDetail()).detail.exhibitor_profile?.unavailable_meeting_slots).toEqual([
      "2026-10-21T10:00",
      "2026-10-21T10:30",
    ])
    const latest = (error as OperatorConflictError<OperatorExhibitorApplication>).latest
    expect(latest.profile.unavailableMeetingSlots).toEqual(["2026-10-21T10:00", "2026-10-21T10:30"])

    // 최신 격자에서 다시 누르면 저장된다(세 칸).
    const next = await a.client.saveUnavailableSlots(
      ["2026-10-20T09:00", "2026-10-21T10:00", "2026-10-21T10:30"],
      latest,
    )
    expect(next.profile.unavailableMeetingSlots).toHaveLength(3)
  })

  it("바이어: 구분을 다른 곳에서 바꿨으면 옛 목록으로 되돌리지 않는다(다른 구획은 통과)", async () => {
    const server = createMockOperatorTransport(buyerDetail())
    const a = connect(server)
    const b = connect(server)
    const clientA = createOperatorBuyerClient(a.transport)
    const clientB = createOperatorBuyerClient(b.transport)
    const seenByA = await clientA.getProfile()
    const seenByB = await clientB.getProfile()

    await clientB.saveStep(
      1,
      buyerStepPatch(1, { ...seenByB.draft, orgTypes: [...seenByB.draft.orgTypes, "association"] }),
      seenByB,
    )

    const step1 = await clientA
      .saveStep(1, buyerStepPatch(1, { ...seenByA.draft, contactTitleKo: "이사" }), seenByA)
      .catch((e: unknown) => e)
    // 관심분야(2구획)는 B가 건드리지 않았다 — 통과한다.
    await clientA.saveStep(2, buyerStepPatch(2, seenByA.draft), seenByA)

    expect(isOperatorConflict(step1)).toBe(true)
    expect(a.bodies).toHaveLength(1)
    const stored = (await server.getDetail()).detail.buyer_profile
    expect(stored?.org_types).toHaveLength(4)
    expect(stored?.org_types).toContain("association")
    const latest = (step1 as OperatorConflictError<OperatorBuyerApplication>).latest
    expect(latest.draft.orgTypes).toContain("association")
  })

  it("재조회가 실패하면 저장하지 않고 그 실패를 그대로 던진다(충돌이 아니다)", async () => {
    const server = createMockOperatorTransport(detailOf())
    const { transport, bodies } = connect(server)
    let down = false
    const flaky: OperatorApplicationTransport = {
      ...transport,
      async getDetail() {
        if (down) throw new OperatorRequestError(0, "network")
        return transport.getDetail()
      },
    }
    const client = createOperatorExhibitorClient(flaky, { canAssignBooth: true })
    const loaded = await client.getProfile()

    down = true
    const error = await client
      .saveStep(2, stepSavePayload({ ...loaded.profile, website: "https://new.example" }, 2), loaded)
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 0, code: "network" })
    expect(isOperatorConflict(error)).toBe(false)
    expect(bodies).toHaveLength(0)
  })

  it("순서만 다른 코드 목록·빈 값 표기 차이는 변경으로 보지 않는다(헛충돌을 내지 않는다)", async () => {
    const seed = detailOf()
    const server = createMockOperatorTransport(seed)
    const { transport, bodies } = connect(server)
    const client = createOperatorExhibitorClient(transport, { canAssignBooth: true })
    const loaded = await client.getProfile()

    // 서버가 같은 분야를 다른 순서로, 빈 문자열을 null로 돌려주기 시작했다(값은 같다).
    await server.patchProfile("exhibitor", {
      exhibition_categories: ["webtoon_production", "content_production", "game_production"],
      content_category: "broadcasting",
    })

    await client.saveStep(3, stepSavePayload(loaded.profile, 3), loaded)
    expect(bodies).toHaveLength(1)

    expect(sameOperatorValue(["b", "a"], ["a", "b"])).toBe(true)
    expect(sameOperatorValue("", null)).toBe(true)
    expect(sameOperatorValue([], undefined)).toBe(true)
    expect(sameOperatorValue({ a: "", b: "x" }, { b: "x" })).toBe(true)
    // 객체 목록(담당자·제품)은 순서와 내용 전체를 본다.
    expect(sameOperatorValue([{ n: "a" }, { n: "b" }], [{ n: "b" }, { n: "a" }])).toBe(false)
    expect(sameOperatorValue([{ n: "a" }], [{ n: "a" }, { n: "b" }])).toBe(false)
    expect(sameOperatorValue("a", "b")).toBe(false)
  })

  it("패널 밖의 불가 시간 저장(saveUnavailableSlotsChecked)도 화면 기준과 서버가 다르면 보내지 않는다", async () => {
    const server = createMockOperatorTransport(detailOf())
    const { transport, slotCalls } = connect(server)
    const shown: string[] = [] // 대리작성 다이얼로그가 열 때 읽은 목록

    await server.patchUnavailableSlots(["2026-10-21T10:00"]) // 다른 곳에서 바뀜
    const error = await saveUnavailableSlotsChecked(transport, ["2026-10-20T09:00"], shown).catch(
      (e: unknown) => e,
    )
    expect(isOperatorConflict(error)).toBe(true)
    expect((error as OperatorConflictError<string[]>).latest).toEqual(["2026-10-21T10:00"])
    expect(slotCalls).toHaveLength(0)

    // 최신 기준으로 다시 누르면 저장되고, 서버가 확인해 준 목록을 돌려준다.
    const saved = await saveUnavailableSlotsChecked(
      transport,
      ["2026-10-21T10:00", "2026-10-20T09:00"],
      ["2026-10-21T10:00"],
    )
    expect(saved).toEqual(["2026-10-20T09:00", "2026-10-21T10:00"])
    expect(slotCalls).toEqual([["2026-10-20T09:00", "2026-10-21T10:00"]])
  })
})

describe("operatorJson — 같은 출처 BFF 호출", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("FastAPI detail 문자열·코드 객체·BFF error 봉투를 모두 코드로 읽는다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ detail: "이 바이어는 관할 밖입니다" }, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({ detail: { code: "VENUE_IN_USE", message: "사용 중" } }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ success: false, error: "no_event" }, { status: 404 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(operatorJson("GET", "/x")).rejects.toMatchObject({
      status: 403,
      code: "이 바이어는 관할 밖입니다",
    })
    await expect(operatorJson("GET", "/x")).rejects.toMatchObject({ status: 409, code: "VENUE_IN_USE" })
    await expect(operatorJson("GET", "/x")).rejects.toMatchObject({ status: 404, code: "no_event" })
    await expect(operatorJson("GET", "/x")).rejects.toMatchObject({ status: 500, code: "http_500" })
  })

  it("네트워크 단절은 status 0으로 던진다(삼키지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(operatorJson("PATCH", "/x", { a: 1 })).rejects.toMatchObject({
      status: 0,
      code: "network",
    })
  })

  it("본문이 있으면 JSON으로 보내고, 성공 응답을 그대로 돌려준다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(operatorJson("PATCH", "/x", { a: 1 })).resolves.toEqual({ ok: 1 })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("PATCH")
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })
})
