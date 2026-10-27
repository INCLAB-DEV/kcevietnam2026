import "server-only"

// OP-002/003 참가기업 명단·신청서 조회의 **실연동 구현** — FastAPI `/api/admin/events/{event_id}/
// organizations*`를 서버에서 직접 호출한다(구 organizer 콘솔 전용 GET 엔드포인트는 없다 — 슈퍼어드민
// 조회 계약을 그대로 재사용). 쓰기(OP-003 승인 심사)는 이미 app/api/organizer/members/[memberId]/
// status/route.ts가 이 방식으로 실연동돼 있다 — 이 파일은 그 라우트의 읽기 짝이다.
//
// 실세션 판정: organizer는 lib/auth/http-session.ts의 resolveHttpSession 대상이 **아니다**(그 함수는
// ROLE_COOKIE가 buyer/exhibitor일 때만 실세션으로 본다 — extractRole 주석 참고). organizer 로그인은
// 애초에 ROLE_COOKIE를 쓰지 않으므로, OP-003 상태변경 라우트·OP-005 배정 프록시(backend-proxy.ts)와
// 동일하게 SESSION_COOKIE 존재 여부만으로 실세션을 판정한다(resolveOrganizerToken).
//
// event_id 해석·인증 fetch는 그 두 표면과 완전히 같은 헬퍼를 재사용한다(resolveEventId·backendJson,
// lib/organizer/backend-proxy.ts) — 운영자가 배정된 첫 행사(구 콘솔은 아직 행사 선택 UI가 없는
// 단일 행사 전제, admin 콘솔의 "쿠키 없으면 첫 행사" 폴백과 같은 원칙).
//
// ⚠ 매핑 규약(admin/http-client.ts·discover/http-discover-client.ts와 동일 원칙): 백엔드 응답에
//   있는 필드만 채우고 없는 건 정직하게 비운다. 명단(OrganizationListItem, 2026-09 확장)은 이제
//   exhibitor_profiles/buyer_profiles를 LEFT JOIN해 담당자·전화·이메일·부스·사업분야/관심분야까지
//   한 콜로 채워 준다(N+1 없음 — 백엔드가 배치 조회로 계산, app.admin.service.list_organizations).
//   그래도 에이전트(무역관 실무자)·체류정보·등록주체는 백엔드에 대응 데이터가 없어 여전히 "-"다 —
//   신청서 조회(getMemberProfiles)만 상세를 따로 불러 채운다.

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { OperatorHttpError } from "@/lib/auth/operator-errors"
import { hasApplication } from "@/lib/application-status"
import {
  ADOPTION_TIMELINE_LABELS,
  ANNUAL_SALES_BUYER_LABELS,
  ANNUAL_SALES_SELLER_LABELS,
  BUDGET_RANGE_LABELS,
  BUSINESS_FIELD_LABELS,
  BUYER_COUNTRY_OPTIONS,
  EMPLOYEE_RANGE_LABELS,
  LANGUAGE_LABELS,
  ORG_TYPE_LABELS,
  PARTICIPATION_ROUTE_LABELS,
  PRODUCT_PRICE_RANGE_LABELS,
  labelFor,
  labelsFor,
  labelsForOptions,
} from "@/lib/bm/fields"
import { backendJson, resolveEventId, type ProxyResult } from "./backend-proxy"
import type { ApplicationStatus, MemberRow } from "./members"
import type { MemberProfile, ProfileAttendee, ProfileProduct } from "./member-profile"

// 담당자/참석자 언어(backend list[Lang], 7종: ko/en/zh/ja/ru/vi/other, schemas.py 87·130행) — lib/bm/
// fields의 LANGUAGE_LABELS는 PPT REQ-06A로 참가사 "상담 가능 언어" 입력을 en/vi 2종만 남긴 제한된
// 맵이라 여기(담당자 개개인의 실제 구사 언어) 재사용할 수 없다. components/operator/
// application-operator-sections.tsx의 ATTENDEE_LANGUAGE_OPTIONS와 같은 코드 집합을 로컬로 미러한다
// (코드가 바뀌면 같이 고칠 것).
const ATTENDEE_LANG_LABELS: Record<string, string> = {
  ko: "한국어",
  en: "영어",
  zh: "중국어",
  ja: "일본어",
  ru: "러시아어",
  vi: "베트남어",
  other: "기타",
}

