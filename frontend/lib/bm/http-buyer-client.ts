// 바이어 프로필 실 백엔드(FastAPI) 클라이언트 — 같은 출처 BFF(app/api/bm/[[...path]]/route.ts)를
// 상대경로로 호출한다(exhibitor의 http-exhibitor-client.ts와 동일 원칙 — 세션은 httpOnly 쿠키라
// 브라우저가 same-origin 요청에 자동 첨부, 이 클라 코드는 토큰을 직접 만지지 않는다).
//
// 조회(GET)·저장(PATCH steps/1·2)·제출(POST submit)을 배선한다(BM-001 실배선). 백엔드
// BuyerProfileResponse(backend/app/bm/schemas.py)가 신청자 식별(contact_*)·company_intro_ko·
// budget_range·adoption_timeline 컬럼을 갖춘 뒤로는 FE BuyerProfileDraft(lib/apply/types.ts)와
// 완전히 대응한다(과거엔 진부분집합이라 저장을 못 붙였다 — 그 갭은 해소됨).
//
// 경계 매핑: FE camelCase ↔ API snake_case. 저장 가능 단계는 1(기본정보)·2(관심분야·소개)뿐이다
// (lib/apply/types.ts의 BuyerEditableStep 참고 — backend BUYER_STEP_MODELS 1·2와 번호가 그대로
// 대응해 별도 매핑 테이블이 필요 없다).

import { emptyBuyerProfileDraft } from "@/lib/apply/types"
import type {
  BuyerAttendeeDraft,
  BuyerEditableStep,
  BuyerProfileClient,
  BuyerProfileDraft,
  BuyerProfileReadResult,
  BuyerStepPatch,
  RecommendedBuyerDraft,
} from "@/lib/apply/types"
import type { ApplicationStatus } from "@/lib/application-status"

export type { BuyerProfileReadResult }

// ── 백엔드 응답 형상(snake_case, backend/app/bm/schemas.py BuyerProfileResponse) ──────────────
interface ApiBuyerAttendee {
  first_name?: string | null
  last_name?: string | null
  division?: string | null
  job_title?: string | null
  email?: string | null
  tel?: string | null
  mobile?: string | null
  whatsapp_id?: string | null
  messenger_id?: string | null
  languages?: BuyerAttendeeDraft["languages"] | null
  interpreter_need?: boolean | null
  interpreter_languages?: BuyerAttendeeDraft["interpreterLanguages"] | null
}
interface ApiRecommendedBuyer {
  continent?: string | null
  country?: string | null
  organization?: string | null
  person_in_charge?: string | null
  email?: string | null
  tel?: string | null
}
export interface ApiBuyerProfile {
  org_event_role_id: string
  application_status: ApplicationStatus
  organization_name_ko?: string | null
  organization_name_en?: string | null
  business_reg_no?: string | null
  website?: string | null
  contact_name_ko?: string | null
  contact_name_en?: string | null
  contact_title_ko?: string | null
  contact_title_en?: string | null
  contact_email?: string | null
  contact_language?: string | null
  contact_interpreter_need?: boolean | null
  continent?: string | null
  country?: string | null
  city_state?: string | null
  zip_code?: string | null
  address1?: string | null
  address2?: string | null
  tel?: string | null
  last_year_best_buyer?: string | null
  annual_sales_range?: BuyerProfileDraft["annualSalesRange"] | null
  employee_range?: BuyerProfileDraft["employeeRange"] | null
  business_perf_korea_3y?: BuyerProfileDraft["businessPerfKorea3y"] | null
  travelers_korea_3y?: BuyerProfileDraft["travelersKorea3y"] | null
  org_types?: BuyerProfileDraft["orgTypes"] | null
  interest_categories?: BuyerProfileDraft["interestCategories"] | null
  company_intro_ko?: string | null
  company_intro_en?: string | null
  budget_range?: BuyerProfileDraft["budgetRange"] | null
  adoption_timeline?: BuyerProfileDraft["adoptionTimeline"] | null
  note?: string | null
  participation_route?: BuyerProfileDraft["participationRoute"] | null
  new_acquisition_channel?: BuyerProfileDraft["newAcquisitionChannel"] | null
  kst_available_time?: string | null
  attendees?: ApiBuyerAttendee[] | null
  recommended_buyers?: ApiRecommendedBuyer[] | null
}

