// 행사 운영 콘솔(/organizer/members)의 신청서 편집 전송 — 공용 어댑터(lib/operator/application-client)에
// "어느 경로로 보내는가"만 채워 준다. 이 콘솔은 행사 id를 화면이 들고 있지 않아(BFF가 선택된 행사로
// 해석한다, lib/organizer/backend-proxy) 기업 id만으로 부르는 전용 BFF를 쓴다:
//   GET   /api/organizer/members/{id}/profile            상세 + 미팅 불가 시간 격자
//   PATCH /api/organizer/members/{id}/profile            { role, mode: "edit", patch } → 저장된 프로필
//   PATCH /api/organizer/members/{id}/unavailable-slots  { slots } → 저장된 프로필
//
// BFF가 저장된 프로필을 돌려주지 않으면 저장을 확인할 수 없다 — 성공으로 치지 않고 실패로 던진다
// (세션 쿠키가 없는 목 세션 분기는 저장소가 없어 프로필 없이 답한다. "저장한 척"을 화면까지 올리지 않는다).
//
// 실 세션이 아닌 목업 모드(dev 스위처)에는 BFF 뒤에 백엔드가 없다 — 그때는 명단 화면이 들고 있는
// 픽스처를 상세 형상으로 옮겨 인메모리 전송(lib/operator/mock-transport)에 심는다.

import type {
  ApiBuyerProfile,
  ApiExhibitorProfile,
  OperatorApplicationTransport,
  OperatorOrgDetailApi,
} from "@/lib/operator/application-client"
import { OperatorRequestError, operatorJson } from "@/lib/operator/application-client"
import { createMockOperatorTransport } from "@/lib/operator/mock-transport"
import type { UnavailableSlotGrid } from "@/lib/operator/slot-grid"

import type { MemberProfile } from "./member-profile"
import type { MemberRow } from "./members"

interface SavedProfileEnvelope<T> {
  success?: boolean
  profile?: T | null
}

function savedProfile<T>(data: SavedProfileEnvelope<T>): T {
  if (!data.profile) throw new OperatorRequestError(502, "save_unconfirmed")
  return data.profile
}

export function createOrganizerApplicationTransport(memberId: string): OperatorApplicationTransport {
  const base = `/api/organizer/members/${encodeURIComponent(memberId)}`
  return {
    async getDetail() {
      const data = await operatorJson<{
        detail?: OperatorOrgDetailApi | null
        slotGrid?: UnavailableSlotGrid | null
      }>("GET", `${base}/profile`)
      if (!data.detail) throw new OperatorRequestError(502, "no_detail")
      return { detail: data.detail, slotGrid: data.slotGrid ?? null }
    },
    async patchProfile(role, body) {
      return savedProfile(
        await operatorJson<SavedProfileEnvelope<ApiExhibitorProfile | ApiBuyerProfile>>(
          "PATCH",
          `${base}/profile`,
          { role, mode: "edit", patch: body },
        ),
      )
    },
    async patchUnavailableSlots(slots) {
      return savedProfile(
        await operatorJson<SavedProfileEnvelope<ApiExhibitorProfile>>(
          "PATCH",
          `${base}/unavailable-slots`,
          { slots },
        ),
      )
    },
  }
}

// ── 목업 모드 ────────────────────────────────────────────────────────────────
// 명단 픽스처(MemberRow + MemberProfile)를 백엔드 상세 형상으로 옮긴다. MemberProfile은 조회용이라
// 연매출·분야·언어 등이 코드가 아니라 **라벨 문자열**이다 — 그대로 코드 자리에 얹는다. 참가자 화면의
// 라벨 조회(labelOf/labelsOf)는 모르는 코드를 원문 그대로 보여 주므로 화면에는 값이 그대로 나온다
// (components/organizer/company-application.tsx와 같은 방식). 목업 전용이다 — 실 세션은 서버가 준
// 코드값을 그대로 쓴다.
const split = (value: string | undefined): string[] =>
  value ? value.split(/,\s*/).filter(Boolean) : []

