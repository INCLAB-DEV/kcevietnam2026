// saturation (F-OP-005 D8 / F-OP-003 D3 / ADR-0006) — 일괄(포화)배정 목업 엔진.
//
// ⚠️ 실 배정 엔진은 백엔드 소관(#53)이며 적합도(fit score) 정의가 미정인 HITL 블로커가 있다(ADR-0006).
// 여기선 FE 흐름(설정 → 실행 → Draft 검토 → 확정)을 위한 목업이다. 적합도는 점수(숫자)로 주입받아
// "랭킹된 후보 중 빈 슬롯 채우기"라는 선택 로직만 수행한다 — 휴리스틱 자체는 seam(서버)에 남는다(ADR-0001/0008).
//
// 보장 규칙: 참가사 우선 포화, 각 참가사 최소 N(settings.minSlots), tie-break=비즈매칭 신청 빠른 순,
// 추가 전용·비파괴(기존 미팅·다른 기업 불변, 빈 슬롯만 채움 — 재실행 시 보충).

import type { Organization } from "@/lib/types"
import {
  statusFromAcceptance,
  type AssignmentMeeting,
  type MatchingType,
  type MeetingEntryStatus,
} from "./forced-assignment"
import { alreadyPaired, isAvailableAt, isFreeAt, meetingCountFor } from "./slot-intersection"
import { occupiedSlotIds, type ScheduleSettings } from "./schedule"

// Draft 미팅 = 아직 미발효 상태의 배정. 형상은 AssignmentMeeting과 동일(확정 시 그대로 발효).
export type DraftMeeting = AssignmentMeeting

export interface SaturationDraft {
  runNumber: number // 실행 회차(1부터) — 재실행마다 증가
  settings: ScheduleSettings
  meetings: DraftMeeting[]
}

export interface SaturationInput {
  exhibitors: Organization[]
  buyers: Organization[]
  // 적합도 점수 fit[orgId][candidateId] — seam에서 사전계산(휴리스틱은 클라에 노출 안 함). 없으면 0.
  fit: Record<string, Record<string, number>>
  // 비즈매칭 신청 순번 — org id → 순번(작을수록 먼저). tie-break에 사용. 미정이면 뒤로.
  applicationOrder: Record<string, number>
  allSlotIds: string[] // 슬롯 유니버스(schedule.buildSlotUniverse에서)
  existing: AssignmentMeeting[] // 기존 확정/대기 — 비파괴(안 건드림, 카운트에만 반영)
  // 기업별 "불가" 슬롯(비즈매칭 신청 때 지정) — orgId → 불가 슬롯 집합. 양측 모두 가능한 슬롯에만 배정한다.
  unavailable?: Record<string, Set<string>>
  // 배정할 회의 1건의 길이(분). base 슬롯(settings.slotMinutes) 여러 칸을 점유한다 — 예: 90분·base 30 → 3칸.
  // 타임라인 base 단위(settings.slotMinutes)와 독립: 이 값을 바꿔도 그리드 기준은 안 바뀌고 회의 점유 칸수만 바뀐다.
  assignMinutes?: number
}

function indexById(input: SaturationInput): Record<string, Organization> {
  const byId: Record<string, Organization> = {}
  for (const org of [...input.exhibitors, ...input.buyers]) byId[org.id] = org
  return byId
}

// 한 기업의 반대편 후보 id — 적합도 내림차순, 동률은 비즈매칭 신청 빠른 순.
function candidateIds(
  orgId: string,
  input: SaturationInput,
  byId: Record<string, Organization>,
): string[] {
  const org = byId[orgId]
  if (!org) return []
  const pool = org.role === "exhibitor" ? input.buyers : input.exhibitors
  const fitFor = input.fit[orgId] ?? {}
  return [...pool]
    .sort((a, b) => {
      const byFit = (fitFor[b.id] ?? 0) - (fitFor[a.id] ?? 0)
      if (byFit !== 0) return byFit
      return (
        (input.applicationOrder[a.id] ?? Number.POSITIVE_INFINITY) -
        (input.applicationOrder[b.id] ?? Number.POSITIVE_INFINITY)
      )
    })
    .map((org) => org.id)
}

