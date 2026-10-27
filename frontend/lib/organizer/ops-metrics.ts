// OP-001 운영 대시보드의 순수 집계 (F-OP-001 / 이슈 #53).
// 화면(컴포넌트)이 아니라 여기서 등록자/참가자·미팅 상태분포·완료/노쇼·후기율·슬롯 사용률·0건
// 참가사·시간대별 분포를 이벤트 단위로 계산한다 — 외부 관찰 동작(집계 결과)만 테스트한다(PRD Testing).
// 데이터 출처는 v1 mock(ops-metrics-mock). 실연동 시 FastAPI 집계 엔드포인트 결과로 스왑한다
// (ADR-0008 경계 B — FastAPI가 DB·권한검사 단일 소유). 대시보드는 읽기 전용이라 쓰기 경로가 없다.
//
// 도메인 정합:
//   · 비즈매칭 참가자 = application_status='approved' 만(ADR-0009). registered/submitted 는 명단·검토대기로
//     참가자 아님 — 이 구분이 "명단만 vs 실제 참여"를 읽게 한다.
//   · meetings.status ∈ proposed/accepted/rejected/cancelled/completed (schema.sql). 노쇼는 별도 상태가
//     아니라 completed 미팅의 리뷰 입력값(post_meeting_reviews.counterpart_noshow, ADR-0010/0004)에서 파생한다.
//   · 운영 관점 묶음: 예정=proposed+accepted, 완료=completed∧¬noshow, 노쇼=completed∧noshow, 취소=cancelled+rejected.
//   · 전체 비즈매칭(활성) 수 = proposed+accepted+completed (취소/거부 제외).
//   · 슬롯 총량은 하드코딩 금지 — events 운영변수(operating_start/end·slot_minutes·eventDays)에서 파생(ADR-0006).

import type { OrgRole } from "@/lib/types"
import { DEFAULT_SCHEDULE_SETTINGS, slotTimes } from "@/lib/organizer/schedule"

// meetings.status 정본(schema.sql) — 노쇼는 여기 없음(리뷰 입력값에서 파생).
export type MeetingStatus = "proposed" | "accepted" | "rejected" | "cancelled" | "completed"

// 활성(취소/거부 제외) 상태 — 전체 비즈매칭 수·슬롯 점유·0건 판정의 모집단.
const ACTIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set<MeetingStatus>([
  "proposed",
  "accepted",
  "completed",
])

// ── 입력 contract (FastAPI 집계 결과와 같은 shape로 스왑) ──────────────────────

// 집계 모집단 — 'event'(master: 행사 전역) | 'jurisdiction'(sub: 자기가 관리하는 바이어의 매칭 활동만,
// 참가사 축 제외). 백엔드 응답이 스스로 밝힌다(GET .../ops-metrics의 scope). 화면은 이 값으로 참가사
// 기준 위젯(슬롯 사용률·0건 참가사)을 숨긴다 — sub 모집단에선 그 분모가 정의되지 않기 때문이다.
export type OpsMetricsScope = "event" | "jurisdiction"

// 비즈매칭에 참여한 기업(역할+승인 여부). approved 만 "비즈매칭 참가자"로 집계된다(ADR-0009).
export interface OpsParticipant {
  orgId: string
  role: OrgRole // "exhibitor" | "buyer"
  approved: boolean // application_status === 'approved'
}

// 미팅 1건(매칭 단위=Organization, ADR-0002). 노쇼는 리뷰에서 파생하므로 여기 두지 않는다.
export interface OpsMeeting {
  id: string
  exhibitorOrgId: string
  buyerOrgId: string
  status: MeetingStatus
  scheduledStart: string | null // ISO8601(+09:00). null=시간 미정(시간대 그래프 제외)
  saturationRunId?: string | null // 전체 포화배정 산출 미팅이면 그 실행 회차(ADR-0006). 집계엔 미사용.
}

// completed 미팅당 평가 주체(기업) 측마다 1행(schema UNIQUE(meeting_id, reviewer_org_id)).
// counterpart_noshow=true 면 그 미팅을 노쇼로 본다(상대가 안 왔다 — ADR-0010). selfNoshow=true는
// 같은 사실을 리뷰어 본인 관점에서 말한 것("내가 불참") — 둘 다 같은 무게로 노쇼 집계에 들어간다.
export interface OpsReview {
  meetingId: string
  reviewerOrgId: string
  counterpartNoshow: boolean
  selfNoshow: boolean
}

