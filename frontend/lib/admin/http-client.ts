import "server-only"

// 슈퍼어드민 콘솔 읽기 시움의 **실연동 구현** — FastAPI /api/admin/* 를 서버에서 직접 호출한다.
// (mock 구현은 server.ts의 mockAdminReadClient. 스왑 조건은 같은 파일의 리졸버 참고.)
//
// 쓰기(admin-actions)는 같은 출처 BFF 프록시 경유지만, 읽기는 서버 컴포넌트에서 일어나므로
// BFF를 한 번 더 거칠 이유가 없다 — 서버 env의 NABI_BACKEND_URL로 직행한다. 인증 헤더는
// 로그인 BFF가 심은 httpOnly 세션 쿠키를 서버 측에서 읽어 붙인다(클라 노출 없음, 경계 B).
//
// ⚠ 매핑 규약: 백엔드 응답은 확정 계약 그대로 오지만 콘솔 타입(./types)이 데모 목업 때 더
//   풍부하게 잡혀 있어(예: 미팅의 기업명·장소 라벨) 여기선 **있는 것만 매핑**하고 나머지는
//   타입이 허용하는 기본값(빈 문자열·0·빈 배열)으로 채운다 — 화면은 기본값을 견디게 돼 있다.
//   백엔드가 필드를 추가하면 여기서 매핑만 늘린다(호출처 불변).

