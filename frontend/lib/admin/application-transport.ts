// 관리자 콘솔(/admin/organizations)의 신청서 편집 전송 — 공용 어댑터(lib/operator/application-client)에
// "어느 경로로 보내는가"만 채워 준다. 같은 출처 catch-all BFF(app/api/admin/[...path])가 FastAPI
// /api/admin/* 로 그대로 통과시키므로 응답은 백엔드 본문 그대로다(상세 = OrganizationDetail,
// PATCH = 저장된 프로필). 경로는 lib/admin/api-paths.ts가 단일 소스다.
//
// 실연동이 아닌 목업 모드(NEXT_PUBLIC_AUTH_CLIENT !== "http")에는 BFF 뒤에 백엔드가 없다 — 그때는
// 목록 화면이 들고 있는 픽스처를 상세 형상으로 옮겨 인메모리 전송(lib/operator/mock-transport)에 심는다.
// 목업은 데모용이다: 실연동에서는 언제나 서버에서 새로 읽는다.

import type {
  ApiBuyerProfile,
  ApiExhibitorProfile,
  OperatorApplicationTransport,
  OperatorOrgDetailApi,
} from "@/lib/operator/application-client"
import { operatorJson } from "@/lib/operator/application-client"
import { createMockOperatorTransport } from "@/lib/operator/mock-transport"
import type { UnavailableSlotGrid } from "@/lib/operator/slot-grid"

import { adminApi } from "./api-paths"
import type { AdminOrganization, AdminOrgProfile } from "./types"

export function createAdminApplicationTransport(
  eventId: string,
  organizationId: string,
  // 미팅 불가 시간 격자의 축 — 콘솔이 이미 들고 있는 행사·설정으로 만든다(없으면 null).
  slotGrid: UnavailableSlotGrid | null,
): OperatorApplicationTransport {
  return {
    async getDetail() {
      const detail = await operatorJson<OperatorOrgDetailApi>(
        "GET",
        adminApi.organization(eventId, organizationId),
      )
      return { detail, slotGrid }
    },
    patchProfile(role, body) {
      return operatorJson<ApiExhibitorProfile | ApiBuyerProfile>(
        "PATCH",
        adminApi.organizationProfile(eventId, organizationId, role),
        body,
      )
    },
    patchUnavailableSlots(slots) {
      return operatorJson<ApiExhibitorProfile>(
        "PATCH",
        adminApi.organizationUnavailableSlots(eventId, organizationId),
        { slots },
      )
    },
  }
}

// ── 목업 모드 ────────────────────────────────────────────────────────────────
// 콘솔의 읽기 모델(AdminOrgProfile, 두 역할 합집합 flat)을 백엔드 상세 형상으로 되돌린다
// (lib/admin/http-client.ts toAdminOrgProfile의 역방향). flat 모델에 없는 칸은 비운다 — 지어내지 않는다.
export function adminMockOrgDetail(
  org: AdminOrganization,
  profile: AdminOrgProfile | null,
): OperatorOrgDetailApi {
  const base = {
    org_event_role_id: `${org.id}:${org.event_id}`,
    application_status: org.application_status,
    organization_name_ko: org.name_ko,
    organization_name_en: org.name_en,
    business_reg_no: profile?.business_reg_no ?? null,
    website: profile?.website ?? null,
  }
  const exhibitor: ApiExhibitorProfile | null =
    org.role === "exhibitor"
      ? ({
          ...base,
          booth_location: profile?.booth_location ?? null,
          representative_name_ko: profile?.representative_name ?? null,
          company_email: profile?.company_email ?? null,
          main_tel: profile?.main_tel ?? null,
          address_ko: profile?.address ?? null,
          annual_sales_range: profile?.annual_sales ?? null,
          employee_range: profile?.employee_range ?? null,
          available_languages: profile?.available_languages ?? [],
          exhibition_categories: profile?.categories ?? [],
          content_category: org.content_category,
          products: profile?.exhibitor_products ?? profile?.products ?? [],
          intro_ko: profile?.company_intro_ko ?? null,
          intro_en: profile?.company_intro_en ?? null,
          preferred_buyer_countries: profile?.preferred_buyer_countries ?? [],
          preferred_buyer_types: profile?.preferred_buyer_types ?? [],
          unavailable_meeting_slots: org.unavailable_slots,
          attendees: profile?.exhibitor_attendees ?? [],
          org_types: [],
        } as ApiExhibitorProfile)
      : null
  const buyer: ApiBuyerProfile | null =
    org.role === "buyer"
      ? ({
          ...base,
          contact_name_ko: profile?.contact_name ?? null,
          contact_title_ko: profile?.contact_title ?? null,
          contact_email: profile?.contact_email ?? null,
          contact_language: profile?.contact_language ?? null,
          contact_interpreter_need: profile ? profile.interpreter_need : null,
          country: profile?.country ?? org.country,
          address1: profile?.address ?? null,
          tel: profile?.main_tel ?? null,
          annual_sales_range: profile?.annual_sales ?? null,
          employee_range: profile?.employee_range ?? null,
          org_types: profile?.org_type ? [profile.org_type] : [],
          interest_categories: profile?.categories ?? [],
          company_intro_ko: profile?.company_intro_ko ?? null,
          company_intro_en: profile?.company_intro_en ?? null,
          budget_range: profile?.budget_range ?? null,
          adoption_timeline: profile?.adoption_timeline ?? null,
          attendees: [],
          recommended_buyers: [],
        } as ApiBuyerProfile)
      : null
  return {
    id: org.id,
    org_event_role_id: base.org_event_role_id,
    event_id: org.event_id,
    name_ko: org.name_ko,
    name_en: org.name_en,
    is_exhibitor: org.role === "exhibitor",
    is_buyer: org.role === "buyer",
    application_status: org.application_status,
    proxy_written_by_organizer_id: org.proxy_written ? "mock-organizer" : null,
    exhibitor_profile: exhibitor,
    buyer_profile: buyer,
  }
}

export function createAdminMockApplicationTransport(
  org: AdminOrganization,
  profile: AdminOrgProfile | null,
  slotGrid: UnavailableSlotGrid | null,
): OperatorApplicationTransport {
  return createMockOperatorTransport(adminMockOrgDetail(org, profile), slotGrid)
}
