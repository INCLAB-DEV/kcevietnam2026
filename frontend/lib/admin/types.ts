// 슈퍼어드민 콘솔(/admin) 데이터 계약 — FastAPI `/api/admin/*` 응답·요청 shape의 단일 정본.
//
// **필드명은 백엔드 JSON 그대로(snake_case)** 둔다 — 목업→실연동 스왑 때 매핑 레이어 없이 응답을
// 그대로 부을 수 있게 하기 위해서다(프론트 관례인 camelCase는 여기서만 예외).
// **경로는 여기 두지 않는다** — lib/admin/api-paths.ts 한 곳에 모은다.
//
// 운영자 콘솔(`app/organizer/**`, F-OP-001~005)과는 다른 표면이다: 저쪽은 행사 운영(당일 배정·
// 심사), 이쪽은 시스템 관리(모든 리소스의 조회·수정·정책). 도메인 상태값(ApplicationStatus)만
// 단일 정본(lib/application-status)에서 재사용한다.
//
// ── 백엔드 확정 계약 요약 (경로 상세는 api-paths.ts) ─────────────────────────
//  이벤트 하위 리소스는 전부 event 스코프: `/api/admin/events/{event_id}/...`
//  · 행사       GET/POST /events · GET/PATCH /events/{id}
//  · 설정       GET/PATCH /events/{id}/settings
//  · 기업       GET /events/{id}/organizations?role=&status=&search=&limit=&offset=
//               GET /events/{id}/organizations/{org_id}
//               PATCH .../profile?role=buyer|exhibitor      (직접 수정)
//               POST  .../proxy-profile?role=buyer|exhibitor (대리작성 — master 승인/sub 제출)
//               PATCH .../unavailable-slots  body { slots: [...] }
//  · 미팅       GET /events/{id}/meetings?status=&limit=&offset=
//               POST /events/{id}/meetings/{meeting_id}/cancel
//  · 통역사     GET/POST /events/{id}/interpreters
//               GET/PATCH/DELETE /events/{id}/interpreters/{interpreter_id}
//               POST   .../assign  body { organization_id }
//               DELETE .../assign/{organization_id}
//  · 장소       GET(operator)/POST(master) /events/{id}/venues
//               PATCH/DELETE(master) /events/{id}/venues/{venue_id} — booth는 대상 아님
//  · 엑셀       GET /export/{organizations|meetings|reviews}.xlsx?event_id=
//               POST /import/roster?event_id=

import type { ApplicationStatus } from "@/lib/application-status"
import type { NotificationType as AdminNotificationType } from "@/lib/home/notification"

export type { ApplicationStatus }

// ── 행사(Event) ──────────────────────────────────────────────────────────────

// 미팅 시간 단위(분). 백엔드 `slot_minutes` 허용값과 1:1 — 이 5개 외 값은 검증에서 거른다.
export type SlotMinutes = 10 | 20 | 30 | 40 | 60
export const SLOT_MINUTES_OPTIONS: readonly SlotMinutes[] = [10, 20, 30, 40, 60]

// 미팅이 열릴 수 있는 장소 유형. 행사마다 운용 형태가 달라 정책 토글로 켜고 끈다
// (예: 부스만 운영하는 해외 전시 vs 매칭존·비즈니스룸을 함께 쓰는 국내 전시).
// ⚠ 백엔드 문자열 값 그대로: "zone_table"(매칭존 테이블), "business_room"(비즈니스 룸).
export type VenueType = "booth" | "zone_table" | "business_room"
export const VENUE_TYPES: readonly VenueType[] = ["booth", "zone_table", "business_room"]
export const VENUE_TYPE_LABELS: Record<VenueType, string> = {
  booth: "부스",
  zone_table: "매칭존 테이블",
  business_room: "비즈니스 룸",
}