function fromApiAttendee(a: ApiBuyerAttendee): BuyerAttendeeDraft {
  return {
    firstName: a.first_name ?? "",
    lastName: a.last_name ?? "",
    division: a.division ?? "",
    jobTitle: a.job_title ?? "",
    email: a.email ?? "",
    tel: a.tel ?? "",
    mobile: a.mobile ?? "",
    whatsappId: a.whatsapp_id ?? "",
    messengerId: a.messenger_id ?? "",
    languages: a.languages ?? [],
    interpreterNeed: a.interpreter_need ?? false,
    interpreterLanguages: a.interpreter_languages ?? [],
  }
}

function fromApiRecommended(r: ApiRecommendedBuyer): RecommendedBuyerDraft {
  return {
    continent: r.continent ?? "",
    country: r.country ?? "",
    organization: r.organization ?? "",
    personInCharge: r.person_in_charge ?? "",
    email: r.email ?? "",
    tel: r.tel ?? "",
  }
}

// ApiBuyerProfile(snake) → BuyerProfileDraft(camel, BuyerProfileHub·ApplyForm 계약). 백엔드에
// 없는 값(null/undefined)은 emptyBuyerProfileDraft()의 기본값("" / [] / null)을 그대로 둔다
// (정직하게 비움, undefined 매핑 X).
export function toBuyerProfileDraft(p: ApiBuyerProfile): BuyerProfileDraft {
  return {
    ...emptyBuyerProfileDraft(),
    organizationNameKo: p.organization_name_ko ?? "",
    organizationNameEn: p.organization_name_en ?? "",
    businessRegNo: p.business_reg_no ?? "",
    website: p.website ?? "",
    contactNameKo: p.contact_name_ko ?? "",
    contactNameEn: p.contact_name_en ?? "",
    contactTitleKo: p.contact_title_ko ?? "",
    contactTitleEn: p.contact_title_en ?? "",
    contactEmail: p.contact_email ?? "",
    contactLanguage: (p.contact_language as BuyerProfileDraft["contactLanguage"]) ?? "",
    contactInterpreterNeed: p.contact_interpreter_need ?? null,
    continent: p.continent ?? "",
    country: p.country ?? "",
    cityState: p.city_state ?? "",
    zipCode: p.zip_code ?? "",
    address1: p.address1 ?? "",
    address2: p.address2 ?? "",
    tel: p.tel ?? "",
    lastYearBestBuyer: p.last_year_best_buyer ?? "",
    annualSalesRange: p.annual_sales_range ?? "",
    employeeRange: p.employee_range ?? "",
    businessPerfKorea3y: p.business_perf_korea_3y ?? "",
    travelersKorea3y: p.travelers_korea_3y ?? "",
    orgTypes: p.org_types ?? [],
    interestCategories: p.interest_categories ?? [],
    companyIntroKo: p.company_intro_ko ?? "",
    companyIntroEn: p.company_intro_en ?? "",
    budgetRange: p.budget_range ?? "",
    adoptionTimeline: p.adoption_timeline ?? "",
    note: p.note ?? "",
    participationRoute: p.participation_route ?? "",
    newAcquisitionChannel: p.new_acquisition_channel ?? "",
    kstAvailableTime: p.kst_available_time ?? "",
    attendees: (p.attendees ?? []).map(fromApiAttendee),
    recommendedBuyers: (p.recommended_buyers ?? []).map(fromApiRecommended),
  }
}

// ── camelCase(FE) → snake_case(API) — PATCH/제출 바디. 제공된 키만 담는다(부분 저장). ─────────
const CAMEL_TO_SNAKE: Record<string, string> = {
  organizationNameKo: "organization_name_ko",
  organizationNameEn: "organization_name_en",
  businessRegNo: "business_reg_no",
  website: "website",
  contactNameKo: "contact_name_ko",
  contactNameEn: "contact_name_en",
  contactTitleKo: "contact_title_ko",
  contactTitleEn: "contact_title_en",
  contactEmail: "contact_email",
  contactLanguage: "contact_language",
  contactInterpreterNeed: "contact_interpreter_need",
  continent: "continent",
  country: "country",
  cityState: "city_state",
  zipCode: "zip_code",
  address1: "address1",
  address2: "address2",
  tel: "tel",
  lastYearBestBuyer: "last_year_best_buyer",
  annualSalesRange: "annual_sales_range",
  employeeRange: "employee_range",
  businessPerfKorea3y: "business_perf_korea_3y",
  travelersKorea3y: "travelers_korea_3y",
  orgTypes: "org_types",
  interestCategories: "interest_categories",
  companyIntroKo: "company_intro_ko",
  companyIntroEn: "company_intro_en",
  budgetRange: "budget_range",
  adoptionTimeline: "adoption_timeline",
  note: "note",
  participationRoute: "participation_route",
  newAcquisitionChannel: "new_acquisition_channel",
  kstAvailableTime: "kst_available_time",
}