// 슬롯 총량 파생용 운영변수(events 흡수, ADR-0006). 하드코딩 대신 이 설정에서 계산한다.
// 필드 의미는 organizer/schedule.ts 의 ScheduleSettings 와 같고, slotsPerDay 가 그쪽 slotTimes 로
// 위임하므로 이름만 이 타입에 맞게 매핑한다(operatingStart ↔ startTime).
export interface ScheduleSettings {
  operatingStart: string // "HH:MM" (예 "09:00")
  operatingEnd: string // "HH:MM" (예 "18:00")
  slotMinutes: number // 슬롯 한 칸 길이(분)
  // 칸 사이 텀(분, Phase 1 계약서 §1). 하루 슬롯 수는 slotMinutes가 아니라 stride(=slotMinutes+
  // 이 값) 기준으로 세어야 한다 — 그렇지 않으면 텀만큼 슬롯 수가 부풀어 사용률이 과소 표시된다.
  slotGapMinutes: number
  // 점심 블록 "HH:MM". 미설정은 둘 다 "00:00"(백엔드 OpsScheduleOut 의 폴백 관례) — slotTimes 가
  // 빈 구간으로 해석해 아무 칸도 건너뛰지 않는다. **이 값 없이 총량을 세면 점심을 못 빼서 부푼다**:
  // 프로덕션 09:00~18:00/30분/점심12~13 은 18이 아니라 16칸, 발주사 격자(10:00~18:10/40분/텀5분/
  // 점심12:10~13:00)는 11이 아니라 10칸이 맞다.
  lunchStart: string
  lunchEnd: string
  eventDays: number // 행사 진행 일수
}

// 명단 적재 규모(registrants 건수) — 역할별. "명단만"의 분모.
export interface RosterCounts {
  exhibitorRegistrants: number
  buyerRegistrants: number
}

export interface OpsMetricsInput {
  roster: RosterCounts
  participants: OpsParticipant[]
  meetings: OpsMeeting[]
  reviews: OpsReview[]
  schedule: ScheduleSettings
}

// ── 출력 contract ────────────────────────────────────────────────────────────

export interface RoleSplit {
  exhibitor: number
  buyer: number
  total: number
}

// 운영 관점 상태 묶음(예정·완료·취소·노쇼) — 합은 전체 미팅(취소 포함) 건수.
export interface StatusBreakdown {
  scheduled: number // proposed + accepted
  completed: number // completed ∧ ¬noshow
  cancelled: number // cancelled + rejected
  noshow: number // completed ∧ noshow
}

// 시간대(시) 한 칸 — 예정·완료·노쇼(취소는 제외, PRD 시간대 그래프 정의).
export interface HourBucket {
  hour: number // 0–23 (KST)
  label: string // "10시"
  scheduled: number
  completed: number
  noshow: number
}

export interface ReviewCoverage {
  submitted: number // 제출된 리뷰 행 수
  expected: number // 완료 미팅 × 2(양측)
  rate: number // submitted / expected (0–1)
}

export interface SlotUsage {
  assigned: number // 점유 슬롯(활성 미팅 1건=참가사 슬롯 1칸)
  total: number // 가용 슬롯 총량(승인 참가사 × 일별 슬롯수 × 일수)
  rate: number // assigned / total (0–1)
}

export interface OpsMetrics {
  roster: RoleSplit // 등록자(명단 규모)
  participants: RoleSplit // 비즈매칭 참가자(approved)
  totalMeetings: number // 전체 비즈매칭(활성) 수
  status: StatusBreakdown
  completedMeetings: number // 완료(노쇼 제외)
  noshow: { count: number; rate: number } // 노쇼 건수 + 노쇼율 noshow/(completed+noshow)
  review: ReviewCoverage // 후기 작성률
  hourly: HourBucket[] // 시간대별 분포
  slots: SlotUsage // 슬롯 사용률
  zeroMeetingExhibitors: number // 미팅 0건인 approved 참가사 수
}

// ── 도우미 ───────────────────────────────────────────────────────────────────

// "HH:MM" → 0시 기준 분. 잘못된 입력은 0.
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}