// 행사 식별·일정. GET/PATCH /events/{id} 의 필드셋.
// 신청기간(application_start/end)은 **행사** 리소스에 산다 — 정책(settings)이 아니다.
export interface AdminEvent {
  id: string
  name: string
  // ⚠ 백엔드 확정 계약에는 name 단일 필드만 있다. 국/영 병기 요구(개발계획서)를 화면에서 살리기
  //   위해 FE 보조 필드로 둔다. 백엔드에 name_en이 생기면 그대로 매핑되고, 안 생기면 이 필드를
  //   지우고 화면의 영문 입력을 접으면 된다. (백엔드 팀 확인 필요 — 보고서에 명시)
  name_en?: string
  venue_name: string
  exhibition_start: string // YYYY-MM-DD — 전시 시작일
  exhibition_end: string // YYYY-MM-DD — 전시 종료일(포함)
  application_start: string // YYYY-MM-DD — 비즈매칭 신청 시작
  application_end: string // YYYY-MM-DD — 신청 종료
  // 행사 현지 타임존(IANA, 예: "Asia/Ho_Chi_Minh"). 미팅 시각·슬롯 그리드 표시가 전부 이 값 기준
  // (ADR-0014) — 과거엔 이 필드가 없어 FE가 어디서나 Asia/Seoul을 하드코딩했다(H5).
  timezone: string
}

// POST /api/admin/events 본문 — id는 서버가 발급. 신규 행사는 설정도 함께 초기화한다.
export interface AdminEventInput extends Omit<AdminEvent, "id"> {
  settings?: AdminEventSettingsPatch
}

// PATCH /api/admin/events/{id} 본문 — 부분 수정.
export type AdminEventPatch = Partial<Omit<AdminEvent, "id">>

// 행사별 운영 정책. GET/PATCH /events/{id}/settings 의 필드셋.
export interface AdminEventSettings {
  event_id: string
  slot_minutes: SlotMinutes
  enabled_venue_types: VenueType[] // 이 행사에서 사용 가능한 미팅 장소 유형(최소 1개)
  allow_same_role_discovery: boolean // 동일 역할 상호 열람(참가사↔참가사). 기본 false.
  // 슬롯 그리드의 나머지 축(H9) — 백엔드가 이미 늘 보내던 값인데, 이 타입에 필드가 없어
  // /admin/settings가 못 쓰고 FE 하드코딩(10:00~18:10/45분, 문서 근거 없음)으로 대체했었다.
  // 둘 다 "HH:MM" 문자열(초 없음 — http-client.ts 매핑에서 잘라낸다).
  operating_start: string
  operating_end: string
  lunch_start: string | null
  lunch_end: string | null
  min_guaranteed_slots: number
  // 슬롯 간격(gap, H9 후속) — 상담 길이(slot_minutes)와 분리된 텀. 예: 40분 상담 + 5분 텀이면
  // slot_minutes=40, slot_gap_minutes=5, 전진 단위(stride)는 이 둘의 합(계약서 §1).
  slot_gap_minutes: number
  // 연속 예약(멀티슬롯) 상한 — 칸 수가 아니라 분 단위(계약서 §2). 기존 "3칸" 상한을 대체한다.
  max_meeting_minutes: number
}

export type AdminEventSettingsPatch = Partial<Omit<AdminEventSettings, "event_id">>

// ── 기업(Organization) ───────────────────────────────────────────────────────

export type AdminOrgRole = "exhibitor" | "buyer"
export const ADMIN_ORG_ROLES: readonly AdminOrgRole[] = ["exhibitor", "buyer"]
export const ADMIN_ORG_ROLE_LABELS: Record<AdminOrgRole, string> = {
  exhibitor: "참가사",
  buyer: "바이어",
}

