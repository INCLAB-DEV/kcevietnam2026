// 미팅 상세 패널(F-MY-001 D10) 투영 — 좌측 타임라인에서 고른 미팅의 우측 패널 데이터를 만든다.
// 입력(미팅·상대 조직·매칭·참석자)에서 "무엇을 보여줄지"를 결정하고, 화면은 결과를 그리기만 한다.
// 매칭 점수/이유는 discover와 동일하게 ai-engine을 재사용한다. 권한 경계는 viewerOrgId로 한 번 더 거른다.
// 백엔드(#33)가 붙기 전엔 mock 조직/참석자를 주입받아 동작한다 — 실연동 시 입력만 API 결과로 교체.

import { computeRecommendations } from "@/lib/api-client/recommendations"
import { BUYER_TYPE_LABELS } from "@/lib/types"
import type { Organization, OrgRole, ViewerRole } from "@/lib/types"
import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus, RequestDirection } from "@/lib/home/meeting-status-rollup"
import {
  toneFor,
  labelFor,
  actionsFor,
  isExpiredProposed,
  isEndedAccepted,
  kstDate,
  kstTime,
  addMinutes,
  type SlotTone,
  type SlotAction,
  type EventDate,
} from "./timeline"
import { resolveDirection, STATUS_FALLBACK_KO, type Translator } from "./meeting-projection"

// t 미주입 호출부(단위 테스트·organizer 슬라이드 등 i18n 범위 밖) 보존용 한국어 폴백 — messages/ko.json의
// meeting.direction·meeting.typeLabel과 동일 문구를 유지한다. status.*는 meeting-projection의
// STATUS_FALLBACK_KO를 그대로 재사용(중복 제거) — "status." 접두어를 벗겨 조회한다.
const PANEL_FALLBACK_KO: Record<string, string> = {
  "direction.sent": "내가 신청",
  "direction.received": "상대가 신청",
  "direction.organizer": "운영자 배정",
  "typeLabel.exhibitor": "참가사",
  "typeLabel.buyer": "바이어",
}
const defaultPanelT: Translator = (key, values) => {
  if (key === "typeLabel.buyerTyped") return `${values?.type ?? ""} 바이어`
  if (key.startsWith("status.")) return STATUS_FALLBACK_KO[key.slice("status.".length)] ?? key
  return PANEL_FALLBACK_KO[key] ?? key
}

// 참석 Member(양측 담당자). side=우리/상대.
export interface PanelMember {
  side: "us" | "them"
  name: string
  title: string
}

export interface PanelMatch {
  score: number
  reasons: string[]
}

// 상대 기업 요약 — 패널 헤더(이름·유형·한줄)용. 전시제품·실적 등 상세 필드는 여기서 재정의하지
// 않는다: "기업 상세 보기"가 공통 OrgDetailBody를 모달로 띄우고 org 원본을 그대로 쓴다(중복 제거).
export interface PanelCounterpart {
  id: string
  name: string
  role: OrgRole
  typeLabel: string // "참가사" | "초청 바이어" 등
  oneLiner?: string // 참가사=강점 / 바이어=소개
}

export interface MeetingPanelView {
  meetingId: string
  status: ScheduleStatus
  tone: SlotTone
  statusLabel: string
  // 회의록이 이미 작성된 완료 미팅(참석) — 액션 버튼을 "회의록 작성"이 아니라 "회의록 보기"로 띄운다.
  reviewDone: boolean
  direction: RequestDirection
  directionLabel: string // "내가 신청" | "상대가 신청"
  time: string // 시작 "10:00"
  endTime: string // 종료 "11:30" (소요시간 반영)
  venue: string
  // 신청 메시지 — 신청 당시 적은 사유(request_reason). 없거나(운영자 배정 슬라이드처럼 아직
  // 데이터가 없는 호출부) 미기재면 undefined/null(H-03).
  requestReason?: string | null
  actions: SlotAction[]
  counterpart: PanelCounterpart
  // 상대 기업 원본 — "기업 상세 보기"가 공통 상세 모달(OrgDetailBody)에 그대로 넘긴다.
  org: Organization
  viewerRole: ViewerRole // 상세 모달의 액션 판정(참가자=매칭 가능)
  match: PanelMatch | null
  members: PanelMember[]
  detailHref: string // 기업 상세(discover) 풀페이지 링크 — 모달 provider 없을 때의 폴백
}

// 빈 상태(우측 패널): find-partner=지금 이후 예정 없음+잔여 슬롯 있음(아직 잡을 수 있음),
// no-meetings=예정 없음+잔여 슬롯 없음(행사 종료 등),
// empty-slot=타임라인에서 빈 시간대를 직접 선택했을 때(그 시간대로 기업 탐색 유도).
export type PanelEmptyKind = "find-partner" | "no-meetings" | "empty-slot"