// ISO8601 문자열에서 (오프셋 그대로의) 자정 기준 분(minute-of-day)을 읽는다. KST 오프셋으로
// 저장된 값이라 문자열에서 직접 잘라 Date 타임존 변환 없이 안정적으로 시각을 만든다.
// 시(hour) 버킷 + 운영시간 창(분 단위) 경계 판정에 함께 쓴다.
function isoMinuteOfDay(iso: string): number | null {
  // 예: "2026-09-16T10:30:00+09:00" → 630
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  return h * 60 + mm
}

// 노쇼로 판정된 completed 미팅 id 집합 — counterpart_noshow 또는 self_noshow=true 리뷰가 달린
// completed 건만. (취소/거부 건에 남은 리뷰 행은 무시 — 노쇼는 completed 에서만 의미.)
function noshowMeetingIds(meetings: OpsMeeting[], reviews: OpsReview[]): Set<string> {
  const completed = new Set(meetings.filter((m) => m.status === "completed").map((m) => m.id))
  const ids = new Set<string>()
  for (const r of reviews) {
    if ((r.counterpartNoshow || r.selfNoshow) && completed.has(r.meetingId)) ids.add(r.meetingId)
  }
  return ids
}

// ── 위젯별 집계(각각 순수·독립) ───────────────────────────────────────────────

// 비즈매칭 참가자 = approved 만(ADR-0009). 역할별 분할.
export function participantCounts(participants: OpsParticipant[]): RoleSplit {
  let exhibitor = 0
  let buyer = 0
  for (const p of participants) {
    if (!p.approved) continue
    if (p.role === "exhibitor") exhibitor++
    else buyer++
  }
  return { exhibitor, buyer, total: exhibitor + buyer }
}

// 미팅 상태 분포(운영 관점 묶음). 노쇼는 리뷰에서 파생한다.
export function meetingStatusBreakdown(
  meetings: OpsMeeting[],
  reviews: OpsReview[],
): StatusBreakdown {
  const noshow = noshowMeetingIds(meetings, reviews)
  const out: StatusBreakdown = { scheduled: 0, completed: 0, cancelled: 0, noshow: 0 }
  for (const m of meetings) {
    switch (m.status) {
      case "proposed":
      case "accepted":
        out.scheduled++
        break
      case "cancelled":
      case "rejected":
        out.cancelled++
        break
      case "completed":
        if (noshow.has(m.id)) out.noshow++
        else out.completed++
        break
    }
  }
  return out
}

// 노쇼율 = noshow / (completed + noshow). 완료 미팅이 0이면 0(나눗셈 방어).
export function noshowRate(status: StatusBreakdown): number {
  const denom = status.completed + status.noshow
  return denom > 0 ? status.noshow / denom : 0
}

// 후기 작성률 = 제출 리뷰 행 수 / (완료 미팅 × 2). 완료 미팅은 노쇼 포함(둘 다 status=completed).
export function reviewCoverage(meetings: OpsMeeting[], reviews: OpsReview[]): ReviewCoverage {
  const completedTotal = meetings.filter((m) => m.status === "completed").length
  const expected = completedTotal * 2
  // 완료 미팅에 달린 리뷰만 분자로(취소/거부 건의 잔여 리뷰 제외).
  const completedIds = new Set(
    meetings.filter((m) => m.status === "completed").map((m) => m.id),
  )
  const submitted = reviews.filter((r) => completedIds.has(r.meetingId)).length
  return { submitted, expected, rate: expected > 0 ? submitted / expected : 0 }
}

// 하루당 슬롯 수. **격자 규칙을 여기서 다시 구현하지 않고** organizer/schedule.ts 의 slotTimes 로
// 위임한다 — 그쪽이 백엔드 app/matching/slot_grid.py._day_slots 와 1:1로 맞춰 관리되는 유일한
// 구현이다(전진은 stride, 루프 종료는 칸 끝 기준, 점심은 [lunchStart, lunchEnd) 겹침만 탈락).
// 이곳에 산술을 복사해 두면 세 곳이 갈라지고, 실제로 갈라져 있었다: 구버전은 stride도 점심을
// 반영하지 않아 프로덕션 09:00~18:00/30분/점심12~13 을 18칸으로 셌다(정답 16칸) — 분모가 부풀어
// 슬롯 사용률이 실제보다 낮게 표시되는 조용한 오류였다.
// 잘못된 설정(슬롯 길이 ≤ 0, 시작 ≥ 끝)은 slotTimes 가 빈 목록을 돌려주므로 0이 된다(구 guard와 동일).
export function slotsPerDay(s: ScheduleSettings): number {
  return slotTimes({
    ...DEFAULT_SCHEDULE_SETTINGS,
    startTime: s.operatingStart,
    endTime: s.operatingEnd,
    lunchStart: s.lunchStart,
    lunchEnd: s.lunchEnd,
    slotMinutes: s.slotMinutes,
    slotGapMinutes: s.slotGapMinutes,
  }).length
}