// 리스트 행. 신청서 본문은 AdminOrgProfile로 따로 받는다 — 목록 페이로드를 가볍게 유지.
export interface AdminOrganization {
  id: string
  event_id: string
  role: AdminOrgRole
  name_ko: string
  name_en: string | null
  country: string | null
  application_status: ApplicationStatus
  // 운영자가 대리작성한 신청서인지. master 작성은 approved, sub 작성은 submitted 상태다.
  proxy_written: boolean
  proxy_written_by: string | null
  proxy_written_at: string | null // ISO8601
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  category: string | null // 전시품목(참가사) / 관심품목(바이어)
  business_field_codes: string[] // same data as category, for individual field filtering
  content_category: string | null // exhibitor single category code
  booth_label: string | null
  registered_by: string | null // 등록주체(무역관명 또는 "직접등록")
  meeting_count: number
  unavailable_slots: string[] // 미팅 불가 슬롯 id(`${YYYY-MM-DD}T${HH:MM}`)
  updated_at: string // ISO8601
}

// PATCH /organizations/{id} — 리스트 레벨 필드 정정(신청서 본문은 /profile로).
export type AdminOrganizationPatch = Partial<
  Pick<
    AdminOrganization,
    | "name_ko"
    | "name_en"
    | "country"
    | "contact_name"
    | "contact_email"
    | "contact_phone"
    | "category"
    | "booth_label"
    | "registered_by"
    | "application_status"
  >
>

// 신청서(프로필) — 슈퍼어드민이 인라인으로 편집하는 대상.
//
// 백엔드는 bm 슬라이스의 BuyerProfilePatch / ExhibitorProfilePatch를 그대로 재사용하고, 어느
// 스키마인지는 `?role=buyer|exhibitor` 쿼리로 가른다. **읽기 모델(AdminOrgProfile)**은 두 역할의
// 합집합 flat shape를 유지한다(admin-mock.ts가 이 shape로 픽스처를 만들므로 additive-only —
// 필드 삭제·rename 금지). 하지만 **쓰기는 role별 스키마가 extra="forbid"로 검증**하므로(다른 role
// 필드를 보내면 422) 쓰기 모델은 AdminOrgProfilePatch(아래, buyer/exhibitor union)로 따로 둔다.
export interface AdminOrgProfile {
  organization_id: string
  business_reg_no: string | null
  website: string | null
  representative_name: string | null
  company_email: string | null
  main_tel: string | null
  address: string | null
  country: string | null
  org_type: string | null // 참가자 구분
  annual_sales: string | null
  employee_range: string | null
  categories: string[] // 관심분야/전시품목
  company_intro_ko: string | null
  company_intro_en: string | null
  contact_name: string | null
  contact_title: string | null
  contact_email: string | null
  contact_phone: string | null
  contact_language: string | null
  interpreter_need: boolean
  budget_range: string | null // 바이어 전용
  adoption_timeline: string | null // 바이어 전용
  booth_label: string | null // 참가사 전용
  products: AdminExhibitorProductPatch[] // 참가사 전용 — 전시 제품 목록
  // 참가사 전용 — 상담 가능 언어(멀티, 슬라이드 6 '상담 가능 언어' 칩). 백엔드 ExhibitorStep2.
  available_languages: string[]
  // 참가사 전용 — 선호 바이어 국가·구분(대리작성 다이얼로그 '관심 바이어' 탭). 백엔드
  // ExhibitorStep4(preferred_buyer_countries/types) 미러. 바이어면 빈 배열.
  preferred_buyer_countries: string[]
  preferred_buyer_types: string[]
  updated_at: string // ISO8601
  // 참가사 전용 — 담당자·제품 전체 리스트 보존(전체교체 필드라 index0만 고쳐 쓰려면 나머지를
  // 들고 있어야 한다). 목록에 없으면(바이어이거나 미수집) undefined.
  exhibitor_attendees?: AdminExhibitorAttendeePatch[]
  exhibitor_products?: AdminExhibitorProductPatch[]
}

