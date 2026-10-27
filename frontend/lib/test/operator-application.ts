// 운영자 신청서 편집(components/operator/application-panel) 테스트 픽스처 — 패널·두 콘솔 테스트가 같이 쓴다.
// 값은 전부 지어낸 것이다(실 참가사 데이터 아님).
//
// recordingTransport는 인메모리 전송(lib/operator/mock-transport)을 감싸 PATCH 본문을 기록하고, 원하는
// 요청을 실패시킨다 — 화면 조작이 "서버로 무엇을 보냈는가"와 "실패했을 때 화면이 어떻게 남는가"를 본다.
import {
  OperatorRequestError,
  type ApiBuyerProfile,
  type ApiExhibitorProfile,
  type OperatorApplicationTransport,
  type OperatorOrgDetailApi,
} from "@/lib/operator/application-client"
import { createMockOperatorTransport } from "@/lib/operator/mock-transport"
import type { UnavailableSlotGrid } from "@/lib/operator/slot-grid"

export const TEST_SLOT_GRID: UnavailableSlotGrid = {
  dateIds: ["2026-10-20", "2026-10-21"],
  times: ["10:00", "11:00"],
}

export const TEST_EXHIBITOR_PROFILE = {
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
  company_email: "hello@pixelarts.example",
  main_tel: "02-000-0000",
  address_ko: "서울특별시 마포구 양화로 45",
  website: "https://pixelarts.example",
  annual_sales_range: "krw_10_50",
  employee_range: "e_11_50",
  available_languages: ["en"],
  org_types: [],
  exhibition_categories: ["content_production", "game_production"],
  content_category: "broadcasting",
  products: [
    {
      name_ko: "나이트브릿지",
      name_en: "Night Bridge",
      business_field: "webtoon_production",
      category_ko: "웹툰",
      hs_code: "4911.91",
      hs_description: "인쇄물",
      price_range: "krw_10_30m",
    },
    { name_ko: "픽셀런", name_en: "Pixel Run", business_field: "game_production" },
  ],
  intro_ko: "웹툰·게임을 만드는 스튜디오입니다.",
  intro_en: "A studio making webtoons and games.",
  preferred_buyer_countries: ["vietnam", "thailand"],
  preferred_buyer_types: ["media"],
  unavailable_meeting_slots: ["2026-10-20T10:00"],
  attendees: [
    {
      last_name_ko: "김",
      first_name_ko: "민수",
      first_name_en: "Minsu",
      division_ko: "해외사업팀",
      title_ko: "팀장",
      email: "minsu@pixelarts.example",
      tel: "02-000-0002",
      mobile: "010-0000-0002",
      languages: ["ko", "en"],
    },
    {
      first_name_ko: "서연",
      first_name_en: "Seoyeon",
      title_ko: "매니저",
      email: "seoyeon@pixelarts.example",
      mobile: "010-0000-0003",
    },
  ],
  // recommended_buyers는 넣지 않는다 — 참가사 응답(backend ExhibitorProfileResponse)에 없는 칸이다.
} as unknown as ApiExhibitorProfile

export const TEST_BUYER_PROFILE = {
  org_event_role_id: "role-by",
  application_status: "approved",
  organization_name_ko: "하노이미디어",
  organization_name_en: "Hanoi Media",
  business_reg_no: "VN-0001",
  website: "https://hanoimedia.example",
  contact_name_ko: "응우옌 반 안",
  contact_name_en: "Nguyen Van An",
  contact_title_en: "Purchasing Director",
  contact_email: "an@hanoimedia.example",
  contact_language: "vi",
  contact_interpreter_need: true,
  country: "Vietnam",
  address1: "1 Trang Tien",
  address2: null,
  tel: "+84-24-0000-0000",
  annual_sales_range: "usd_1m_5m",
  employee_range: "e_51_100",
  org_types: ["media", "private_commercial", "exhibition_agent"],
  interest_categories: ["animation_distribution", "content_production"],
  company_intro_en: "A Vietnamese broadcaster and distributor.",
  budget_range: "usd_100k_500k",
  adoption_timeline: "2027_h1",
  participation_route: "re_1_2",
  kst_available_time: "10:00-17:00",
  attendees: [
    {
      first_name: "Linh",
      last_name: "Tran",
      job_title: "Manager",
      email: "linh@hanoimedia.example",
      languages: ["en", "vi"],
      interpreter_need: true,
      interpreter_languages: ["vi"],
    },
  ],
  recommended_buyers: [],
} as unknown as ApiBuyerProfile

