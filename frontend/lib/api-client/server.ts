import "server-only"

import { getLocale, getTranslations } from "next-intl/server"

import type { ReadApiClient, User, Meeting } from "./types"

// 서버 전용 read 클라이언트. `server-only`로 봉인 — client component가 import하면 빌드 타임에
// 실패한다. 덕분에 아래 read 어댑터가 끌어오는 mock 픽스처(기업 디렉터리·명단·일정)와 점수
// 휴리스틱(computeRecommendations)이 클라이언트 모듈 그래프·`.next/static/chunks`에 영영
// 들어오지 않는다(frontend ADR-0001). 읽기는 서버 컴포넌트(app/*/page.tsx)에서만 호출한다.
//
// 봉인이 클라 노출을 막아주므로 read 픽스처는 정적 import로 가져온다(예전 mock.ts의 동적 import
// 트릭은 더 이상 필요 없다 — 경계를 `server-only`가 강제). 실연동 시 이 어댑터 1개만 FastAPI로
// 교체하면 호출처(서버 page들)는 그대로다(ADR-0008, 단일 변경점 수렴).

import { ALL_MOCK_ORGS, MOCK_BUYERS, MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { visibleOrgs } from "@/lib/discover/visibility"
import { getEventSettings as getMockEventSettings } from "@/lib/event/event-settings"
import { computeRecommendations } from "./recommendations"
import { buildMockHomeInput, buildMockNotifications } from "@/lib/home/home-mock"
import { buildMockTimelineMeetings, EVENT_DATES } from "@/lib/meeting/my-meetings-mock"
import { MOCK_MEMBERS } from "@/lib/organizer/members-mock"
import { MOCK_MEMBER_PROFILES } from "@/lib/organizer/member-profiles-mock"
import { aggregateOpsMetrics } from "@/lib/organizer/ops-metrics"
import { saturationRunStatus } from "@/lib/organizer/saturation-status"
import { MOCK_OPS_METRICS_INPUT, MOCK_SATURATION_RUNS } from "@/lib/organizer/ops-metrics-mock"
import { buildMeetingAvailability } from "@/lib/meeting/mock-availability"
import { fetchMeetingAvailability, fetchMyMeetings } from "@/lib/meeting/http-meetings-client"
import { buildEventDates } from "@/lib/meeting/event-dates"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { resolveLocale } from "@/lib/i18n/config"
import { fetchMe } from "@/lib/auth/me-client"
import {
  fetchDiscoverOrganization,
  fetchDiscoverOrganizations,
  fetchViewerOrganization,
} from "@/lib/discover/http-discover-client"
import { fetchHomeNotifications } from "@/lib/home/http-notifications-client"
import { buildAssignmentSchedule } from "@/lib/organizer/assignment-mock"
import { listStoredAssignments } from "@/lib/organizer/assignment-store"
import { getStatusOverride, listStatusOverrides } from "@/lib/organizer/member-status-store"
import {
  fetchOrganizerMember,
  fetchOrganizerMemberProfiles,
  fetchOrganizerMembers,
  resolveOrganizerToken,
} from "@/lib/organizer/http-members-client"
import { fetchOpsMetricsInput } from "@/lib/organizer/http-ops-metrics-client"
import {
  fetchAssignmentSchedule,
  fetchOrganizationSchedule,
} from "@/lib/organizer/http-assignment-schedule-client"
import { indexOrgs } from "@/lib/organizer/assignment-schedule"

const USERS: Record<string, User> = {
  "user-buyer-01": { id: "user-buyer-01", name: "김바이어", role: "buyer", email: "buyer01@example.com" },
  "user-exhibitor-01": { id: "user-exhibitor-01", name: "이참가사", role: "exhibitor", email: "exhibitor01@example.com" },
  "user-organizer-01": { id: "user-organizer-01", name: "정세훈", role: "organizer", email: "organizer01@example.com" },
}

const MEETINGS: Meeting[] = [
  { id: "mtg-001", title: "콘텐츠 유통 상담", status: "confirmed", scheduledAt: "2026-09-03T10:00:00+09:00", buyerId: "user-buyer-01", exhibitorId: "user-exhibitor-01" },
  { id: "mtg-002", title: "OTT 라이선싱 미팅", status: "pending", scheduledAt: "2026-09-03T14:00:00+09:00", buyerId: "user-buyer-01", exhibitorId: "user-exhibitor-01" },
]

export const serverApiClient: ReadApiClient = {
  async getUser(userId) {
    const user = USERS[userId]
    if (!user) throw new Error(`User not found: ${userId}`)
    return user
  },

  async getMeetings(userId) {
    return MEETINGS.filter((m) => m.buyerId === userId || m.exhibitorId === userId)
  },

  // 방향별 가시성을 여기(데이터 접근 계층)에서 일괄 적용 — 화면 계층엔 이미 걸러진 목록만 내려가므로
  // 탭·컴포넌트가 필터를 깜빡해도 우회 경로가 생기지 않는다(F-DV-001, 베트남 전시 정책).
  // 실연동(P1-2, ADR-0008): 실 세션이면 FastAPI 디렉터리를 그대로 쓴다 — 가시성은 백엔드가 이미
  // 적용했으므로 visibleOrgs 재적용은 무해한 이중 필터(그대로 유지, 우회 경로 차단 원칙과 동일).
  async getOrganizations(viewerRole) {
    const real = await resolveHttpSession()
    if (real) return fetchDiscoverOrganizations()
    const settings = getMockEventSettings()
    return visibleOrgs(viewerRole, ALL_MOCK_ORGS, settings.allowSameRoleDiscovery)
  },

  async getOrganization(orgId) {
    const real = await resolveHttpSession()
    if (real) return fetchDiscoverOrganization(orgId)
    return ALL_MOCK_ORGS.find((o) => o.id === orgId) ?? null
  },

  // 세션 orgId↔기업 id 1:1 매핑 전 임시 shim(역할별 첫 기업). 실연동(P1-2): org 쿠키(로그인 BFF가
  // /api/me로 심은 nabi_session_org)로 자기 org를 조회한다.
  async getViewerOrg(role) {
    const real = await resolveHttpSession()
    if (real) return fetchViewerOrganization()
    return role === "buyer" ? MOCK_BUYERS[0] : MOCK_EXHIBITORS[0]
  },

  async getEventSettings() {
    return getMockEventSettings()
  },

  // 점수계산 휴리스틱은 서버에서만 실행한다. 실연동 시 이 한 메서드를 FastAPI 매처 호출로
  // 교체(호출처는 그대로). (#88, ADR-0008)
  // 추천 사유 문장은 discover 네임스페이스로 로케일에 맞게 조립한다(2026-09-13, EN 전환 시
  // 한국어 잔존 정리 — 예전엔 t 없이 호출해 한국어가 고정 박혀 있었다).
  async getRecommendations(viewer, candidates) {
    const t = await getTranslations("discover")
    return computeRecommendations(viewer, candidates, t)
  },

  // 실연동(P1-3): 실 세션이면 fetchMyMeetings(미팅 실연동과 동일 엔드포인트)를 재사용한다 —
  // 백엔드가 이미 "내 org가 낀 미팅만" 필터링해 내려주므로 홈 집계(buildHomeDashboardData)가 그대로
  // viewerOrgId(=org 쿠키)로 한 번 더 거른다.
  async getHomeDashboard(viewer, today) {
    const real = await resolveHttpSession()
    if (real) {
      const meetings = await fetchMyMeetings()
      return { viewerRole: viewer.role, viewerOrgId: viewer.orgId, meetings, today }
    }
    return buildMockHomeInput(today, viewer)
  },

  // 실연동(P1-3): GET /api/notifications → payload 스냅샷을 next-intl 메시지로 조립(notification-composer).
  async getHomeNotifications(viewer, today) {
    const real = await resolveHttpSession()
    if (real) return fetchHomeNotifications()
    return buildMockNotifications(today, viewer)
  },

  // 실연동(ADR-0008): NEXT_PUBLIC_AUTH_CLIENT==="http" + 실 세션 쿠키가 있을 때만 FastAPI를 호출
  // (어드민 read seam과 같은 스위치를 쓰되, 그 뒤에 세션 존재 여부까지 한 번 더 본다 — 이유는
  // lib/auth/http-session.ts 참고). 아니면 기존 mock(?as= 개발 스위치)
  // 그대로 — viewer는 mock 경로에서만 쓰인다(http 경로는 principal에서 org를 스스로 도출한다).
  async getMyMeetings(viewer) {
    const real = await resolveHttpSession()
    if (real) return fetchMyMeetings()
    return buildMockTimelineMeetings(viewer)
  },

  // 미팅 타임라인 날짜 탭 — 실 세션이면 백엔드 행사 기간(/api/me의 exhibition_start/end)으로 만든다.
  // 상수(EVENT_DATES)로 두면 행사일이 바뀌는 순간 그날 잡힌 실 미팅이 buildTimeline에서 조용히
  // 버려진다(timeline.ts). 값이 없거나 형식이 어긋나면 mock 상수로 폴백한다.
  async getEventDates() {
    const real = await resolveHttpSession()
    if (real) {
      const me = await fetchMe()
      const role = me?.roles?.[0]
      // 격자 모양도 함께 넘긴다 — 이게 없으면 timeline.ts 가 30분/텀0 으로 폴백해 40분/텀5분
      // 행사에서 미팅이 잘못된 행에 그려진다(mt003gap0001). 값이 없으면 buildEventDates 가 필드를
      // 생략하므로 기존 폴백 경로가 그대로 산다.
      const dates = buildEventDates(role?.exhibition_start, role?.exhibition_end, {
        slotMinutes: role?.slot_minutes,
        slotGapMinutes: role?.slot_gap_minutes,
      })
      if (dates) return dates
    }
    return EVENT_DATES
  },

  // 실연동(OP-002): organizer는 resolveHttpSession(buyer/exhibitor ROLE_COOKIE 전용) 대상이
  // 아니다 — SESSION_COOKIE 존재만으로 실세션을 판정한다(OP-003 상태변경 라우트·OP-005 배정
  // 프록시와 동일 원칙, lib/organizer/http-members-client.ts 참고). 없으면 기존 mock 그대로.
  async getMembers() {
    const token = await resolveOrganizerToken()
    if (token) return fetchOrganizerMembers(token)
    // OP-003: 승인 심사 결정 store(PATCH /api/organizer/members/{id}/status)를 픽스처 위에
    // 덮어써 새로고침 후에도 결정이 유지된다.
    const overrides = listStatusOverrides()
    return MOCK_MEMBERS.map((m) =>
      overrides[m.id] ? { ...m, applicationStatus: overrides[m.id] } : m,
    )
  },

  async getMember(orgId) {
    const token = await resolveOrganizerToken()
    if (token) return fetchOrganizerMember(token, orgId)
    const found = MOCK_MEMBERS.find((m) => m.id === orgId) ?? null
    if (!found) return null
    const override = getStatusOverride(found.id)
    return override ? { ...found, applicationStatus: override } : found
  },

  async getMemberProfiles() {
    const token = await resolveOrganizerToken()
    if (token) return fetchOrganizerMemberProfiles(token)
    return MOCK_MEMBER_PROFILES
  },

  // OP-001 운영 대시보드(#56) — 집계는 서버에서만 실행한다(ADR-0008 경계 B). 실연동(#53): 실
  // organizer 세션이면 FastAPI 원시 집계(GET .../ops-metrics)를 읽어 그대로 같은 순수 집계
  // (aggregateOpsMetrics/saturationRunStatus)에 먹인다 — getMembers와 동일한 실HTTP↔mock 분기.
  async getOpsDashboard() {
    const token = await resolveOrganizerToken()
    if (token) {
      const { input, saturationRuns, scope } = await fetchOpsMetricsInput(token)
      return { metrics: aggregateOpsMetrics(input), saturation: saturationRunStatus(saturationRuns), scope }
    }
    return {
      metrics: aggregateOpsMetrics(MOCK_OPS_METRICS_INPUT),
      saturation: saturationRunStatus(MOCK_SATURATION_RUNS),
    }
  },

  async getMeetingAvailability(recipient, locale) {
    const real = await resolveHttpSession()
    if (real) return fetchMeetingAvailability(recipient.id, real.role, locale ?? resolveLocale(await getLocale()))
    return buildMeetingAvailability(recipient)
  },

  // 실연동(OP-005 Phase 6): organizer 실세션이면 FastAPI 배정 스케줄 조회(GET .../assignment-
  // schedule)를 읽는다 — getOpsDashboard/getMembers와 동일한 실HTTP↔mock 분기(SESSION_COOKIE
  // 존재만으로 판정, resolveOrganizerToken). mock 픽스처/실 데이터 위에 확정 배정 store(POST
  // /api/organizer/assignments·/saturation/confirm)를 그대로 병합한다 — 새로고침 후에도 확정분이
  // 유지된다. 실세션에서도 이 store가 필요하다: 강제배정 단건은 백엔드에 직접 쓰이지만(app/api/
  // organizer/assignments/route.ts), 단일기업 AI 재보충(confirmSingleFill)은 아직 backend Phase
  // 3/4 계약 밖이라 실세션에서도 이 인메모리 store로 폴백한다(그 route.ts 주석 참고, 미해결 항목).
  async getAssignmentSchedule() {
    const token = await resolveOrganizerToken()
    const data = token ? await fetchAssignmentSchedule(token) : buildAssignmentSchedule()
    const stored = listStoredAssignments()
    if (stored.length === 0) return data
    const known = new Set(data.meetings.map((m) => m.id))
    return { ...data, meetings: [...data.meetings, ...stored.filter((m) => !known.has(m.id))] }
  },

  // OP-003 기업 디테일 일정(조회) — 실세션이면 FastAPI 기업 단위 일정(관할 검사, sub도 가능). mock은
  // 관할 개념이 없는 행사 전체 픽스처라 그대로 쓰고, 픽스처에 없는 기업만 not_found로 돌려준다.
  async getOrganizationSchedule(organizationId) {
    const token = await resolveOrganizerToken()
    if (token) return fetchOrganizationSchedule(token, organizationId)
    const data = buildAssignmentSchedule()
    return indexOrgs(data)[organizationId] ? { status: "ok", data } : { status: "not_found" }
  },
}