// organizer 실세션 토큰 — SESSION_COOKIE만 본다(위 주석 참고). 없으면 호출부가 mock으로 폴백한다.
export async function resolveOrganizerToken(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(SESSION_COOKIE)?.value ?? null
}

// 401(인증 실패)은 500 페이지가 아니라 재인증으로 흘려보낸다 — http-ops-metrics-client.ts unwrap과
// 동일 원칙(토큰 있음 + 백엔드 거부 → redirect, 토큰 없음 → 호출부가 이미 mock 폴백으로 분기).
function unwrap<T>(result: ProxyResult<T>, context: string): T {
  if (!result.ok) {
    if (result.status === 401) redirect("/login")
    throw new OperatorHttpError(
      result.status,
      `organizer members read failed: ${context} (${result.status} ${result.error})`,
    )
  }
  return result.value
}

// ── 백엔드 응답 형상(snake_case) — GET .../organizations (OrganizationListItem, 2026-09 확장) ──
// 표시용 확장 필드는 전부 optional — 신청서 미제출 기업은 그냥 없는 값이다(지어내지 않는다).
interface OrgListItemSnake {
  id: string
  name_ko?: string | null
  name_en?: string | null
  is_exhibitor: boolean
  is_buyer: boolean
  application_status: ApplicationStatus
  // 공통 — app.admin.service.resolve_primary_contact() 단일 폴백 규칙(엑셀 export와 동일).
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  // 참가사(exhibitor_profiles)
  representative_name_ko?: string | null
  representative_name_en?: string | null
  company_email?: string | null
  main_tel?: string | null
  booth_hall?: string | null
  booth_pavilion?: string | null
  booth_location?: string | null
  booth_type?: string | null
  booth_count?: number | null
  exhibition_categories?: string[]
  match_count?: number
  content_category?: string | null
  // 바이어(buyer_profiles) — 신청자 식별(BM-001 step1)은 이 목록 응답의 원본값 그대로다(공통
  // contact_email과 달리 엑셀 폴백을 거치지 않는다 — "바이어 이름"/"직위" 컬럼 전용 소스).
  contact_name_ko?: string | null
  contact_name_en?: string | null
  contact_title_ko?: string | null
  contact_title_en?: string | null
  contact_language?: string | null
  contact_interpreter_need?: boolean | null
  country?: string | null
  city_state?: string | null
  tel?: string | null
  interest_categories?: string[]
  org_types?: string[]
  buyer_subtype?: string | null
  created_by_organizer_id?: string | null
}

// 바이어 참가 유형 — 명단 "유형" 컬럼(MemberRow.buyerTypeLabel: 초청/사전등록/현장).
// 코드는 organization_event_roles.buyer_subtype(모델 CHECK와 동일 어휘).
const BUYER_SUBTYPE_LABELS: Record<string, string> = {
  hosted: "초청",
  pre_registered: "사전등록",
  on_site: "현장",
}

// 부스(홀·관·번호) — 3단계 신고값을 사람이 읽는 한 문자열로 합친다. 값이 하나도 없으면 undefined
// (화면은 "부스(홀·관·번호)" 한 칸이라 boothLabel || "-" 그대로 통과).
function boothLabelOf(o: OrgListItemSnake): string | undefined {
  return [o.booth_hall, o.booth_pavilion, o.booth_location].filter(Boolean).join(" · ") || undefined
}