export function testExhibitorDetail(
  over: Partial<ApiExhibitorProfile> = {},
  detail: Partial<OperatorOrgDetailApi> = {},
): OperatorOrgDetailApi {
  const profile = { ...structuredClone(TEST_EXHIBITOR_PROFILE), ...over }
  return {
    id: "org-ex",
    org_event_role_id: "role-ex",
    event_id: "event",
    name_ko: profile.organization_name_ko,
    name_en: profile.organization_name_en,
    is_exhibitor: true,
    is_buyer: false,
    application_status: profile.application_status,
    proxy_written_by_organizer_id: null,
    exhibitor_profile: profile,
    buyer_profile: null,
    ...detail,
  }
}

export function testBuyerDetail(
  over: Partial<ApiBuyerProfile> = {},
  detail: Partial<OperatorOrgDetailApi> = {},
): OperatorOrgDetailApi {
  const profile = { ...structuredClone(TEST_BUYER_PROFILE), ...over }
  return {
    id: "org-by",
    org_event_role_id: "role-by",
    event_id: "event",
    name_ko: profile.organization_name_ko,
    name_en: profile.organization_name_en,
    is_exhibitor: false,
    is_buyer: true,
    application_status: profile.application_status,
    proxy_written_by_organizer_id: null,
    exhibitor_profile: null,
    buyer_profile: profile,
    ...detail,
  }
}

export interface RecordingTransport {
  transport: OperatorApplicationTransport
  // 나간 프로필 PATCH 본문(JSON으로 실제 전송되는 모양 — undefined 키는 없다).
  bodies: Record<string, unknown>[]
  // 나간 미팅 불가 시간 저장(전체 목록).
  slotCalls: string[][]
  // 상세 조회 횟수(패널을 열 때마다 서버에서 읽는지 확인용).
  loads: () => number
  // 다음 저장(프로필·불가 시간)을 이 오류로 실패시킨다. null이면 정상.
  failNextSave: (error: OperatorRequestError | Error | null) => void
  // 다음 상세 조회를 이 오류로 실패시킨다(저장 직전 재조회 실패 재현). null이면 정상.
  failNextLoad: (error: OperatorRequestError | Error | null) => void
  // 저장소의 현재 상세(서버 값).
  stored: () => Promise<OperatorOrgDetailApi>
  // 같은 서버에 **다른 곳에서** 쓰는 통로 — 다른 운영자·참가자의 저장을 흉내 낸다(기록·실패 주입·조회 횟수에
  // 잡히지 않는다). 화면을 열어 둔 사이 서버 값이 바뀐 상황을 만들 때 쓴다.
  elsewhere: OperatorApplicationTransport
}

export function recordingTransport(
  seed: OperatorOrgDetailApi,
  slotGrid: UnavailableSlotGrid | null = TEST_SLOT_GRID,
): RecordingTransport {
  const inner = createMockOperatorTransport(seed, slotGrid)
  const bodies: Record<string, unknown>[] = []
  const slotCalls: string[][] = []
  let loadCount = 0
  let failure: OperatorRequestError | Error | null = null
  let loadFailure: OperatorRequestError | Error | null = null
  const takeFailure = () => {
    const error = failure
    failure = null
    return error
  }
  return {
    bodies,
    slotCalls,
    loads: () => loadCount,
    failNextSave: (error) => {
      failure = error
    },
    failNextLoad: (error) => {
      loadFailure = error
    },
    stored: async () => (await inner.getDetail()).detail,
    elsewhere: inner,
    transport: {
      async getDetail() {
        loadCount += 1
        const error = loadFailure
        loadFailure = null
        if (error) throw error
        return inner.getDetail()
      },
      async patchProfile(role, body) {
        const error = takeFailure()
        if (error) throw error
        const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
        bodies.push(wire)
        return inner.patchProfile(role, wire)
      },
      async patchUnavailableSlots(slots) {
        const error = takeFailure()
        if (error) throw error
        slotCalls.push(slots)
        return inner.patchUnavailableSlots(slots)
      },
    },
  }
}
