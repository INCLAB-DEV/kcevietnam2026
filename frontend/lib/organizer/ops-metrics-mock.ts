// OP-001 운영 대시보드 mock (F-OP-001 / 이슈 #53).
// 데모용: 모든 위젯이 의미 있는 숫자를 보이도록 참가자·미팅·리뷰·운영설정·포화배정 run 을
// 같은 org id 로 엮어 결정론적으로 생성한다(Math.random 없음 — 재현 가능한 시연).
// 스토리: 명단은 크지만(103/178) 승인 참가자는 일부, 미팅은 상태별로 섞여 있고, 0건 참가사가
// 남아 있으며, 최근 포화배정 회차가 Draft(검토 대기)다 → "재배정 타이밍" 판단 화면.
// TODO(실연동): 이 빌더 전체를 FastAPI 집계 엔드포인트 호출로 교체(ADR-0008 경계 B). 같은 OpsMetricsInput shape.

import type {
  OpsMeeting,
  OpsMetricsInput,
  OpsParticipant,
  OpsReview,
  ScheduleSettings,
} from "./ops-metrics"
import type { SaturationRun } from "./saturation-status"

// DX Korea 2026 운영변수(events 흡수, ADR-0006). 슬롯 총량은 이 값에서 파생한다.
// 점심은 "00:00"/"00:00"(미설정) — 백엔드 OpsScheduleOut 의 NULL 폴백 관례와 같다. 목업 모드의
// 하루 칸 수(18)를 바꾸지 않으려고 일부러 점심을 두지 않는다.
export const MOCK_SCHEDULE: ScheduleSettings = {
  operatingStart: "09:00",
  operatingEnd: "18:00",
  slotMinutes: 30,
  slotGapMinutes: 0,
  lunchStart: "00:00",
  lunchEnd: "00:00",
  eventDays: 3,
}

const DAYS = ["2026-09-16", "2026-09-17", "2026-09-18"] as const
const HOURS = [9, 10, 11, 13, 14, 15, 16] as const // 12시(점심) 제외, 17시 taper 제외

// 승인 참가사 12곳 중 ex-11·ex-12 는 의도적으로 미팅 0건(0건 참가사 위젯 시연 → 재배정 필요).
const APPROVED_EXHIBITORS = Array.from({ length: 12 }, (_, i) => `ex-${pad(i + 1)}`)
const ZERO_MEETING_EXHIBITORS = new Set(["ex-11", "ex-12"])
const MEETING_EXHIBITORS = APPROVED_EXHIBITORS.filter((id) => !ZERO_MEETING_EXHIBITORS.has(id))
const APPROVED_BUYERS = Array.from({ length: 9 }, (_, i) => `by-${pad(i + 1)}`)

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

// 참가자 모집단: 승인 12+9 + 미승인(검토대기/명단만) 일부 — approved 만 참가자로 집계된다(ADR-0009).
const PARTICIPANTS: OpsParticipant[] = [
  ...APPROVED_EXHIBITORS.map((orgId) => ({ orgId, role: "exhibitor" as const, approved: true })),
  ...APPROVED_BUYERS.map((orgId) => ({ orgId, role: "buyer" as const, approved: true })),
  { orgId: "ex-90", role: "exhibitor", approved: false }, // submitted(검토 대기)
  { orgId: "ex-91", role: "exhibitor", approved: false }, // registered(명단만)
  { orgId: "by-90", role: "buyer", approved: false },
]

// 상태 사이클 — 활성(예정/완료) 위주에 취소·거부를 섞는다. completed 는 리뷰로 노쇼가 갈린다.
const STATUS_CYCLE: OpsMeeting["status"][] = [
  "accepted",
  "completed",
  "accepted",
  "proposed",
  "completed",
  "accepted",
  "completed",
  "cancelled",
  "completed",
  "accepted",
  "proposed",
  "completed",
  "accepted",
  "rejected",
]