export interface PanelInput {
  viewerRole: ViewerRole
  viewerOrgId: string
  viewerOrg: Organization | null // 매칭 점수 계산용(없으면 match=null)
  viewerMember: PanelMember | null // 우리측 참석자(세션 사용자)
  meetings: MeetingRecord[]
  orgs: Organization[] // 상대 기업 조회용
  contacts: Record<string, { name: string; title: string }> // orgId → 상대측 담당자
  now?: { date: string; time: string } // 만료(수락 전 시간 지남) 표시용
  // "meeting" 네임스페이스 번역기(status.*·direction.*·typeLabel.* 하위키로 조회) — 미주입 시
  // 한국어 폴백(defaultPanelT, 운영자 슬라이드 등 t 없이 호출하는 곳 보존).
  t?: Translator
  // "discover" 네임스페이스 번역기 — computeRecommendations의 AI 추천 사유 문장 로케일 처리용
  // (2026-09-13, EN 전환 시 한국어 잔존 정리). 미주입 시 computeRecommendations 자체 한국어 폴백.
  discoverT?: Translator
}

// 미팅에서 viewer가 아닌 쪽(상대) org id. 참가사↔참가사 등 어떤 조합이든 "내가 아닌 쪽"으로 판정.
// export: http-meetings-client가 실 데이터(상대 org 디렉터리 없음)에 대해 같은 판정으로 임시
// org 스텁을 만들 때 재사용한다(중복 정의 방지).
export function counterpartOrgId(m: MeetingRecord, viewerOrgId: string): string {
  return m.buyerOrgId === viewerOrgId ? m.exhibitorOrgId : m.buyerOrgId
}

function typeLabelFor(org: Organization, t: Translator): string {
  if (org.role === "exhibitor") return t("typeLabel.exhibitor")
  return org.buyerType
    ? t("typeLabel.buyerTyped", { type: BUYER_TYPE_LABELS[org.buyerType] })
    : t("typeLabel.buyer")
}

// Organization → 패널 상대 기업 정보. OP-005/OP-003 운영자 슬라이드도 이 변환을 재사용한다.
// t 미주입 시 한국어 폴백(defaultPanelT) — 운영자 슬라이드 등 t 없이 호출하는 곳 보존.
export function toCounterpart(org: Organization, t: Translator = defaultPanelT): PanelCounterpart {
  const isExhibitor = org.role === "exhibitor"
  return {
    id: org.id,
    name: org.name,
    role: org.role,
    typeLabel: typeLabelFor(org, t),
    oneLiner: isExhibitor ? org.strength : org.description,
  }
}

// meetingId → 패널 뷰 맵. 화면(클라이언트)은 선택된 미팅의 뷰만 골라 그린다.
export function buildMeetingPanels(input: PanelInput): Record<string, MeetingPanelView> {
  const t = input.t ?? defaultPanelT
  // labelFor는 "meeting.status" 스코프 번역기를 기대한다 — 여기 t는 "meeting" 스코프라 접두어를 벗겨 넘긴다.
  const statusT: Translator = (key, values) => t(`status.${key}`, values)
  const result: Record<string, MeetingPanelView> = {}
  const orgById = new Map(input.orgs.map((o) => [o.id, o]))
  const mine = input.meetings.filter(
    (m) => m.buyerOrgId === input.viewerOrgId || m.exhibitorOrgId === input.viewerOrgId
  )

  for (const m of mine) {
    const cpId = counterpartOrgId(m, input.viewerOrgId)
    const org = orgById.get(cpId)
    if (!org) continue // 상대 조직 정보가 없으면 패널을 만들 수 없다

    const direction: RequestDirection = resolveDirection(m.requestedByOrgId, input.viewerOrgId)

    let match: PanelMatch | null = null
    if (input.viewerOrg) {
      const [r] = input.discoverT
        ? computeRecommendations(input.viewerOrg, [org], input.discoverT)
        : computeRecommendations(input.viewerOrg, [org])
      if (r) match = { score: r.aiScore, reasons: r.aiReasons }
    }

    const members: PanelMember[] = []
    if (input.viewerMember) members.push(input.viewerMember)
    const them = input.contacts[cpId]
    if (them) members.push({ side: "them", name: them.name, title: them.title })

    // 만료(수락 전 시간 지남): 패널도 회색·"응답 시간 지남"·액션 없음(타임라인과 동일 판정).
    const expired = isExpiredProposed(m.status, m.scheduledAt, input.now)
    const ended = isEndedAccepted(m.status, m.scheduledAt, m.durationMinutes, input.now)
    const attended = m.attended ?? true // completed의 결과 속성(false=노쇼). 타임라인과 동일.

    const directionKey = direction === "sent" ? "sent" : direction === "received" ? "received" : "organizer"

    result[m.id] = {
      meetingId: m.id,
      status: m.status,
      tone: expired ? "gray" : toneFor(m.status, { attended, hasReview: m.hasReview, ended }),
      statusLabel: expired ? statusT("expired") : labelFor(m.status, direction, { attended, hasReview: m.hasReview, ended }, statusT),
      // accepted도 회의록을 쓸 수 있으므로(2026-09-14 결정) "회의록 보기" 라벨 판정에 포함한다.
      // completed의 노쇼(attended=false)는 기존대로 제외 — 노쇼면 회의록이 아니라 참석 정정이 먼저다.
      reviewDone: (m.status === "accepted" || (m.status === "completed" && attended)) && m.hasReview,
      direction,
      directionLabel: t(`direction.${directionKey}`),
      time: kstTime(m.scheduledAt),
      endTime: addMinutes(kstTime(m.scheduledAt), m.durationMinutes ?? 30),
      venue: m.venue,
      requestReason: m.requestReason ?? null,
      actions: expired ? [] : actionsFor(m.status, direction, input.viewerRole, attended),
      counterpart: toCounterpart(org, t),
      org,
      viewerRole: input.viewerRole,
      match,
      members,
      detailHref: `/discover/${cpId}`,
    }
  }
  return result
}