export function organizerMockOrgDetail(
  row: MemberRow,
  profile: MemberProfile | null,
): OperatorOrgDetailApi {
  const base = {
    org_event_role_id: `${row.id}:mock`,
    application_status: row.applicationStatus,
    organization_name_ko: row.name,
    organization_name_en: row.nameEn ?? null,
    business_reg_no: profile?.businessRegNo ?? row.businessRegNo ?? null,
    website: profile?.website ?? row.website ?? null,
  }
  const exhibitor =
    row.tab === "exhibitor"
      ? ({
          ...base,
          booth_location: profile?.booth ?? row.boothLabel ?? null,
          booth_type: profile?.boothType ?? null,
          booth_count: profile?.boothCount ?? null,
          representative_name_ko: profile?.representativeNameKo ?? null,
          representative_name_en: profile?.representativeNameEn ?? null,
          company_email: profile?.companyEmail ?? null,
          main_tel: profile?.mainTel ?? row.mainTel ?? null,
          fax: profile?.fax ?? null,
          address_ko: profile?.address ?? row.address ?? null,
          business_type: profile?.businessType ?? null,
          business_item: profile?.businessItem ?? null,
          annual_sales_range: profile?.annualSales ?? null,
          employee_range: profile?.employeeRange ?? null,
          available_languages: split(profile?.availableLanguages),
          org_types: profile?.orgTypes ?? [],
          exhibition_categories: profile?.categories ?? [],
          content_category: profile?.contentCategory ?? row.contentCategory ?? null,
          products: (profile?.products ?? []).map((p) => ({
            name_ko: p.nameKo,
            name_en: p.nameEn ?? null,
            business_field: p.category ?? null,
            hs_code: p.hsCode ?? null,
            hs_description: p.hsDescription ?? null,
            price_range: p.priceRange ?? null,
          })),
          intro_ko: profile?.companyIntroKo ?? null,
          intro_en: profile?.companyIntroEn ?? null,
          preferred_buyer_countries: split(profile?.preferredBuyerCountries),
          preferred_buyer_types: split(profile?.preferredBuyerTypes),
          unavailable_meeting_slots: split(profile?.unavailableSlots),
          attendees: (profile?.attendees ?? []).map((a) => ({
            first_name_ko: a.name,
            division_ko: a.division ?? null,
            title_ko: a.title ?? null,
            email: a.email ?? null,
            tel: a.tel ?? null,
            mobile: a.mobile ?? null,
          })),
        } as unknown as ApiExhibitorProfile)
      : null
  const buyer =
    row.tab === "buyer"
      ? ({
          ...base,
          contact_name_ko: profile?.contactNameKo ?? row.primaryContact ?? null,
          contact_name_en: profile?.contactNameEn ?? row.primaryContactEn ?? null,
          contact_title_ko: profile?.contactTitleKo ?? row.contactTitle ?? null,
          contact_title_en: profile?.contactTitleEn ?? row.contactTitleEn ?? null,
          contact_email: profile?.contactEmail ?? row.contactEmail ?? null,
          contact_language: profile?.contactLanguage ?? row.language ?? null,
          contact_interpreter_need: profile?.interpreterNeed ?? null,
          country: profile?.country ?? null,
          address1: profile?.address ?? row.address ?? null,
          tel: profile?.contactPhone ?? profile?.mainTel ?? row.contactPhone ?? null,
          annual_sales_range: profile?.annualSales ?? null,
          employee_range: profile?.employeeRange ?? null,
          org_types: profile?.orgTypes ?? [],
          interest_categories: profile?.categories ?? [],
          company_intro_ko: profile?.companyIntroKo ?? null,
          company_intro_en: profile?.companyIntroEn ?? null,
          budget_range: profile?.budgetRange ?? null,
          adoption_timeline: profile?.adoptionTimeline ?? null,
          participation_route: profile?.participationRoute ?? null,
          kst_available_time: profile?.kstAvailableTime ?? row.kstAvailableTime ?? null,
          attendees: (profile?.attendees ?? []).map((a) => ({
            first_name: a.name,
            division: a.division ?? null,
            job_title: a.title ?? null,
            email: a.email ?? null,
            tel: a.tel ?? null,
            mobile: a.mobile ?? null,
            interpreter_need: a.interpreterNeed ?? false,
          })),
          recommended_buyers: [],
        } as unknown as ApiBuyerProfile)
      : null
  return {
    id: row.id,
    org_event_role_id: base.org_event_role_id,
    event_id: "mock",
    name_ko: row.name,
    name_en: row.nameEn ?? null,
    is_exhibitor: row.tab === "exhibitor",
    is_buyer: row.tab === "buyer",
    application_status: row.applicationStatus,
    proxy_written_by_organizer_id: null,
    exhibitor_profile: exhibitor,
    buyer_profile: buyer,
  }
}

export function createOrganizerMockApplicationTransport(
  row: MemberRow,
  profile: MemberProfile | null,
): OperatorApplicationTransport {
  return createMockOperatorTransport(organizerMockOrgDetail(row, profile), null)
}