export function toMemberRow(o: OrgListItemSnake): MemberRow {
  const isExhibitor = o.is_exhibitor
  return {
    id: o.id,
    name: o.name_ko ?? o.name_en ?? "(이름 없음)",
    nameEn: o.name_en ?? undefined,
    tab: isExhibitor ? "exhibitor" : "buyer",
    applicationStatus: o.application_status,
    // 담당자 표시명 — 참가사는 공통 폴백값(대표자명 → 없으면 백엔드가 이미 계산, 엑셀과 동일 규칙).
    // 바이어는 본인이 신청서에 직접 선언한 성명/직위(contact_name_ko/en·contact_title_ko/en)를
    // 그대로 쓴다 — 공통 폴백은 대표자 개념이 없는 바이어라 대표자명·담당자 목록이 둘 다 없으면
    // 이름을 못 채우는 경우가 실측으로 확인됐다(라이브 DB: 1등회사inc — 담당자 없음).
    primaryContact: isExhibitor ? (o.contact_name ?? null) : (o.contact_name_ko ?? o.contact_name ?? null),
    primaryContactEn: isExhibitor ? undefined : (o.contact_name_en ?? undefined),
    contactTitle: isExhibitor ? undefined : (o.contact_title_ko ?? undefined),
    contactTitleEn: isExhibitor ? undefined : (o.contact_title_en ?? undefined),
    contactPhone: o.contact_phone ?? null,
    contactEmail: o.contact_email ?? null,
    // 사업분야(참가사)/관심분야(바이어) — 코드 배열을 라벨로 변환해 합친다(코드가 그대로 보이면 버그).
    contentCategory: isExhibitor ? o.content_category ?? null : null,
    businessFields: (isExhibitor ? o.exhibition_categories : o.interest_categories) ?? [],
    productCategory:
      labelsFor(BUSINESS_FIELD_LABELS, isExhibitor ? o.exhibition_categories : o.interest_categories).join(
        ", ",
      ) || null,
    mainTel: isExhibitor ? (o.main_tel ?? undefined) : undefined,
    boothLabel: isExhibitor ? boothLabelOf(o) : undefined,
    language: isExhibitor ? undefined : labelFor(LANGUAGE_LABELS, o.contact_language),
    buyerTypeLabel: isExhibitor
      ? undefined
      : labelFor(BUYER_SUBTYPE_LABELS, o.buyer_subtype),
    // 등록 주체 — 운영자가 만든 참가면 그 사실을, 없으면 기업이 스스로 가입한 것이다(운영자
    // 이름까지 보여주려면 Organizer 조인이 필요해 이번엔 구분만 표시한다).
    registeredBy: o.created_by_organizer_id ? "운영자 등록" : "직접 등록",
    importedAt: "",
    profileCompletion: 0,
    matchCount: o.match_count ?? 0,
    lastActivityAt: null,
  }
}

export async function fetchOrganizerMembers(token: string): Promise<MemberRow[]> {
  const eventId = unwrap(await resolveEventId(token), "GET /api/admin/events")
  const members: MemberRow[] = []
  let offset = 0
  for (;;) {
    const data = unwrap(await backendJson<{ items: OrgListItemSnake[]; total?: number }>(
      token, `/api/admin/events/${encodeURIComponent(eventId)}/organizations?limit=100&offset=${offset}`,
    ), "GET .../organizations")
    members.push(...data.items.map(toMemberRow))
    offset += data.items.length
    if (data.items.length < 100 || offset >= (data.total ?? offset)) break
  }
  return members
}

// 단건 조회 — 목록을 한 번 불러 id로 찾는다(명단 규모가 데모 스케일이라 별도 상세 왕복보다 단순).
export async function fetchOrganizerMember(token: string, orgId: string): Promise<MemberRow | null> {
  const members = await fetchOrganizerMembers(token)
  return members.find((m) => m.id === orgId) ?? null
}

// ── 백엔드 응답 형상(snake_case) — GET .../organizations/{id} 상세(BuyerProfileResponse/
// ExhibitorProfileResponse, app/bm/schemas.py) ────────────────────────────────
interface BuyerAttendeeSnake {
  first_name?: string | null
  last_name?: string | null
  division?: string | null
  job_title?: string | null
  email?: string | null
  tel?: string | null
  mobile?: string | null
  languages?: string[] | null
  interpreter_need?: boolean
}