// ── 쓰기(PATCH/POST profile) 모델 — backend BuyerProfilePatch/ExhibitorProfilePatch 정본 미러 ──
//
// AdminOrgProfile(읽기, 위)과 의도적으로 decouple한다: role별 스키마는 extra="forbid"라 role에
// 안 맞는 필드를 보내면 422가 난다. admin-actions.ts는 이 값을 그대로 unknown 바디로 forward만
// 하므로(dispatch) 여기서 union으로 좁혀도 그쪽은 안전하다.
export interface AdminBuyerProfilePatch {
  business_reg_no?: string | null
  website?: string | null
  contact_name_ko?: string | null
  contact_title_ko?: string | null
  contact_email?: string | null
  contact_language?: string | null
  contact_interpreter_need?: boolean
  tel?: string | null
  address1?: string | null
  country?: string | null
  company_intro_ko?: string | null
  company_intro_en?: string | null
  org_types?: string[]
  interest_categories?: string[]
  annual_sales_range?: string
  employee_range?: string
  budget_range?: string
  adoption_timeline?: string
}

export interface AdminExhibitorAttendeePatch {
  last_name_ko?: string | null
  last_name_en?: string | null
  first_name_ko?: string | null
  first_name_en?: string | null
  title_ko?: string | null
  title_en?: string | null
  email?: string | null
  tel?: string | null
  mobile?: string | null
  languages?: string[]
}

export interface AdminExhibitorProductPatch {
  name_ko: string
  name_en?: string | null
  business_field?: string | null
  category_ko?: string | null
  category_en?: string | null
  hs_code?: string | null
  hs_description?: string | null
  spec?: string | null
  spec_en?: string | null
  price_range?: string | null
}

export interface AdminExhibitorProfilePatch {
  business_reg_no?: string | null
  website?: string | null
  representative_name_ko?: string | null
  company_email?: string | null
  main_tel?: string | null
  address_ko?: string | null
  intro_ko?: string | null
  intro_en?: string | null
  annual_sales_range?: string
  employee_range?: string
  available_languages?: string[] | null
  exhibition_categories?: string[]
  preferred_buyer_countries?: string[] | null
  preferred_buyer_types?: string[] | null
  attendees?: AdminExhibitorAttendeePatch[]
  products?: AdminExhibitorProductPatch[]
}

export type AdminOrgProfilePatch = AdminBuyerProfilePatch | AdminExhibitorProfilePatch

// PATCH .../unavailable-slots — 참가사별 미팅 불가 시간대(운영자 전용).
// ⚠ 본문 키는 `slots`(백엔드 확정). 부분 토글이 아니라 전체 치환이다.
export interface AdminUnavailableSlotsPatch {
  slots: string[] // `${YYYY-MM-DD}T${HH:MM}`
}

// PATCH .../organizations/{id}/role — 이 행사에서의 참가 역할 전환(바이어 ↔ 참가사).
// 역할은 organization_event_roles(회사×행사)에 사는 값이라 행사마다 다를 수 있다 — 같은 회사가
// 어떤 행사에선 참가사, 다른 행사에선 바이어일 수 있으므로 event 스코프 경로가 맞다.
export interface AdminOrgRolePatch {
  role: AdminOrgRole
}

// ── 운영자(Organizer) ────────────────────────────────────────────────────────

// 운영자 권한등급(ADR-0012, 계정×행사 단위).
//  · master = 슈퍼어드민 — 전역 CRUD. **DB에서만 부여**한다(이 콘솔에 부여 경로 없음).
//  · sub    = 서브어드민 — 관할 한정(자기 바이어 관리·신청서 대리작성), 거버넌스는 불가.
//             슈퍼어드민이 이 화면에서 부여·회수한다.
export type AdminPermissionLevel = "master" | "sub"
export const ADMIN_PERMISSION_LABELS: Record<AdminPermissionLevel, string> = {
  master: "슈퍼어드민",
  sub: "서브어드민",
}

export interface AdminOrganizer {
  id: string // organizer 레코드 id(회수 시 경로 키)
  event_id: string
  member_id: string
  // 표시 신원 — 백엔드가 회원 행(members)에서 채운다. 자리표시자·UUID는 오지 않는다(없으면 "이름 미등록"/"").
  name: string
  email: string
  permission_level: AdminPermissionLevel
  trade_office: string | null // sub(무역관) 관할 표시
  granted_at: string // ISO8601
}