// 슬롯 사용률 = 활성 미팅 수(=참가사 슬롯 점유) / (승인 참가사 × 일별 슬롯 × 일수).
export function slotUsage(
  participants: OpsParticipant[],
  meetings: OpsMeeting[],
  schedule: ScheduleSettings,
): SlotUsage {
  const approvedExhibitors = participants.filter((p) => p.role === "exhibitor" && p.approved).length
  const total = approvedExhibitors * slotsPerDay(schedule) * Math.max(0, schedule.eventDays)
  const assigned = meetings.filter((m) => ACTIVE_STATUSES.has(m.status)).length
  return { assigned, total, rate: total > 0 ? assigned / total : 0 }
}

// 미팅 0건 참가사 수 = 활성 미팅에 한 번도 안 나타난 approved 참가사 수(효과 입증 최저선, ADR-0006).
export function zeroMeetingExhibitorCount(
  participants: OpsParticipant[],
  meetings: OpsMeeting[],
): number {
  const withMeeting = new Set<string>()
  for (const m of meetings) {
    if (ACTIVE_STATUSES.has(m.status)) withMeeting.add(m.exhibitorOrgId)
  }
  return participants.filter(
    (p) => p.role === "exhibitor" && p.approved && !withMeeting.has(p.orgId),
  ).length
}

// 시간대별 분포(예정·완료·노쇼). 운영시간 범위의 시(hour)마다 한 칸, 취소/거부는 제외.
export function hourlyDistribution(
  meetings: OpsMeeting[],
  reviews: OpsReview[],
  schedule: ScheduleSettings,
): HourBucket[] {
  const startMin = toMinutes(schedule.operatingStart)
  const endMin = toMinutes(schedule.operatingEnd)
  const startH = Math.floor(startMin / 60)
  const endH = Math.ceil(endMin / 60)
  const buckets = new Map<number, HourBucket>()
  for (let h = startH; h < endH; h++) {
    buckets.set(h, { hour: h, label: `${h}시`, scheduled: 0, completed: 0, noshow: 0 })
  }
  const noshow = noshowMeetingIds(meetings, reviews)
  for (const m of meetings) {
    if (!m.scheduledStart) continue
    const mod = isoMinuteOfDay(m.scheduledStart)
    if (mod === null) continue
    // 운영시간 창(분 단위) 밖은 제외 — 비정시 운영시간(예 09:30–17:30)에서 창 밖 미팅이
    // 시(hour) 버킷에 잘못 잡히지 않게 한다. [start, end) 반열림 구간.
    if (mod < startMin || mod >= endMin) continue
    const b = buckets.get(Math.floor(mod / 60))
    if (!b) continue // 방어(정상적으로는 위 창 판정에서 걸러짐)
    if (m.status === "proposed" || m.status === "accepted") b.scheduled++
    else if (m.status === "completed") {
      if (noshow.has(m.id)) b.noshow++
      else b.completed++
    }
    // cancelled/rejected 는 시간대 그래프에 넣지 않는다
  }
  return [...buckets.values()]
}

// 전체 묶음 — 위 위젯 집계를 한 번에 조립(화면이 받는 단일 contract).
export function aggregateOpsMetrics(input: OpsMetricsInput): OpsMetrics {
  const { roster, participants, meetings, reviews, schedule } = input
  const status = meetingStatusBreakdown(meetings, reviews)
  const participantSplit = participantCounts(participants)
  return {
    roster: {
      exhibitor: roster.exhibitorRegistrants,
      buyer: roster.buyerRegistrants,
      total: roster.exhibitorRegistrants + roster.buyerRegistrants,
    },
    participants: participantSplit,
    totalMeetings: status.scheduled + status.completed + status.noshow,
    status,
    completedMeetings: status.completed,
    noshow: { count: status.noshow, rate: noshowRate(status) },
    review: reviewCoverage(meetings, reviews),
    hourly: hourlyDistribution(meetings, reviews, schedule),
    slots: slotUsage(participants, meetings, schedule),
    zeroMeetingExhibitors: zeroMeetingExhibitorCount(participants, meetings),
  }
}