// 배정 채널 — 진입 상태 규칙이 갈리는 축(백엔드 app/matching/acceptance_rule.Channel과 같은 이름).
//   ai_saturation = 운영자가 [전체 일괄배정]으로 만들고 확정 버튼을 누르는 배치 → 항상 즉시 확정
//   ai_retrigger  = 기업 하나의 빈 슬롯 자동채움([⚡]) → 받는 쪽 바이어 유형이 결정(종전 규칙)
export type FillChannel = "ai_saturation" | "ai_retrigger"

// 운영자 개입 채널(FORCED·AI_SATURATION)은 받는 쪽 유형과 무관하게 즉시 확정이다(ADR-0005
// 2026-09-15 정정, 발주자 QA B3). 나머지 채널은 바이어 유형 규칙 그대로.
function entryStatusFor(
  channel: FillChannel,
  buyer: Pick<Organization, "buyerType">,
): MeetingEntryStatus {
  return channel === "ai_saturation" ? "accepted" : statusFromAcceptance(buyer)
}

// 한 기업의 빈 슬롯을 target(총 미팅 수)까지 채운다. 추가 전용·비파괴(working에 누적, 기존 불변).
// 같은 상대와 중복 페어 금지, 양쪽이 비어있는 슬롯에만 배정. 진입 상태는 channel이 결정(entryStatusFor).
//
// 회의 1건은 assignMinutes 길이 = base(baseMinutes) 여러 칸을 점유한다. 그 "footprint"(시작칸+뒤칸)가
// 전부 (1) 슬롯 유니버스 안(점심/종료 안 넘김) (2) 양측 비어있음 (3) 양측 가능 슬롯일 때만 배정한다.
// 점유한 뒤칸은 working에 phantom 레코드로 넣어 이후 반복이 그 칸을 찬 것으로 보게 한다(카운트 제외).
function fillForOrg(
  orgId: string,
  input: SaturationInput,
  byId: Record<string, Organization>,
  working: AssignmentMeeting[],
  target: number,
  matchingType: MatchingType,
  channel: FillChannel,
  nextId: () => string,
  baseMinutes: number,
  baseGapMinutes: number,
  assignMinutes: number,
): DraftMeeting[] {
  const org = byId[orgId]
  if (!org) return []
  const candidates = candidateIds(orgId, input, byId)
  const slotSet = new Set(input.allSlotIds)
  const drafts: DraftMeeting[] = []
  for (const slot of input.allSlotIds) {
    if (meetingCountFor(orgId, working) >= target) break
    // 이 회의가 점유할 base 슬롯들(시작칸 포함). 전부 유니버스 안 + 이 기업 측 비어있음·가능이어야 한다.
    const footprint = occupiedSlotIds(slot, assignMinutes, baseMinutes, baseGapMinutes)
    const orgFits = footprint.every(
      (s) => slotSet.has(s) && isFreeAt(orgId, s, working) && isAvailableAt(orgId, s, input.unavailable),
    )
    if (!orgFits) continue
    // 상대도 같은 footprint 전 구간이 비어있고 가능해야 함(양쪽 빈 슬롯 교집합).
    const candId = candidates.find(
      (cid) =>
        !alreadyPaired(orgId, cid, working) &&
        footprint.every((s) => isFreeAt(cid, s, working) && isAvailableAt(cid, s, input.unavailable)),
    )
    if (!candId) continue
    const candidate = byId[candId]
    if (!candidate) continue
    const buyer = org.role === "buyer" ? org : candidate
    const exhibitor = org.role === "exhibitor" ? org : candidate
    if (buyer.role !== "buyer" || exhibitor.role !== "exhibitor") continue
    const meeting: DraftMeeting = {
      id: nextId(),
      exhibitorId: exhibitor.id,
      buyerId: buyer.id,
      slotId: slot,
      status: entryStatusFor(channel, buyer),
      matchingType,
      durationMinutes: assignMinutes,
    }
    drafts.push(meeting)
    working.push(meeting)
    // 뒤칸을 phantom 점유로 표시 — 다음 반복/다른 기업 배정이 그 칸을 재사용하지 않게.
    for (let i = 1; i < footprint.length; i++) {
      working.push({ ...meeting, id: `${meeting.id}~occ${i}`, slotId: footprint[i], phantom: true })
    }
  }
  return drafts
}