interface ExhibitorAttendeeSnake {
  last_name_ko?: string | null
  last_name_en?: string | null
  first_name_ko?: string | null
  first_name_en?: string | null
  division_ko?: string | null
  title_ko?: string | null
  email?: string | null
  tel?: string | null
  mobile?: string | null
  languages?: string[] | null
}

interface ProductSnake {
  name_ko: string
  name_en?: string | null
  // category_ko는 백엔드 주석상 "(구) 자유텍스트 — business_field로 대체"된 레거시 필드라 보통
  // null — business_field(사업분야 8종 코드)를 우선한다.
  business_field?: string | null
  category_ko?: string | null
  hs_code?: string | null
  hs_description?: string | null
  price_range?: string | null
}

interface BuyerProfileSnake {
  contact_name_ko?: string | null
  contact_name_en?: string | null
  contact_title_ko?: string | null
  contact_title_en?: string | null
  contact_email?: string | null
  contact_language?: string | null
  contact_interpreter_need?: boolean | null
  business_reg_no?: string | null
  website?: string | null
  country?: string | null
  address1?: string | null
  address2?: string | null
  tel?: string | null
  annual_sales_range?: string | null
  employee_range?: string | null
  org_types?: string[]
  interest_categories?: string[]
  company_intro_ko?: string | null
  company_intro_en?: string | null
  budget_range?: string | null
  adoption_timeline?: string | null
  participation_route?: string | null
  kst_available_time?: string | null
  attendees?: BuyerAttendeeSnake[]
}

interface ExhibitorProfileSnake {
  business_reg_no?: string | null
  booth_pavilion?: string | null
  booth_location?: string | null
  booth_type?: string | null
  booth_count?: number | null
  representative_name_ko?: string | null
  representative_name_en?: string | null
  company_email?: string | null
  main_tel?: string | null
  fax?: string | null
  address_ko?: string | null
  address_detail?: string | null
  business_type?: string | null
  business_item?: string | null
  attendees?: ExhibitorAttendeeSnake[]
  intro_ko?: string | null
  intro_en?: string | null
  website?: string | null
  annual_sales_range?: string | null
  employee_range?: string | null
  available_languages?: string[]
  content_category?: string | null
  exhibition_categories?: string[]
  products?: ProductSnake[]
  preferred_buyer_countries?: string[]
  preferred_buyer_types?: string[]
  unavailable_meeting_slots?: string[]
  org_types?: string[]
}

interface OrgDetailSnake {
  id: string
  buyer_profile?: BuyerProfileSnake | null
  exhibitor_profile?: ExhibitorProfileSnake | null
}

function toBuyerAttendee(a: BuyerAttendeeSnake): ProfileAttendee {
  return {
    name: [a.first_name, a.last_name].filter(Boolean).join(" ") || "-",
    division: a.division ?? undefined,
    title: a.job_title ?? undefined,
    email: a.email ?? undefined,
    tel: a.tel ?? undefined,
    mobile: a.mobile ?? undefined,
    languages: labelsFor(ATTENDEE_LANG_LABELS, a.languages).join(", ") || undefined,
    interpreterNeed: a.interpreter_need,
  }
}

function toExhibitorAttendee(a: ExhibitorAttendeeSnake): ProfileAttendee {
  return {
    name: [a.first_name_ko ?? a.first_name_en, a.last_name_ko ?? a.last_name_en].filter(Boolean).join(" ") || "-",
    division: a.division_ko ?? undefined,
    title: a.title_ko ?? undefined,
    email: a.email ?? undefined,
    tel: a.tel ?? undefined,
    mobile: a.mobile ?? undefined,
    languages: labelsFor(ATTENDEE_LANG_LABELS, a.languages).join(", ") || undefined,
  }
}