// POST .../organizers — 서브어드민 부여.
// ⚠ permission_level은 "sub" 리터럴로 고정한다. master를 이 경로로 보내지 못하게 **타입에서**
//   막아, 실수로 UI가 슈퍼어드민을 부여하는 코드를 작성할 수 없게 한다.
// 대상은 **가입된 회원의 로그인 이메일**이다(2026-09-17) — 회원 UUID를 손으로 받던 예전 계약은
// 없는 ID도 유령 운영자로 만들었다. 백엔드는 없는 회원이면 404(MEMBER_NOT_FOUND)로 거절한다.
export interface AdminOrganizerGrantRequest {
  email: string
  permission_level: "sub"
}

// ── 미팅(Meeting) ────────────────────────────────────────────────────────────

export type AdminMeetingStatus = "scheduled" | "completed" | "cancelled" | "noshow"
export const ADMIN_MEETING_STATUSES: readonly AdminMeetingStatus[] = [
  "scheduled",
  "completed",
  "cancelled",
  "noshow",
]
export const ADMIN_MEETING_STATUS_LABELS: Record<AdminMeetingStatus, string> = {
  scheduled: "예정",
  completed: "완료",
  cancelled: "취소",
  noshow: "노쇼",
}

// 미팅 발생 경로(백엔드 meetings.matching_type CHECK 허용값 그대로, app/models.py). "ai"는 오늘
// 이 값을 쓰는 유일한 호출부인 포화배정 확정(assignment_service.confirm_saturation_run)과 사실상
// 동의어다(백엔드 주석 — meeting_booking.py의 _MATCHING_TYPE_TO_CHANNEL 참고, saturation_run_id
// 자체는 admin 목록 응답에 아직 안 내려온다) — 그래서 콘솔은 "ai"를 곧 포화배정으로 배지한다.
export type AdminMatchingType = "ai" | "open" | "forced" | "on_site"

export interface AdminMeeting {
  id: string
  event_id: string
  date: string // YYYY-MM-DD
  start_time: string // HH:MM
  slot_minutes: SlotMinutes
  exhibitor_id: string
  exhibitor_name: string
  buyer_id: string
  buyer_name: string
  status: AdminMeetingStatus
  // 목업 픽스처(admin-mock.ts)는 이 필드를 안 채운다 — optional로 둬 기존 mock 데이터가 그대로
  // 통과하게 한다(실연동만 채운다).
  matching_type?: AdminMatchingType
  venue_type: VenueType
  venue_label: string | null
  cancelled_by: string | null
  cancelled_reason: string | null
}

// POST /meetings/{id}/cancel — 운영자 강제 취소(양측에 meeting_cancelled 알림 발송).
export interface AdminMeetingCancelRequest {
  reason: string
}

// ── 알림(Notification) ───────────────────────────────────────────────────────

// N5: 참가자 쪽 정본(lib/home/notification.ts NotificationType, ADR-0010 type enum)을 그대로
// 재사용한다 — 예전엔 여기 별도로 6종을 복제해뒀다가 application_approved 추가를 놓쳐 운영자
// 알림 타입 필터에서만 빠졌다(.e2e-artifacts/e2e-verify-round.md N5). LABELS를
// Record<AdminNotificationType, string>로 두면 정본에 타입이 늘 때 여기 추가를 잊어도 빌드가 깨진다.
export type { AdminNotificationType }

export const ADMIN_NOTIFICATION_TYPES: readonly AdminNotificationType[] = [
  "meeting_requested",
  "meeting_accepted",
  "meeting_cancelled",
  "meeting_rejected",
  "meeting_reminder",
  "review_prompt",
  "review_ready",
  "application_approved",
]

export const ADMIN_NOTIFICATION_TYPE_LABELS: Record<AdminNotificationType, string> = {
  meeting_requested: "미팅 신청",
  meeting_accepted: "미팅 수락",
  meeting_cancelled: "미팅 취소",
  meeting_rejected: "미팅 거절",
  meeting_reminder: "미팅 리마인더",
  review_prompt: "후기 요청",
  review_ready: "회의록 준비",
  application_approved: "승인 완료",
}

