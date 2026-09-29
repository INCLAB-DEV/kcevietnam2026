import "server-only"

import { redirect } from "next/navigation"

// 미팅 화면(F-MY-001/F-MT-001)의 **실연동 구현** — FastAPI /api/meetings/* 를 서버에서 직접 호출한다.
// (mock 구현은 lib/meeting/my-meetings-mock.ts·mock-availability.ts. 스왑 조건·읽기 어댑터는
// lib/api-client/server.ts의 getMyMeetings/getMeetingAvailability 참고 — admin/http-client.ts와
// 같은 패턴: 인증 헤더는 로그인 BFF가 심은 httpOnly 세션 쿠키를 서버에서 읽어 붙인다.)
//
// role 문제: 백엔드는 principal(JWT/데모 토큰)에서 org를 스스로 도출하므로 이 어댑터의 API 호출
// 자체엔 "내 org id"가 필요 없다. 실 세션 판정 자체는 lib/auth/http-session.ts(resolveHttpSession)로
// 승격됐다 — Discover·홈도 함께 쓰는 도메인 중립 헬퍼(원래 이 파일 전용이었다).
//
// ⚠ 상대 기업 디렉터리(getOrganizations/getOrganization)도 이제 실연동이라(P1-2, Discover 실
//   디렉터리) 우측 패널(buildMeetingPanels)이 그 목록에서 상대 org를 바로 찾는다 — 예전엔
//   디렉터리가 mock 전용이라 MeetingOut.counterpart_name만으로 스텁을 만들었지만(counterpartStubOrgs)
//   더 이상 필요 없어 제거했다(app/meetings/page.tsx 참고).

import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"
import type {
  AcceptanceMode,
  MeetingAvailability,
  MeetingDate,
  TimeSlot,
  VenueKind,
  VenueOption,
} from "@/lib/meeting/types"
import type { ViewerRole } from "@/lib/types"
import type { Locale } from "@/lib/i18n/config"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

async function meetingsFetch<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const res = await fetch(`${BACKEND_URL}/api/meetings${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  })
  // 401(세션 만료·무효)은 500 페이지가 아니라 재인증으로 흘려보낸다 — organizer read 클라이언트와
  // 동일 원칙. 토큰을 들고 갔는데 백엔드가 거부한 경우라 화면이 할 수 있는 일은 재로그인뿐이다.
  if (res.status === 401) redirect("/login")
  if (!res.ok) {
    throw new Error(`meetings read failed: GET ${path} (${res.status})`)
  }
  return (await res.json()) as T
}

// ── 백엔드 응답 형상(snake_case) ──────────────────────────────────────────────
interface MeetingOutSnake {
  id: string
  status: string
  scheduled_start: string | null
  scheduled_end: string | null
  duration_minutes: number | null
  exhibitor_org_id: string
  buyer_org_id: string
  requested_by: "exhibitor" | "buyer" | "organizer" | null
  requested_by_org_id: string | null
  counterpart_name: string
  venue_type: string | null
  venue_label: string | null
  has_review: boolean
  attended: boolean | null
  request_reason: string | null
}

interface MeetingListResponseSnake {
  items: MeetingOutSnake[]
  total: number
  limit: number
  offset: number
}

// 장소 유형(캐노니컬) → 표시용 기본 라벨. venue_label이 없을 때만 쓴다(booth는 보통 항상 라벨이 있다).
const VENUE_TYPE_FALLBACK_LABEL: Record<string, string> = {
  booth: "참가사 부스",
  zone_table: "비즈매칭존 테이블",
  business_room: "비즈니스 룸",
}

function venueDisplay(venueType: string | null, venueLabel: string | null): string {
  if (venueLabel) return venueLabel
  if (venueType) return VENUE_TYPE_FALLBACK_LABEL[venueType] ?? venueType
  return ""
}

// MeetingOut(snake) → MeetingRecord(camel, F-MY-001 화면 계약). scheduled_start가 없으면(계약상
// 이론적으로만 가능 — 슬롯 없이는 미팅이 만들어지지 않는다) 화면에 못 그리므로 null을 반환해
// 호출부가 걸러낸다.
export function toMeetingRecord(m: MeetingOutSnake): MeetingRecord | null {
  if (!m.scheduled_start) return null
  return {
    id: m.id,
    status: m.status as ScheduleStatus,
    hasReview: m.has_review,
    attended: m.attended ?? undefined,
    scheduledAt: m.scheduled_start,
    durationMinutes: m.duration_minutes ?? undefined,
    buyerOrgId: m.buyer_org_id,
    exhibitorOrgId: m.exhibitor_org_id,
    requestedByOrgId: m.requested_by_org_id,
    requestedBy: m.requested_by,
    counterpartName: m.counterpart_name,
    venue: venueDisplay(m.venue_type, m.venue_label),
    requestReason: m.request_reason,
  }
}

// GET /api/meetings — event_id 생략 시 내 org의 event role이 1개면 백엔드가 자동 해석한다
// (여러 행사에 걸쳐 있으면 400 EVENT_AMBIGUOUS — 데모는 행사가 하나라 발생하지 않는다).
export async function fetchMyMeetings(): Promise<MeetingRecord[]> {
  const data = await meetingsFetch<MeetingListResponseSnake>("?limit=100")
  const records: MeetingRecord[] = []
  for (const item of data.items) {
    const rec = toMeetingRecord(item)
    if (rec) records.push(rec)
  }
  return records
}

// GET /api/meetings/{id} — 단건 조회(F-MY-002 회의록 상세). 존재 안 하거나 내 org가 참석자가
// 아니면(403) 둘 다 null로 뭉갠다(discover의 fetchDiscoverOrganization과 동일 원칙 — 존재 여부를
// 굳이 구분해 노출하지 않는다). 호출부(app/meetings/[meetingId]/page.tsx)가 null이면 notFound().
export async function fetchMeetingById(meetingId: string): Promise<MeetingRecord | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const res = await fetch(`${BACKEND_URL}/api/meetings/${meetingId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  })
  if (res.status === 404 || res.status === 403) return null
  if (res.status === 401) redirect("/login")
  if (!res.ok) {
    throw new Error(`meetings read failed: GET /${meetingId} (${res.status})`)
  }
  return toMeetingRecord((await res.json()) as MeetingOutSnake)
}