// 전체 포화배정 Draft 생성(우상단 [전체 일괄배정]). 참가사 우선·신청순 보장 라운드, 비파괴.
// provenance='ai'. 운영자가 Draft를 검토(수정/삭제)한 뒤 confirmDraft로 발효한다(ADR-0006 게이트).
export function generateSaturationDraft(
  input: SaturationInput,
  settings: ScheduleSettings,
  runNumber: number,
): SaturationDraft {
  const byId = indexById(input)
  const working = [...input.existing] // 비파괴: 기존을 복사해 그 위에만 추가
  let counter = 0
  const nextId = () => `draft-${runNumber}-${counter++}`
  const order = [...input.exhibitors].sort(
    (a, b) =>
      (input.applicationOrder[a.id] ?? Number.POSITIVE_INFINITY) -
      (input.applicationOrder[b.id] ?? Number.POSITIVE_INFINITY),
  )
  const base = settings.slotMinutes
  const baseGap = settings.slotGapMinutes
  const assignMinutes = input.assignMinutes ?? base
  const meetings: DraftMeeting[] = []
  for (const exhibitor of order) {
    meetings.push(
      ...fillForOrg(
        exhibitor.id,
        input,
        byId,
        working,
        settings.minSlots,
        "ai",
        "ai_saturation", // 운영자가 확정 버튼을 누르는 배치 — 받는 쪽 유형 무관 즉시 확정
        nextId,
        base,
        baseGap,
        assignMinutes,
      ),
    )
  }
  return { runNumber, settings, meetings }
}

// 단일 기업 빈슬롯 보충(기업명 옆 [⚡] / OP-003 모드① 자동채움 = AI 재트리거). provenance='ai'.
// 그 기업의 빈 슬롯만 최소 N까지 채우고, 다른 기업·기존 미팅은 건드리지 않는다(추가 전용·비파괴).
export function proposeSingleOrgFill(
  orgId: string,
  input: SaturationInput,
  settings: ScheduleSettings,
  runNumber: number,
): DraftMeeting[] {
  const byId = indexById(input)
  const working = [...input.existing]
  let counter = 0
  const nextId = () => `fill-${runNumber}-${orgId}-${counter++}`
  const base = settings.slotMinutes
  const baseGap = settings.slotGapMinutes
  const assignMinutes = input.assignMinutes ?? base
  return fillForOrg(
    orgId,
    input,
    byId,
    working,
    settings.minSlots,
    "ai",
    "ai_retrigger", // 단일 기업 자동채움 — 받는 쪽 바이어 유형이 진입 상태를 결정(종전 규칙)
    nextId,
    base,
    baseGap,
    assignMinutes,
  )
}

// Draft 확정 — 미팅을 그대로 발효한다(실연동 시 양측 통지 트리거, FE 범위 밖).
export function confirmDraft(draft: SaturationDraft): AssignmentMeeting[] {
  return draft.meetings
}

// Draft에서 한 건 제거(개별 삭제).
export function removeDraftMeeting(draft: SaturationDraft, meetingId: string): SaturationDraft {
  return { ...draft, meetings: draft.meetings.filter((m) => m.id !== meetingId) }
}

// Draft 한 건 수정(슬롯 이동 등). 진입 상태는 바이어 유형 고정이라 슬롯만 바꾼다.
export function editDraftMeeting(
  draft: SaturationDraft,
  meetingId: string,
  patch: Partial<Pick<DraftMeeting, "slotId">>,
): SaturationDraft {
  return {
    ...draft,
    meetings: draft.meetings.map((m) => (m.id === meetingId ? { ...m, ...patch } : m)),
  }
}