export type AdminNotificationChannel = "in_app" | "email"
export const ADMIN_NOTIFICATION_CHANNELS: readonly AdminNotificationChannel[] = ["in_app", "email"]
export const ADMIN_NOTIFICATION_CHANNEL_LABELS: Record<AdminNotificationChannel, string> = {
  in_app: "인앱",
  email: "이메일",
}

export interface AdminNotificationLog {
  id: string
  event_id: string
  type: AdminNotificationType
  channel: AdminNotificationChannel
  recipient_org_id: string
  recipient_org_name: string
  meeting_id: string | null
  sent_at: string // ISO8601
  delivered: boolean
  resend_count: number
}

// ── 통역사(Interpreter) ──────────────────────────────────────────────────────

// 참가기업당 1명 배정. 통역사 1명이 여러 기업을 동시에 맡을 수는 없다(현장 동시 진행 불가) —
// assign은 기업 기준 단일 점유로 처리한다.
export interface AdminInterpreter {
  id: string
  event_id: string
  name: string
  languages: string[] // 예: ["영어", "베트남어"]
  phone: string | null
  email: string | null
  assigned_org_id: string | null
  assigned_org_name: string | null
}

export interface AdminInterpreterInput {
  name: string
  languages: string[]
  phone: string | null
  email: string | null
}

// POST .../interpreters/{id}/assign 본문. 해제는 본문이 아니라
// DELETE .../assign/{organization_id} 경로로 한다(계약 비대칭 — api-paths 참조).
export interface AdminInterpreterAssignRequest {
  organization_id: string
}

// ── 미팅 장소(Venue) ──────────────────────────────────────────────────────────

// 콘솔이 만들고 고칠 수 있는 장소 종류. VenueType에서 booth를 뺀 좁은 집합이다 — 참가사 부스
// 장소는 미팅 신청 시점에 자동 생성되는 파생물이라 이 CRUD의 대상이 아니다(백엔드
// ManageableVenueType과 1:1).
export type ManageableVenueType = "zone_table" | "business_room"
export const MANAGEABLE_VENUE_TYPES: readonly ManageableVenueType[] = [
  "zone_table",
  "business_room",
]

// GET .../venues 행. **라벨 순으로 내려온다** — 그 순서가 곧 실제 배정 순서다(백엔드
// meetings.service._resolve_venue가 후보 중 빈 첫 장소를 고른다).
export interface AdminVenue {
  id: string
  event_id: string
  venue_type: ManageableVenueType
  label: string
  // 이 장소를 참조하는 미팅 수(상태 무관). 0이 아니면 DELETE가 409(VENUE_IN_USE)로 막힌다.
  meeting_count: number
}

// POST .../venues 본문.
export interface AdminVenueInput {
  venue_type: ManageableVenueType
  label: string
}

// PATCH .../venues/{id} 본문 — 라벨만 바꾼다. venue_type을 바꾸는 건 수정이 아니라 다른 장소를
// 만드는 일이라 백엔드가 필드 자체를 받지 않는다.
export type AdminVenuePatch = Pick<AdminVenueInput, "label">

// ── 대시보드 ─────────────────────────────────────────────────────────────────

export interface AdminActivity {
  id: string
  at: string // ISO8601
  actor: string // 행위 주체 표시명(운영자명 또는 기업명)
  summary: string
}

export interface AdminDashboard {
  event_id: string
  org_total: number
  exhibitor_count: number
  buyer_count: number
  unsubmitted_count: number // application_status === "registered"
  meeting_total: number
  meeting_scheduled: number
  notification_sent: number
  recent_activity: AdminActivity[]
}

// ── 엑셀 입출력 ──────────────────────────────────────────────────────────────

export type AdminExportKind = "organizations" | "meetings" | "reviews"