// 미팅 그리드: 각 (일×시)마다 3건을 만들어 참가사/바이어를 라운드로빈 배정 → 시간대 분포가 채워진다.
function buildMeetings(): OpsMeeting[] {
  const meetings: OpsMeeting[] = []
  let n = 0
  for (let d = 0; d < DAYS.length; d++) {
    for (let h = 0; h < HOURS.length; h++) {
      for (let k = 0; k < 3; k++) {
        const exhibitorOrgId = MEETING_EXHIBITORS[n % MEETING_EXHIBITORS.length]
        const buyerOrgId = APPROVED_BUYERS[(n * 2 + k) % APPROVED_BUYERS.length]
        const status = STATUS_CYCLE[n % STATUS_CYCLE.length]
        const hh = pad(HOURS[h])
        const mm = k === 0 ? "00" : k === 1 ? "30" : "00" // 두 칸은 정각·30분, 셋째는 다음 정각 근처
        meetings.push({
          id: `mtg-${pad(n + 1)}`,
          exhibitorOrgId,
          buyerOrgId,
          status,
          scheduledStart: `${DAYS[d]}T${hh}:${mm}:00+09:00`,
          saturationRunId: status === "cancelled" || status === "rejected" ? null : "run-2",
        })
        n++
      }
    }
  }
  return meetings
}

const MEETINGS = buildMeetings()

// completed 미팅 id 들 — 일부는 노쇼(리뷰 counterpart_noshow=true), 나머지는 ~70% 리뷰 커버.
const COMPLETED_IDS = MEETINGS.filter((m) => m.status === "completed").map((m) => m.id)
// 3건을 노쇼로(결정론적: 4·9·14번째 완료 건).
const NOSHOW_IDS = new Set(COMPLETED_IDS.filter((_, i) => i % 5 === 3).slice(0, 3))

function buildReviews(): OpsReview[] {
  const reviews: OpsReview[] = []
  COMPLETED_IDS.forEach((meetingId, i) => {
    if (NOSHOW_IDS.has(meetingId)) {
      // 노쇼: 안 온 상대를 한 쪽이 리뷰에서 표시(=노쇼 신호 출처).
      reviews.push({ meetingId, reviewerOrgId: "ex-rev", counterpartNoshow: true, selfNoshow: false })
      return
    }
    // 정상 완료: 인덱스로 0~2개 리뷰 → 대략 70% 커버.
    const count = i % 10 === 0 ? 0 : i % 3 === 0 ? 1 : 2
    for (let s = 0; s < count; s++) {
      reviews.push({
        meetingId,
        reviewerOrgId: s === 0 ? "ex-rev" : "by-rev",
        counterpartNoshow: false,
        selfNoshow: false,
      })
    }
  })
  return reviews
}

const REVIEWS = buildReviews()

// 전체 포화배정 실행 이력 — 2회차 확정 + 3회차 Draft(검토 대기). 대시보드가 "검토 대기"를 띄운다.
export const MOCK_SATURATION_RUNS: SaturationRun[] = [
  { runNumber: 1, status: "confirmed", createdAt: "2026-09-12T09:30:00+09:00", minGuaranteedSlots: 10 },
  { runNumber: 2, status: "confirmed", createdAt: "2026-09-14T14:00:00+09:00", minGuaranteedSlots: 10 },
  { runNumber: 3, status: "draft", createdAt: "2026-09-16T08:45:00+09:00", minGuaranteedSlots: 12 },
]

// 대시보드 입력 묶음 — 명단 규모는 실제 스케일(참가사 103·바이어 178)로 둔다(명단만 vs 참여 대비).
export const MOCK_OPS_METRICS_INPUT: OpsMetricsInput = {
  roster: { exhibitorRegistrants: 103, buyerRegistrants: 178 },
  participants: PARTICIPANTS,
  meetings: MEETINGS,
  reviews: REVIEWS,
  schedule: MOCK_SCHEDULE,
}