import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { OperatorHttpError } from "@/lib/auth/operator-errors"
import { BUSINESS_FIELD_LABELS, labelsFor } from "@/lib/bm/fields"
import { zonedParts } from "@/lib/timezone"
import { buildAdminDashboard } from "./admin-mock"
import type { AdminReadClient } from "./server"
import { toAdminEventSettings, type EventSettingsOutSnake } from "./event-settings"
import type {
  AdminDashboard,
  AdminEvent,
  AdminExhibitorAttendeePatch,
  AdminExhibitorProductPatch,
  AdminInterpreter,
  AdminMatchingType,
  AdminMeeting,
  AdminMeetingStatus,
  AdminNotificationLog,
  AdminOrgProfile,
  AdminOrganization,
  AdminOrganizer,
  AdminVenue,
  ManageableVenueType,
} from "./types"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// ── fetch 코어 ────────────────────────────────────────────────────────────────
async function adminFetch<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const res = await fetch(`${BACKEND_URL}/api/admin${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  })
  if (!res.ok) {
    // 403/404는 digest로 상태를 싣는다 — /admin error.tsx가 콘솔 크롬 안에서 "권한 없음" 안내로 바꾼다.
    throw new OperatorHttpError(res.status, `admin read failed: GET ${path} (${res.status})`)
  }
  return (await res.json()) as T
}

function dateOrEmpty(value: string | null | undefined): string {
  return value ?? ""
}

// ISO datetime → 콘솔 표시용 (날짜, 시각), **행사 현지 타임존** 기준. 미배정(없음)은 빈 문자열 쌍.
// ⚠ Date.getHours() 등 로컬 게터는 쓰지 않는다 — 프로세스 TZ(컨테이너=UTC)에 따라 값이 바뀌어
// 같은 미팅이 화면마다 다른 시각으로 보이던 근본 원인이었다(H5, timezone-analysis.md §1.2).
function splitDateTime(
  value: string | null | undefined,
  timeZone: string,
): { date: string; time: string } {
  return zonedParts(value, timeZone)
}

// ── 백엔드 응답 형상 → 콘솔 타입 매핑 ─────────────────────────────────────────
interface EventOutSnake {
  id: string
  name: string
  name_en?: string | null
  slug: string
  venue_name?: string | null
  exhibition_start?: string | null
  exhibition_end?: string | null
  application_start?: string | null
  application_end?: string | null
  timezone?: string | null // IANA(예: "Asia/Ho_Chi_Minh"). 백엔드는 항상 채워 보낸다(server_default).
}

export function toAdminEvent(e: EventOutSnake): AdminEvent {
  return {
    id: e.id,
    name: e.name,
    name_en: e.name_en ?? undefined,
    venue_name: e.venue_name ?? "",
    exhibition_start: dateOrEmpty(e.exhibition_start),
    exhibition_end: dateOrEmpty(e.exhibition_end),
    application_start: dateOrEmpty(e.application_start),
    application_end: dateOrEmpty(e.application_end),
    // 미지정 방어값 — 실제로는 백엔드가 항상 값을 채워 보낸다(events.timezone server_default).
    timezone: e.timezone ?? "Asia/Seoul",
  }
}

// ⚠ 2026-09-12까지 이 인터페이스가 id/name/역할/상태만 선언해 담당자·국가·품목·부스·등록주체를
// 전부 하드코딩 null로 버리고 있었다(OP-002 "-" 버그 — 목록 API는 이미 이 필드들을 내려주고
// 있었는데 매핑이 안 따라갔다). organizer 콘솔(lib/organizer/http-members-client.ts)은 같은
// 백엔드 응답(app.admin.service.list_organizations, 2026-09 LEFT JOIN 확장)을 이미 올바르게
// 매핑하고 있었다 — 그 매핑을 그대로 미러한다(같은 기업이 두 콘솔에서 다른 담당자로 보이면 안 됨).
interface OrgListItemSnake {
  id: string
  name_ko?: string | null
  name_en?: string | null
  is_exhibitor: boolean
  is_buyer: boolean
  application_status: AdminOrganization["application_status"]
  created_by_organizer_id?: string | null
  proxy_written_by_organizer_id?: string | null
  match_count?: number
  // 공통 — app.admin.service.resolve_primary_contact() 단일 폴백 규칙(엑셀 export와 동일).
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  // 참가사(exhibitor_profiles)
  booth_hall?: string | null
  booth_pavilion?: string | null
  booth_location?: string | null
  exhibition_categories?: string[]
  content_category?: string | null
  // 바이어(buyer_profiles)
  country?: string | null
  interest_categories?: string[]
}

// 부스(홀·관·번호) — organizer 콘솔(http-members-client.ts boothLabelOf)과 동일 규칙.
function boothLabelOf(o: OrgListItemSnake): string | null {
  return [o.booth_hall, o.booth_pavilion, o.booth_location].filter(Boolean).join(" · ") || null
}

async function allOrganizationItems(eventId: string): Promise<OrgListItemSnake[]> {
  const base = `/events/${encodeURIComponent(eventId)}/organizations?limit=100`
  const first = await adminFetch<{ items: OrgListItemSnake[]; total: number }>(`${base}&offset=0`)
  const items = [...first.items]
  for (let offset = 100; offset < first.total; offset += 100) {
    const page = await adminFetch<{ items: OrgListItemSnake[] }>(`${base}&offset=${offset}`)
    if (page.items.length === 0) break
    items.push(...page.items)
  }
  return items
}

export function toAdminOrganization(
  o: OrgListItemSnake,
  eventId: string,
  unavailableSlots: string[] = [],
): AdminOrganization {
  const isExhibitor = o.is_exhibitor
  const categoryCodes = (isExhibitor ? o.exhibition_categories : o.interest_categories) ?? []
  const categories = labelsFor(BUSINESS_FIELD_LABELS, categoryCodes).join(", ")
  return {
    id: o.id,
    event_id: eventId,
    role: isExhibitor ? "exhibitor" : "buyer",
    name_ko: o.name_ko ?? o.name_en ?? "(이름 없음)",
    name_en: o.name_en ?? null,
    country: o.country ?? null,
    application_status: o.application_status,
    proxy_written: o.proxy_written_by_organizer_id != null,
    // The audit ID is enough for the flag; it is not a user-facing author name.
    proxy_written_by: null,
    proxy_written_at: null,
    contact_name: o.contact_name ?? null,
    contact_email: o.contact_email ?? null,
    contact_phone: o.contact_phone ?? null,
    category: categories || null,
    business_field_codes: categoryCodes,
    content_category: isExhibitor ? o.content_category ?? null : null,
    booth_label: isExhibitor ? boothLabelOf(o) : null,
    registered_by: o.created_by_organizer_id ? "운영자 등록" : "직접 등록",
    meeting_count: o.match_count ?? 0,
    unavailable_slots: unavailableSlots,
    updated_at: "",
  }
}

interface MeetingItemSnake {
  id: string
  exhibitor_org_id: string
  buyer_org_id: string
  status: "proposed" | "accepted" | "rejected" | "cancelled" | "completed"
  matching_type: AdminMatchingType
  scheduled_start?: string | null
  scheduled_end?: string | null
  venue_id?: string | null
  venue_type?: "booth" | "zone_table" | "business_room" | null
  venue_label?: string | null
}

const MEETING_STATUS_TO_CONSOLE: Record<MeetingItemSnake["status"], AdminMeetingStatus> = {
  proposed: "scheduled",
  accepted: "scheduled",
  rejected: "cancelled", // 콘솔 상태집합에 rejected가 없어 가장 가까운 운영 상태로 표시
  cancelled: "cancelled",
  completed: "completed",
}

export function toAdminMeeting(
  m: MeetingItemSnake,
  eventId: string,
  orgNames: Map<string, string>,
  slotMinutes: number,
  timeZone: string,
): AdminMeeting {
  const start = splitDateTime(m.scheduled_start, timeZone)
  // 슬롯 길이는 시작·종료가 둘 다 있을 때 실측, 없으면 행사 기본값 전달.
  let duration = slotMinutes
  if (m.scheduled_start && m.scheduled_end) {
    const ms = new Date(m.scheduled_end).getTime() - new Date(m.scheduled_start).getTime()
    if (ms > 0) duration = Math.round(ms / 60000)
  }
  return {
    id: m.id,
    event_id: eventId,
    date: start.date,
    start_time: start.time,
    slot_minutes: duration as AdminMeeting["slot_minutes"],
    exhibitor_id: m.exhibitor_org_id,
    exhibitor_name: orgNames.get(m.exhibitor_org_id) ?? m.exhibitor_org_id,
    buyer_id: m.buyer_org_id,
    buyer_name: orgNames.get(m.buyer_org_id) ?? m.buyer_org_id,
    status: MEETING_STATUS_TO_CONSOLE[m.status] ?? "scheduled",
    matching_type: m.matching_type,
    // N3: 백엔드가 LEFT JOIN으로 venue_type/venue_label을 같이 내려준다(MeetingListItem, 취소 맥락과
    // 함께 덧붙여짐) — 장소 미배정(venue_id 없음)일 때만 "부스"로 기본 표시하고, 그 외엔 실제 유형을
    // 그대로 쓴다. 라벨(T-01 등)이 없으면 뱃지만(콘솔이 이미 venue_label && …로 조건부 렌더).
    venue_type: m.venue_type ?? "booth",
    venue_label: m.venue_label ?? null,
    cancelled_by: null,
    cancelled_reason: null,
  }
}

interface InterpreterOutSnake {
  id: string
  event_id: string
  name: string
  languages: string[]
  phone?: string | null
  email?: string | null
  assigned_organization_ids: string[]
}

function toAdminInterpreter(
  i: InterpreterOutSnake,
  orgNames: Map<string, string>,
): AdminInterpreter {
  const assignedOrgId = i.assigned_organization_ids[0] ?? null
  return {
    id: i.id,
    event_id: i.event_id,
    name: i.name,
    languages: i.languages,
    phone: i.phone ?? null,
    email: i.email ?? null,
    assigned_org_id: assignedOrgId,
    assigned_org_name: assignedOrgId ? (orgNames.get(assignedOrgId) ?? assignedOrgId) : null,
  }
}

interface VenueOutSnake {
  id: string
  event_id: string
  venue_type: ManageableVenueType
  label: string
  meeting_count: number
}

// 필드가 이미 콘솔 타입(AdminVenue)과 1:1이라 다른 매핑처럼 기본값을 채울 게 없다 — 그래도
// 함수로 감싸는 이유는 백엔드 응답 형상이 바뀌면 여기 계약 테스트(http-client.test.ts)가 먼저
// 깨지게 하기 위해서다(직접 캐스팅하면 필드가 늘거나 줄어도 타입 체크만으로는 안 걸린다).
export function toAdminVenue(v: VenueOutSnake): AdminVenue {
  return {
    id: v.id,
    event_id: v.event_id,
    venue_type: v.venue_type,
    label: v.label,
    meeting_count: v.meeting_count,
  }
}

// 행사 설정 응답(EventSettingsOut) 매핑은 lib/admin/event-settings.ts에 있다 — 화면(클라이언트)이 PATCH 응답
// 본문을 같은 규칙으로 읽어야 해서 클라이언트에서도 import할 수 있는 모듈로 옮겼다(여기는 next/headers를 쓴다).
export { toAdminEventSettings }

// 상세 응답의 buyer/exhibitor 프로필 → 콘솔 인라인 편집 타입(두 역할 합집합)으로 평탄화.
// 직접 대응하는 필드만 매핑하고 나머지는 기본값 — 프로파일 폼은 빈 필드를 견딘다.
//
// ⚠ 바이어 담당자(contact_*)는 attendees[0]이 아니라 **org 레벨**에서 온다(BuyerProfileResponse의
// contact_name_ko 등 — F-BM-001 신청자 식별 필드, attendees는 별도 "담당자(복수)" 3단계 목록이라
// 다른 사람일 수 있다). 참가사는 반대로 org 레벨에 담당자 필드가 없어 attendees[0]에서 읽는다
// (현행 유지) — 그래서 두 role의 매핑 방식이 서로 다르다.
function toAdminOrgProfile(detail: OrgDetailSnake): AdminOrgProfile {
  const buyer = detail.buyer_profile
  const exhibitor = detail.exhibitor_profile
  const exAttendee = exhibitor?.attendees?.[0]

  const contactName = buyer
    ? (buyer.contact_name_ko ?? buyer.contact_name_en ?? null)
    : exAttendee
      ? [
          exAttendee.first_name_ko ?? exAttendee.first_name_en,
          exAttendee.last_name_ko ?? exAttendee.last_name_en,
        ]
          .filter(Boolean)
          .join(" ") || null
      : null

  return {
    organization_id: detail.id,
    business_reg_no: buyer?.business_reg_no ?? exhibitor?.business_reg_no ?? null,
    website: buyer?.website ?? exhibitor?.website ?? null,
    representative_name: exhibitor?.representative_name_ko ?? null,
    company_email: exhibitor?.company_email ?? null,
    main_tel: buyer?.tel ?? exhibitor?.main_tel ?? null,
    address: buyer?.address1 ?? exhibitor?.address_ko ?? null,
    country: buyer?.country ?? null,
    org_type: buyer?.org_types?.[0] ?? exhibitor?.org_types?.[0] ?? null,
    annual_sales: buyer?.annual_sales_range ?? exhibitor?.annual_sales_range ?? null,
    employee_range: buyer?.employee_range ?? exhibitor?.employee_range ?? null,
    categories: buyer?.interest_categories ?? exhibitor?.exhibition_categories ?? [],
    company_intro_ko: buyer?.company_intro_ko ?? exhibitor?.intro_ko ?? null,
    company_intro_en: buyer?.company_intro_en ?? exhibitor?.intro_en ?? null,
    contact_name: contactName,
    contact_title: buyer
      ? (buyer.contact_title_ko ?? buyer.contact_title_en ?? null)
      : (exAttendee?.title_ko ?? null),
    contact_email: buyer ? (buyer.contact_email ?? null) : (exAttendee?.email ?? null),
    contact_phone: buyer ? null : (exAttendee?.tel ?? exAttendee?.mobile ?? null),
    contact_language: buyer ? (buyer.contact_language ?? null) : (exAttendee?.languages?.[0] ?? null),
    interpreter_need: buyer?.contact_interpreter_need ?? false,
    budget_range: buyer?.budget_range ?? null,
    adoption_timeline: buyer?.adoption_timeline ?? null,
    booth_label: exhibitor
      ? [exhibitor.booth_pavilion, exhibitor.booth_location].filter(Boolean).join(" ") || null
      : null,
    // 운영자가 지정하는 부스번호 — 조합 표시값(booth_label)과 달리 이건 단일 편집 대상 컬럼이다.
    booth_location: exhibitor?.booth_location ?? null,
    products: exhibitor?.products ?? [],
    available_languages: exhibitor?.available_languages ?? [],
    preferred_buyer_countries: exhibitor?.preferred_buyer_countries ?? [],
    preferred_buyer_types: exhibitor?.preferred_buyer_types ?? [],
    updated_at: "",
    // 참가사 전용 원본 리스트(백엔드 행 그대로 — 숨은 칸 포함). 대리작성 다이얼로그가 제품 목록을
    // 통째로 다시 보낼 때 쓴다(proxy-profile-form.toFormState). 바이어는 undefined로 둔다.
    exhibitor_attendees: exhibitor?.attendees,
    exhibitor_products: exhibitor?.products,
  }
}

interface OrgDetailSnake {
  id: string
  org_event_role_id: string
  event_id: string
  is_exhibitor: boolean
  is_buyer: boolean
  buyer_profile?: {
    business_reg_no?: string | null
    website?: string | null
    country?: string | null
    tel?: string | null
    address1?: string | null
    org_types?: string[]
    annual_sales_range?: string | null
    employee_range?: string | null
    interest_categories?: string[]
    company_intro_ko?: string | null
    company_intro_en?: string | null
    budget_range?: string | null
    adoption_timeline?: string | null
    contact_name_ko?: string | null
    contact_name_en?: string | null
    contact_title_ko?: string | null
    contact_title_en?: string | null
    contact_email?: string | null
    contact_language?: string | null
    contact_interpreter_need?: boolean | null
    attendees?: {
      first_name?: string | null
      last_name?: string | null
      job_title?: string | null
      email?: string | null
      tel?: string | null
      mobile?: string | null
      languages?: string[]
      interpreter_need?: boolean
    }[]
  } | null
  exhibitor_profile?: {
    business_reg_no?: string | null
    website?: string | null
    booth_pavilion?: string | null
    booth_location?: string | null
    representative_name_ko?: string | null
    company_email?: string | null
    main_tel?: string | null
    address_ko?: string | null
    org_types?: string[]
    annual_sales_range?: string | null
    employee_range?: string | null
    available_languages?: string[]
    intro_ko?: string | null
    intro_en?: string | null
    exhibition_categories?: string[]
    preferred_buyer_countries?: string[]
    preferred_buyer_types?: string[]
    products?: AdminExhibitorProductPatch[]
    attendees?: AdminExhibitorAttendeePatch[]
  } | null
}

// ── AdminReadClient 실연동 구현 ────────────────────────────────────────────────
export const httpAdminReadClient: AdminReadClient = {
  async getEvents() {
    const data = await adminFetch<{ items: EventOutSnake[] }>("/events")
    return data.items.map(toAdminEvent)
  },

  async getEventSettings(eventId) {
    const s = await adminFetch<EventSettingsOutSnake>(`/events/${encodeURIComponent(eventId)}/settings`)
    return toAdminEventSettings(s)
  },

  async getOrganizations(eventId) {
    // 목록 응답엔 unavailable_meeting_slots가 없다(H8) — 별도 엔드포인트로 org_id별 불가 슬롯을
    // 받아 병합한다. PATCH는 늘 정상 저장됐고, 문제는 이 값을 되돌려줄 GET이 없던 것뿐이었다.
    const [items, unavailable] = await Promise.all([
      allOrganizationItems(eventId),
      adminFetch<Record<string, string[]>>(
        `/events/${encodeURIComponent(eventId)}/unavailable-slots`,
      ).catch(() => ({}) as Record<string, string[]>),
    ])
    return items.map((o) => toAdminOrganization(o, eventId, unavailable[o.id] ?? []))
  },

  // 목록 id별로 상세를 조회해 프로필 본문을 채운다(데모 규모에서 N+1 허용 — 실연동 후기엔
  // 백엔드에 프로필 포함 목록 확장 시 교체).
  async getOrgProfiles(eventId) {
    const list = await allOrganizationItems(eventId)
    const entries: Array<readonly [string, AdminOrgProfile]> = []
    // Keep concurrent detail reads bounded when an event has hundreds of organizations.
    for (let start = 0; start < list.length; start += 20) {
      const batch = await Promise.all(list.slice(start, start + 20).map(async (o) => {
        const detail = await adminFetch<OrgDetailSnake>(
          `/events/${encodeURIComponent(eventId)}/organizations/${encodeURIComponent(o.id)}`,
        )
        return [o.id, toAdminOrgProfile(detail)] as const
      }))
      entries.push(...batch)
    }
    return Object.fromEntries(entries)
  },

  async getMeetings(eventId) {
    // 표시 타임존은 **행사 현지**(event.timezone) — 미팅 목록 응답 자체엔 타임존이 없어(H5) 행사를
    // 함께 조회한다. 이걸 빠뜨리면 splitDateTime이 다시 프로세스 TZ로 되돌아간다(H5 재발).
    const [meetings, orgs, settings, event] = await Promise.all([
      adminFetch<{ items: MeetingItemSnake[] }>(
        `/events/${encodeURIComponent(eventId)}/meetings?limit=100`,
      ),
      adminFetch<{ items: OrgListItemSnake[] }>(
        `/events/${encodeURIComponent(eventId)}/organizations?limit=100`,
      ),
      adminFetch<EventSettingsOutSnake>(`/events/${encodeURIComponent(eventId)}/settings`),
      adminFetch<EventOutSnake>(`/events/${encodeURIComponent(eventId)}`),
    ])
    const orgNames = new Map(
      orgs.items.map((o) => [o.id, o.name_ko ?? o.name_en ?? o.id]),
    )
    const timeZone = event.timezone ?? "Asia/Seoul"
    return meetings.items.map((m) =>
      toAdminMeeting(m, eventId, orgNames, settings.slot_minutes, timeZone),
    )
  },

  async getNotifications(eventId) {
    const data = await adminFetch<{ items: AdminNotificationLog[] }>(
      `/events/${encodeURIComponent(eventId)}/notifications`,
    )
    return data.items
  },

  async getInterpreters(eventId) {
    const [interpreters, orgs] = await Promise.all([
      adminFetch<InterpreterOutSnake[]>(`/events/${encodeURIComponent(eventId)}/interpreters`),
      adminFetch<{ items: OrgListItemSnake[] }>(
        `/events/${encodeURIComponent(eventId)}/organizations?limit=100`,
      ),
    ])
    const orgNames = new Map(orgs.items.map((o) => [o.id, o.name_ko ?? o.name_en ?? o.id]))
    return interpreters.map((i) => toAdminInterpreter(i, orgNames))
  },

  // booth는 백엔드가 아예 걸러 목록에 내려주지 않는다(zone_table·business_room만) — 라벨 순.
  async getVenues(eventId) {
    const venues = await adminFetch<VenueOutSnake[]>(`/events/${encodeURIComponent(eventId)}/venues`)
    return venues.map(toAdminVenue)
  },

  async getOrganizers(eventId) {
    const rows = await adminFetch<AdminOrganizer[]>(`/events/${encodeURIComponent(eventId)}/organizers`)
    return rows
  },

  // 집계는 백엔드 전용 요약 엔드포인트가 아직 없어 — 목록 3종을 불러 순수 집계 함수로 조립한다
  // (buildAdminDashboard는 mock과 공유하는 동일 로직이라 실/목업 지표 정의가 갈리지 않는다).
  async getDashboard(eventId): Promise<AdminDashboard> {
    const [orgs, meetings, notifications] = await Promise.all([
      this.getOrganizations(eventId),
      this.getMeetings(eventId),
      this.getNotifications(eventId),
    ])
    return buildAdminDashboard(eventId, orgs, meetings, notifications, [])
  },
}