// category_ko는 "(구) 자유텍스트 — business_field로 대체"된 레거시 필드라 이미 사람이 읽을 텍스트다.
// business_field(사업분야 8종 코드)만 라벨 변환 대상 — 레이블 맵을 거치면 라벨, 없으면 legacy 텍스트.
function toProduct(p: ProductSnake): ProfileProduct {
  return {
    nameKo: p.name_ko,
    nameEn: p.name_en ?? undefined,
    category: p.business_field ? labelFor(BUSINESS_FIELD_LABELS, p.business_field) : (p.category_ko ?? undefined),
    hsCode: p.hs_code ?? undefined,
    hsDescription: p.hs_description ?? undefined,
    priceRange: labelFor(PRODUCT_PRICE_RANGE_LABELS, p.price_range),
  }
}

// 회사가 제출한 B층 신청서(BuyerProfileResponse/ExhibitorProfileResponse) → 콘솔 표시 타입.
// role은 buyer_profile/exhibitor_profile 중 채워진 쪽으로 판정(동시에 둘 다 오지 않는다).
//
// ⚠ 코드→라벨 변환(2026-09-10 수정) — 신청서 조회 모달에 참가자구분·연매출 등이 backend 원시 코드
// (예: "e_51_100")로 그대로 노출되던 버그. 라벨 맵의 권위는 lib/bm/fields — 거기 없는 값(레거시·
// 드리프트)은 labelFor/labelsFor 폴백으로 원문을 그대로 보여준다(데이터 유실 없음).
export function toMemberProfile(detail: OrgDetailSnake): MemberProfile {
  const buyer = detail.buyer_profile
  const exhibitor = detail.exhibitor_profile
  const buyerAttendee = buyer?.attendees?.[0]

  // 연매출 코드 집합은 buyer(USD)·exhibitor(KRW)가 다르다(schemas.py AnnualSalesBuyer vs
  // AnnualSalesSeller) — 어느 프로필이 채워졌는지로 맞는 맵을 고른다(buyer/exhibitor 동시에
  // 채워지지 않는다는 위 전제를 그대로 따른다).
  const annualSalesCode = buyer?.annual_sales_range ?? exhibitor?.annual_sales_range
  const annualSales = buyer
    ? labelFor(ANNUAL_SALES_BUYER_LABELS, annualSalesCode)
    : labelFor(ANNUAL_SALES_SELLER_LABELS, annualSalesCode)

  return {
    businessRegNo: buyer?.business_reg_no ?? exhibitor?.business_reg_no ?? undefined,
    website: buyer?.website ?? exhibitor?.website ?? undefined,

    contactNameKo: buyer?.contact_name_ko ?? undefined,
    contactNameEn: buyer?.contact_name_en ?? undefined,
    contactTitleKo: buyer?.contact_title_ko ?? undefined,
    contactTitleEn: buyer?.contact_title_en ?? undefined,
    contactEmail: buyer?.contact_email ?? undefined,
    contactPhone: buyerAttendee?.tel ?? buyerAttendee?.mobile ?? undefined,
    // contact_language는 backend가 자유텍스트(str)로 둔다(FE Lang 어휘와 backend 상담언어 어휘가
    // 달라서, schemas.py 주석) — 하지만 이 값을 쓰는 유일한 입력(BM-001 step-basic-info)은 en/vi
    // 2종 <select>뿐이라 LANGUAGE_LABELS로 안전 변환된다(그 외 값은 폴백으로 원문 그대로).
    contactLanguage: labelFor(LANGUAGE_LABELS, buyer?.contact_language),
    interpreterNeed: buyer?.contact_interpreter_need ?? undefined,

    country: buyer?.country ?? undefined,
    orgTypes: labelsFor(ORG_TYPE_LABELS, buyer?.org_types ?? exhibitor?.org_types),
    annualSales,
    employeeRange: labelFor(EMPLOYEE_RANGE_LABELS, buyer?.employee_range ?? exhibitor?.employee_range),

    contentCategory: exhibitor?.content_category ?? undefined,
    categories: labelsFor(BUSINESS_FIELD_LABELS, buyer?.interest_categories ?? exhibitor?.exhibition_categories),
    companyIntroKo: buyer?.company_intro_ko ?? exhibitor?.intro_ko ?? undefined,
    companyIntroEn: buyer?.company_intro_en ?? exhibitor?.intro_en ?? undefined,

    budgetRange: labelFor(BUDGET_RANGE_LABELS, buyer?.budget_range),
    adoptionTimeline: labelFor(ADOPTION_TIMELINE_LABELS, buyer?.adoption_timeline),
    kstAvailableTime: buyer?.kst_available_time ?? undefined,
    participationRoute: labelFor(PARTICIPATION_ROUTE_LABELS, buyer?.participation_route),
    attendees: buyer
      ? (buyer.attendees ?? []).map(toBuyerAttendee)
      : exhibitor
        ? (exhibitor.attendees ?? []).map(toExhibitorAttendee)
        : undefined,

    representativeNameKo: exhibitor?.representative_name_ko ?? undefined,
    representativeNameEn: exhibitor?.representative_name_en ?? undefined,
    companyEmail: exhibitor?.company_email ?? undefined,
    mainTel: exhibitor?.main_tel ?? buyer?.tel ?? undefined,
    fax: exhibitor?.fax ?? undefined,
    address: exhibitor
      ? [exhibitor.address_ko, exhibitor.address_detail].filter(Boolean).join(" ") || undefined
      : [buyer?.address1, buyer?.address2].filter(Boolean).join(" ") || undefined,
    businessType: exhibitor?.business_type ?? undefined,
    businessItem: exhibitor?.business_item ?? undefined,
    booth: exhibitor
      ? [exhibitor.booth_pavilion, exhibitor.booth_location].filter(Boolean).join(" ") || undefined
      : undefined,
    boothType: exhibitor?.booth_type ?? undefined,
    boothCount: exhibitor?.booth_count ?? undefined,
    availableLanguages: labelsFor(LANGUAGE_LABELS, exhibitor?.available_languages).join(", ") || undefined,
    products: exhibitor?.products?.length ? exhibitor.products.map(toProduct) : undefined,
    preferredBuyerCountries:
      labelsForOptions(BUYER_COUNTRY_OPTIONS, exhibitor?.preferred_buyer_countries).join(", ") || undefined,
    preferredBuyerTypes: labelsFor(ORG_TYPE_LABELS, exhibitor?.preferred_buyer_types).join(", ") || undefined,
    unavailableSlots: exhibitor?.unavailable_meeting_slots?.join(", ") || undefined,
  }
}

// 신청서 조회(OP-002 D19 모달) — 제출 이력이 있는 회원(hasApplication)만 상세를 불러 매핑한다.
// registered(명단만)·rejected(반려, hasApplication=false 정본 술어 — lib/application-status)는
// 애초에 신청서 조회 버튼이 없으므로 상세를 왕복할 이유가 없다(N+1 축소, mock 픽스처와 동일 전제 —
// MOCK_MEMBER_PROFILES도 hasApplication true인 회원만 키를 갖는다).
export async function fetchOrganizerMemberProfiles(token: string): Promise<Record<string, MemberProfile>> {
  const members = await fetchOrganizerMembers(token)
  const eventId = unwrap(await resolveEventId(token), "GET /api/admin/events")
  const targets = members.filter((m) => hasApplication(m.applicationStatus))
  const entries = await Promise.all(
    targets.map(async (m) => {
      const detail = unwrap(
        await backendJson<OrgDetailSnake>(
          token,
          `/api/admin/events/${encodeURIComponent(eventId)}/organizations/${encodeURIComponent(m.id)}`,
        ),
        `GET .../organizations/${m.id}`,
      )
      return [m.id, toMemberProfile(detail)] as const
    }),
  )
  return Object.fromEntries(entries)
}