function toApiAttendee(a: BuyerAttendeeDraft): ApiBuyerAttendee {
  return {
    first_name: a.firstName,
    last_name: a.lastName,
    division: a.division,
    job_title: a.jobTitle,
    email: a.email,
    tel: a.tel,
    mobile: a.mobile,
    whatsapp_id: a.whatsappId,
    messenger_id: a.messengerId,
    languages: a.languages,
    interpreter_need: a.interpreterNeed,
    interpreter_languages: a.interpreterLanguages,
  }
}

function toApiRecommended(r: RecommendedBuyerDraft): ApiRecommendedBuyer {
  return {
    continent: r.continent,
    country: r.country,
    organization: r.organization,
    person_in_charge: r.personInCharge,
    email: r.email,
    tel: r.tel,
  }
}

// exported so server-side route handlers (app/api/buyer-profile, app/api/buyer-apply) can build the
// same snake_case body when proxying a real session straight to the backend without going through fetch.
export function toApiBody(patch: BuyerStepPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    // "" 는 스킵(undefined와 동일 취급) — RHF 폼이 useForm({defaultValues: emptyBuyerProfileDraft()})로
    // 모든 필드를 "" 기본값으로 채워 시작하므로(exhibitor 폼의 useForm({defaultValues:{}})과 달리
    // 미입력 필드가 undefined가 아니다), 손대지 않은 select 필드(annualSalesRange 등)까지 매 단계
    // PATCH에 실려 백엔드 Literal[...] | None 검증에서 422가 난다(빈 문자열은 그 Literal의 유효값이
    // 아님). ""를 생략하면 exhibitor와 동일한 "미제공=그 필드 불변" 부분저장 의미가 된다 — 명시적
    // 비우기는 목록 필드([] = 비우기, service._apply_buyer_fields)로만 가능(스칼라 텍스트 필드를
    // ""로 명시 비우는 건 이 경계에서 지원하지 않는다, 기존 폼 UX도 텍스트 필드 초기화 액션이 없다).
    if (value === undefined || value === "") continue
    if (key === "attendees") {
      body.attendees = (value as BuyerAttendeeDraft[]).map(toApiAttendee)
    } else if (key === "recommendedBuyers") {
      body.recommended_buyers = (value as RecommendedBuyerDraft[]).map(toApiRecommended)
    } else if (CAMEL_TO_SNAKE[key]) {
      body[CAMEL_TO_SNAKE[key]] = value
    }
  }
  return body
}

// GET /api/bm/buyer/{org_event_role_id} — BFF(app/api/bm/[[...path]]/route.ts) 경유 상대경로.
// 인증(Authorization)은 BFF가 세션 쿠키에서 붙인다 — 이 함수는 토큰을 모른다.
export async function fetchBuyerProfile(orgEventRoleId: string): Promise<BuyerProfileReadResult> {
  const res = await fetch(`/api/bm/buyer/${orgEventRoleId}`)
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as ApiBuyerProfile
  return { draft: toBuyerProfileDraft(data), status: data.application_status }
}

export function createHttpBuyerClient(): BuyerProfileClient {
  const jsonHeaders = { "Content-Type": "application/json" }

  async function req(path: string, init?: RequestInit): Promise<ApiBuyerProfile> {
    const res = await fetch(`/api/bm/buyer${path}`, init)
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as ApiBuyerProfile
  }

  return {
    async getProfile(orgEventRoleId) {
      return fetchBuyerProfile(orgEventRoleId)
    },
    async saveStep(orgEventRoleId, step: BuyerEditableStep, patch) {
      const data = await req(`/${orgEventRoleId}/steps/${step}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify(toApiBody(patch)),
      })
      return { draft: toBuyerProfileDraft(data), status: data.application_status }
    },
    async submit(orgEventRoleId, patch) {
      const data = await req(`/${orgEventRoleId}/submit`, {
        method: "POST",
        headers: jsonHeaders,
        body: patch ? JSON.stringify(toApiBody(patch)) : undefined,
      })
      return { draft: toBuyerProfileDraft(data), status: data.application_status }
    },
  }
}