// ── 가용성(AvailabilityOut) ───────────────────────────────────────────────────
interface TimeSlotOutSnake {
  id: string
  time: string
  available: boolean
}
interface MeetingDateOutSnake {
  id: string
  label: string
  weekday: string
  morning: TimeSlotOutSnake[]
  afternoon: TimeSlotOutSnake[]
}
interface VenueBadgeOutSnake {
  text: string
  tone: "available" | "limited" | "unavailable"
}
interface VenueNumberOutSnake {
  value: string
  available: boolean
}
interface VenueOptionOutSnake {
  kind: "booth" | "zone_table" | "business_room"
  name: string
  description: string
  badge?: VenueBadgeOutSnake | null
  numbers?: VenueNumberOutSnake[] | null
}
interface AvailabilityOutSnake {
  dates: MeetingDateOutSnake[]
  venues: VenueOptionOutSnake[]
  draft_reason: string
  acceptance_mode: AcceptanceMode
  slot_minutes: number
  // 격자 모양의 나머지 두 축(mt003gap0001). TimeSlotOutSnake가 시작 시각만 싣기 때문에
  // 종료 시각·소요시간·연속 상한은 이 값들로 계산한다. 백엔드 AvailabilityOut과 1:1.
  slot_gap_minutes: number
  max_meeting_minutes: number
  timezone: string
}

// 백엔드 캐노니컬 장소 어휘 → 모달 UI 계약(VenueKind). 프런트 모달·행사설정이 쓰는 별칭 체계라
// mock-availability.ts의 VENUE_TYPE_TO_KIND와 이름은 다르지만 같은 매핑이다.
const CANONICAL_TO_VENUE_KIND: Record<VenueOptionOutSnake["kind"], VenueKind> = {
  booth: "booth",
  zone_table: "table",
  business_room: "room",
}

function toTimeSlot(s: TimeSlotOutSnake): TimeSlot {
  return { id: s.id, time: s.time, available: s.available }
}

function toMeetingDate(d: MeetingDateOutSnake): MeetingDate {
  return {
    id: d.id,
    label: d.label,
    weekday: d.weekday,
    morning: d.morning.map(toTimeSlot),
    afternoon: d.afternoon.map(toTimeSlot),
  }
}

function toVenueOption(v: VenueOptionOutSnake): VenueOption {
  return {
    kind: CANONICAL_TO_VENUE_KIND[v.kind],
    name: v.name,
    description: v.description,
    badge: v.badge ? { text: v.badge.text, tone: v.badge.tone } : undefined,
    numbers: v.numbers?.map((n) => ({ id: n.value, label: n.value, available: n.available })),
  }
}

export function toMeetingAvailability(a: AvailabilityOutSnake): MeetingAvailability {
  return {
    dates: a.dates.map(toMeetingDate),
    venues: a.venues.map(toVenueOption),
    draftReason: a.draft_reason,
    acceptanceMode: a.acceptance_mode,
    // 폴백값은 mt003gap0001 이전의 실효 기본(텀 없음·상한 90분)이다. undefined를 그대로 흘리면
    // 아래 산술이 NaN이 되어 화면이 조용히 빈 격자를 그리므로, 여기서 막는다.
    slotMinutes: a.slot_minutes ?? 30,
    slotGapMinutes: a.slot_gap_minutes ?? 0,
    maxMeetingMinutes: a.max_meeting_minutes ?? 90,
  }
}

// GET /api/meetings/availability?counterpart_org_id=&my_role= — my_role을 실어 ROLE_AMBIGUOUS(내
// org가 이 행사에서 buyer/exhibitor 역할을 둘 다 갖는 극단 케이스)를 피한다.
export async function fetchMeetingAvailability(
  counterpartOrgId: string,
  myRole: ViewerRole,
  locale: Locale
): Promise<MeetingAvailability> {
  const query = new URLSearchParams({
    counterpart_org_id: counterpartOrgId,
    my_role: myRole,
    locale,
  })
  const data = await meetingsFetch<AvailabilityOutSnake>(`/availability?${query.toString()}`)
  return toMeetingAvailability(data)
}