export interface PanelInitialInput {
  meetings: MeetingRecord[]
  viewerRole: ViewerRole
  viewerOrgId: string
  eventDates: EventDate[]
  now?: { date: string; time: string } // KST. 미주입 시 시간 비교 없이 예정 건 전체를 후보로 본다.
}

export interface PanelInitial {
  // 포커싱(명시적 선택) 안 한 상태에서 우측 패널에 기본으로 보여줄 다음(예정) 미팅.
  // 행을 하이라이트하지 않고 패널 내용만 채운다(선택과 분리).
  defaultMeetingId: string | null
  emptyState: PanelEmptyKind | null // 보여줄 예정 미팅도 없을 때만 채워진다
}

// 예정(잡혀있는) 미팅 상태 — 취소/거절/완료/노쇼는 "예정"이 아니다.
const UPCOMING_STATUSES: ScheduleStatus[] = ["proposed", "accepted"]

// 진입 시 우측 패널 초기 상태: 지금 이후 예정 미팅이 있으면 그 다음 건을 기본 표시,
// 없으면 잔여 슬롯 유무로 빈 상태 A(find-partner)/B(no-meetings)를 가른다.
export function resolvePanelInitial(input: PanelInitialInput): PanelInitial {
  const mine = input.meetings.filter(
    (m) => m.buyerOrgId === input.viewerOrgId || m.exhibitorOrgId === input.viewerOrgId
  )
  const nowKey = input.now ? `${input.now.date} ${input.now.time}` : null

  const upcoming = mine
    .filter((m) => UPCOMING_STATUSES.includes(m.status))
    // 만료(수락 전 시간 지남)는 처리 불가 → 기본 표시 후보에서 제외.
    .filter((m) => !isExpiredProposed(m.status, m.scheduledAt, input.now))
    // "아직 끝나지 않은" 미팅 = 종료 시각 > now. 시작이 아니라 종료로 비교해야 now가 미팅 안(진행 중)일 때
    // 그 미팅을 빠뜨리지 않는다(진행 중인데 "예정 없음"으로 떨어지던 버그). sort는 시작 기준이라 진행 중 건이 먼저.
    .filter((m) =>
      nowKey
        ? `${kstDate(m.scheduledAt)} ${addMinutes(kstTime(m.scheduledAt), m.durationMinutes ?? 30)}` >
          nowKey
        : true
    )
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))

  if (upcoming.length > 0) return { defaultMeetingId: upcoming[0].id, emptyState: null }

  const remaining = hasRemainingSlots(input.eventDates, nowKey)
  return { defaultMeetingId: null, emptyState: remaining ? "find-partner" : "no-meetings" }
}

// 아직 잡을 수 있는 슬롯이 남았는가 = 지금이 마지막 행사일 마지막 슬롯(17:30) 이전인가.
function hasRemainingSlots(eventDates: EventDate[], nowKey: string | null): boolean {
  if (eventDates.length === 0) return false
  if (!nowKey) return true
  const last = eventDates[eventDates.length - 1]
  return nowKey <= `${last.id} 17:30`
}
