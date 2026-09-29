// my-meetings-list — 한 사용자의 미팅을 날짜별 09:00~18:00 30분 슬롯 타임라인으로 투영하는
// 읽기 전용 deep module (F-MY-001 D9, 식별된 deep module). 입력(미팅·방향·상태·역할)에서
// "각 슬롯이 무슨 색/라벨이고, 무엇을 누를 수 있는가"를 결정한다. 화면은 결과를 그리기만 한다.
//
// 권한 경계(내 기업이 당사자인 미팅만)는 FastAPI가 1차로 처리하지만(ADR-0008), 읽기 측에서도
// viewerOrgId로 한 번 더 거른다. 상태·수락 규칙은 ADR-0005를 따른다 — 여기서는 표시·액션 노출만 하고
// 상태 진입 규칙(초청=accepted / 일반=proposed)을 새로 만들지 않는다.
//
// 상태 tone/label·viewer 필터·KST 투영은 home과 공유하는 meeting-projection이 단일 출처(#85).
// 백엔드(#33: GET /meetings 투영 API)는 아직 없다. eventDates·meetings를 주입받아 동작한다.

import type { MeetingRecord } from "@/lib/home/home-dashboard-data"
import type { ScheduleStatus, RequestDirection } from "@/lib/home/meeting-status-rollup"
import type { ViewerRole } from "@/lib/types"
import type { Locale } from "@/lib/i18n/config"
import {
  filterViewerMeetings,
  kstDate,
  kstTime,
  toneFor,
  labelFor,
  resolveDirection,
  defaultStatusT,
  type SlotTone,
  type Translator,
} from "./meeting-projection"
import { isDeadSlotMeeting, occupyingSlotMeeting, sortSlotMeetings } from "./slot-pick"

export type { ScheduleStatus, RequestDirection, Translator }

// 상태 tone/label·KST 투영은 meeting-projection이 단일 출처. 기존 import 경로(@/lib/meeting/timeline)는 유지.
export { toneFor, labelFor, kstDate, kstTime, type SlotTone }

// 축약 라벨(shortStatus) t 미주입 호출부(단위 테스트 등 i18n 범위 밖) 보존용 한국어 폴백 —
// messages/ko.json의 meeting.shortStatus와 동일 문구를 유지한다(값이 바뀌면 양쪽 다 갱신).
// 전체 라벨(status) 폴백은 meeting-projection의 defaultStatusT를 그대로 재사용한다(중복 제거).
const SHORT_STATUS_FALLBACK_KO: Record<string, string> = {
  accepted: "확정",
  completed: "완료",
  rejected: "거절",
  cancelled: "취소",
  acceptNeeded: "수락",
  waiting: "대기",
  review: "회의록",
  upcoming: "예정",
  noShow: "불참",
  expired: "지남",
}
const defaultShortStatusT: Translator = (key) => SHORT_STATUS_FALLBACK_KO[key] ?? key

// 슬롯에서 노출 가능한 액션(F-MY-001 D3 매트릭스). 실제 모달/전이는 #36/#35 소관 — 여기선 노출 여부만.
// attendance=참석여부 수정(노쇼↔참석 정정). 노쇼는 회의록 불가라 attendance만, 참석완료는 review만(공존 금지).
export type SlotAction = "accept" | "reject" | "cancel" | "review" | "attendance"

// 09:00~18:00 운영시간. 칸 길이 기본값은 SLOT_MINUTES(30분) — 실제 칸 길이·텀은 EventDate.slotMinutes/
// slotGapMinutes로 날짜마다 오버라이드된다(Phase 1 계약서 §1 — 길이와 텀이 갈리는 격자 지원).
export const TIMELINE_START_HOUR = 9
export const TIMELINE_END_HOUR = 18
export const SLOT_MINUTES = 30

// 한 칸에 걸린 미팅 **한 건**의 표시 데이터. 같은 시각에 여러 건(바이어 A·B·C가 같은 시간으로 각각
// 신청)이 들어오면 슬롯은 이걸 목록으로 갖는다(#10) — 예전처럼 한 건만 남기고 나머지를 지우지 않는다.
export interface SlotMeeting {
  meetingId: string
  status: ScheduleStatus // 원 상태값(proposed 등). 만료여도 status는 그대로 — expired는 표시 파생.
  attended: boolean // completed 미팅의 참석 여부(false=노쇼/불참). completed 외엔 true 고정·무의미.
  expired: boolean // proposed인데 시작 시각 지남(만료). tone=gray·label="응답 시간 지남"·actions=[]로 파생.
  dead: boolean // 거절/취소 — 화면에서 지우지 않되 한 줄로 축약하고 뒤 칸을 점유하지 않는다(#10).
  tone: SlotTone
  label: string // 전체 라벨(행/패널용): "수락 필요", "미팅 예정", (만료 시) "응답 시간 지남" …
  shortLabel: string // 좁은 블록용 축약: "수락", "예정", (만료) "지남" …
  direction: RequestDirection
  actions: SlotAction[] // 이 건에만 붙는 액션 — 수락/거절은 반드시 이 meetingId로 나간다.
  counterpartName: string
  venue: string
  span: number // **이 건 자체의** 길이(칸 수). 시간 범위 표기용 — 칸 점유는 FilledSlot.span이 따로 본다.
  endTime: string // **이 건 자체의** 종료 "11:30"(소요시간 반영).
}

// 한 시간 칸. 단수 필드(meetingId·status·label·actions…)는 대표 1건(=meetings[0])을 그대로 이어받아
// 기존 호출부·축약 표현을 보존하고, 화면은 meetings를 쌓아 그린다(#10).
export interface FilledSlot extends SlotMeeting {
  kind: "meeting"
  time: string // 시작 "10:00"
  // ⚠ 아래 span/endTime은 **칸 점유(그리드)** 기준 — 죽은 건(거절·취소)만 있는 칸은 1칸으로 본다.
  // 각 건의 실제 길이는 meetings[i].span/endTime. 대표 건이 살아 있으면 둘은 같은 값이다.
  span: number // 점유 슬롯 수(1~3 = 30/60/90분). 1이면 단일 칸.
  endTime: string // 점유 종료 "11:30".
  coveredTimes: string[] // 이 칸이 점유한 뒤 칸들의 시각(예 90분=["10:30","11:00"]). 시간축 라벨 유지용.
  // 이 칸의 미팅 전부 — 활성(확정·대기)이 위, 죽은 것(거절·취소)이 아래. 항상 1건 이상이고 [0]=대표.
  meetings: SlotMeeting[]
}

export interface EmptySlot {
  kind: "empty"
  time: string
  tone: "gray"
}

export type TimelineSlot = FilledSlot | EmptySlot

export interface EventDate {
  id: string // "2026-09-16" (KST, YYYY-MM-DD)
  label: string // "9/16"
  weekday: string // "화"
  slotMinutes?: number // 그날의 칸 길이(분). 미지정 시 기본 30분. 예) 60=1시간 단위 운영일
  // 그날의 칸 사이 텀(분, Phase 1 계약서 §1). 미지정 시 0(하위호환 — 칸 전진 간격=slotMinutes).
  slotGapMinutes?: number
}

// 현재 시각(행사 당일에만). rowTime=지금이 속한 슬롯 행(미팅이면 그 미팅 시작칸, 아니면 빈 슬롯)의
// 시각, time=실제 현재 시각. 분리선을 슬롯 사이에 띄우지 않고 그 행에 "지금 HH:MM" 칩을 붙인다.
export interface NowState {
  rowTime: string // 칩을 붙일 슬롯 행의 시각 "10:00"
  time: string // 현재 시각 "10:11"
  live: boolean // 그 행이 진행 중(확정 accepted) 미팅 → 인디고 링/배경 강조. false면 단순 현재시각 앵커.
}

export interface DayTimeline {
  dateId: string
  label: string
  weekday: string
  pendingCount: number // 그날 받은 응답대기(received proposed) 건수 — 일별 탭 배지(D11)
  slots: TimelineSlot[]
  isToday: boolean // now.date === 이 날(행사 당일). "오늘" 탭 선택용 — now 칩 유무(만료칸 등)와 독립.
  // 이 날에 현재 시각이 있으면, 그 시각이 속한 슬롯 행에 "지금 HH:MM" 칩을 붙인다(미팅·빈칸 공통). 아니면 null.
  now: NowState | null
}

export interface TimelineInput {
  viewerRole: ViewerRole // buyer | exhibitor
  viewerOrgId: string
  meetings: MeetingRecord[]
  eventDates: EventDate[]
  // 현재 시각(KST). Date.now()는 모듈에서 쓰지 않고 주입받는다(테스트 가능). 미주입 시 마커 없음.
  now?: { date: string; time: string } // date=YYYY-MM-DD, time="HH:MM"
  // 요일 라벨 파생 locale. eventDates[].weekday(백엔드/mock, 한국어 고정)는 쓰지 않고 date.id에서
  // 매번 파생한다(i18n) — 미지정 시 기본 ko(기존 동작 보존).
  locale?: Locale
  // 상태 라벨(meeting.status)·축약 라벨(meeting.shortStatus) 번역기 — 미주입 시 한국어 폴백
  // (STATUS_FALLBACK_KO 등, 기존 하드코딩 동작 보존 — 단위 테스트 등 t 없이 호출하는 곳).
  t?: Translator
  tShort?: Translator
}

export interface TimelineProjection {
  days: DayTimeline[]
  totalMeetings: number // 내 미팅 총건수 — 0이면 화면은 역할별 빈 상태(empty-state)로 분기
}

// 좁은 블록용 축약 라벨(가로 스트립). 색·전체 라벨은 meeting-projection 공유, 축약만 timeline 고유.
// t는 "meeting.shortStatus" 네임스페이스 — 미주입 시 한국어 폴백(SHORT_STATUS_FALLBACK_KO).
const SHORT_LABEL_KEY: Record<"rejected" | "cancelled", string> = {
  rejected: "rejected",
  cancelled: "cancelled",
}

export function shortLabelFor(
  status: ScheduleStatus,
  direction: RequestDirection,
  opts: { attended?: boolean; hasReview?: boolean; ended?: boolean } = {},
  t: Translator = defaultShortStatusT
): string {
  const attended = opts.attended ?? true
  if (status === "proposed") return direction === "received" ? t("acceptNeeded") : t("waiting")
  if (status === "accepted") return opts.ended ? t("review") : t("upcoming")
  if (status === "completed") return attended ? t("review") : t("noShow")
  return t(SHORT_LABEL_KEY[status]) // 거절 / 취소
}

// 방향+상태+역할 → 노출 가능 액션(F-MY-001 D3/D6).
// 완료 미팅: 참석=회의록 작성/보기만 / 노쇼(미참석)=참석여부 수정만. 둘은 공존하지 않는다.
// 노쇼 표시(상대 불참)는 회의록 작성 흐름 안의 입력값으로 받고(ADR-0010), 노쇼로 저장된 건은
// "참석여부 수정"으로 참석 정정 → 다시 회의록 작성 흐름으로 들어간다.
export function actionsFor(
  status: ScheduleStatus,
  direction: RequestDirection,
  role: ViewerRole,
  attended: boolean = true
): SlotAction[] {
  switch (status) {
    case "proposed":
      return direction === "received" ? ["accept", "reject"] : ["cancel"]
    case "accepted":
      // 확정 미팅도 회의록 진입을 준다(발주자 결정 2026-09-14: 미팅 날짜 전이라도 회의록·녹음
      // 업로드 자유) — /meetings/{id} 게이트(review-gate)만 열어서는 타임라인 패널에 입구가
      // 없어 사용자가 도달할 수 없었다.
      return ["review", "cancel"]
    case "completed":
      return attended ? ["review"] : ["attendance"] // 참석=회의록만 / 노쇼=참석여부 수정만(공존 금지)
    default:
      return [] // rejected / cancelled — 버튼 없음
  }
}

// 09:00~18:00 슬롯 시작시각 목록. slotMinutes=30이면 18개("09:00"…"17:30"), 60이면 9개("09:00"…"17:00").
// 칸은 stride(=slotMinutes+slotGapMinutes) 간격으로 전진하고, 칸 자체(길이 slotMinutes)가 운영종료
// 안에 들어와야 살아남는다(schedule.slotTimes와 같은 규칙, Phase 1 계약서 §1).
// ⚠ 예전엔 "시(hour) 루프 안에서 분을 step"했다 — slotMinutes가 60을 나누어떨어지지 않으면(예: 40)
// 시 경계에서 분이 리셋돼(09:00,09:40,10:00,10:40…) 시각 목록 자체가 틀렸다. 지금은 하루 전체를
// 분 단위 단일 루프로 돈다.
export function slotTimes(slotMinutes: number = SLOT_MINUTES, slotGapMinutes = 0): string[] {
  const start = TIMELINE_START_HOUR * 60
  const end = TIMELINE_END_HOUR * 60
  const stride = slotMinutes + slotGapMinutes
  const times: string[] = []
  if (slotMinutes <= 0 || stride <= 0) return times
  for (let t = start; t + slotMinutes <= end; t += stride) {
    times.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`)
  }
  return times
}

// 수락 전(proposed)인데 시작 시각이 이미 지난(now ≥ 시작) 건 = 만료(표시 전용, F-MY-001 사용자 결정).
// 시간 도래했는데 수락 안 된 제안은 처리 불가로 보고 "응답 시간 지남"(회색)+액션 숨김으로 표시한다.
// 상태값(meetings.status)은 그대로 proposed — MY-001은 표시만 바꾸고 전이를 새로 만들지 않는다.
export function isExpiredProposed(
  status: ScheduleStatus,
  scheduledAt: string,
  now?: { date: string; time: string }
): boolean {
  if (status !== "proposed" || !now) return false
  return `${kstDate(scheduledAt)} ${kstTime(scheduledAt)}` <= `${now.date} ${now.time}`
}

// 확정(accepted)인데 종료 시각이 이미 지난(now ≥ 종료) 건 = 종료경과(표시 전용, isExpiredProposed의 짝).
// 끝났는데 아직 completed로 전이 안 된 윈도우 — 회의록 미작성과 동치로 보고 orange로 표시한다.
// 백엔드 스케줄러가 scheduled_end 경과 시 completed로 전이하면(ADR-0010) 자연히 일반 완료 케이스가 된다.
export function isEndedAccepted(
  status: ScheduleStatus,
  scheduledAt: string,
  durationMinutes: number | undefined,
  now?: { date: string; time: string }
): boolean {
  if (status !== "accepted" || !now) return false
  const endTime = addMinutes(kstTime(scheduledAt), durationMinutes ?? SLOT_MINUTES)
  return `${kstDate(scheduledAt)} ${endTime}` <= `${now.date} ${now.time}`
}

// "HH:MM" → 분(자정 기준). 파싱 실패 시 -1.
function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1
}

// "HH:MM" + 분 → "HH:MM". meeting-panel 등에서도 사용하므로 export.
export function addMinutes(time: string, mins: number): string {
  const total = toMinutes(time) + mins
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

// 현재 시각이 속한 슬롯 시작(30분: "10:24"→"10:00", 60분: "10:45"→"10:00"). 09:00~18:00 밖이면 null.
// ⚠ 격자 앵커는 TIMELINE_START_HOUR(09:00)다 — "시(hour) 안에서 슬롯 길이로 내림"(예전 방식)은
// stride가 60을 나누어떨어지지 않으면(예: 45) 칸 경계와 어긋난다. 대신 앵커로부터의 경과분을
// stride로 내림해 칸 시작을 구한다(slotTimes가 칸을 만드는 방식과 동일).
function floorToSlot(time: string, slotMinutes: number = SLOT_MINUTES, slotGapMinutes = 0): string | null {
  const mins = toMinutes(time)
  const start = TIMELINE_START_HOUR * 60
  const end = TIMELINE_END_HOUR * 60
  if (mins < start || mins >= end) return null
  const stride = slotMinutes + slotGapMinutes
  if (stride <= 0) return null
  const t = start + Math.floor((mins - start) / stride) * stride
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}

// 그날의 현재 시각 마커. 오늘(now.date===dateId)이고 슬롯 시간대(09:00~18:00) 안일 때만.
// "지금 HH:MM" 칩은 now가 속한 행에 **항상** 붙는다 — 미팅(상태 무관)이든 빈칸이든.
//  - live=true: 그 행이 **확정(accepted)** 진행 중 → 인디고 링/배경으로 "진행 중" 강조.
//  - live=false: 단순 현재시각 앵커(빈칸·만료 proposed·완료 등) → 칩만, 링/배경 없음(진행 중처럼 안 보이게).
function resolveNow(
  dateId: string,
  slots: TimelineSlot[],
  now?: { date: string; time: string },
  slotMinutes: number = SLOT_MINUTES,
  slotGapMinutes = 0
): NowState | null {
  if (!now || now.date !== dateId) return null
  const nowMin = toMinutes(now.time)
  // now가 속한 미팅(상태 무관, 멀티슬롯 점유칸도 시작칸으로 잡힘).
  const meeting = slots.find(
    (s): s is FilledSlot =>
      s.kind === "meeting" && toMinutes(s.time) <= nowMin && nowMin < toMinutes(s.endTime)
  )
  if (meeting) {
    return { rowTime: meeting.time, time: now.time, live: meeting.status === "accepted" }
  }
  const floor = floorToSlot(now.time, slotMinutes, slotGapMinutes)
  // 빈 시간대: now가 속한 빈 슬롯 행에 앵커(슬롯 시간대 밖이면 null).
  const floorSlot = floor ? slots.find((s) => s.time === floor) : undefined
  if (floorSlot && floorSlot.kind === "empty") {
    return { rowTime: floor as string, time: now.time, live: false }
  }
  return null
}

// date.id(YYYY-MM-DD, KST)에서 요일 라벨을 파생한다 — EventDate.weekday(백엔드/mock 한국어 고정값)는
// 쓰지 않는다(i18n). "short"이면 ko="수", en="Wed"(기존 한 글자 표기와 폭이 비슷해 레이아웃 영향 적음).
function weekdayLabel(dateId: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ko-KR", {
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${dateId}T00:00:00+09:00`))
}

export function buildTimeline(input: TimelineInput): TimelineProjection {
  // 권한 경계: 내 기업이 당사자인 미팅만 — meeting-projection 공유.
  const mine = filterViewerMeetings(input.meetings, input.viewerRole, input.viewerOrgId)
  const locale = input.locale ?? "ko"
  const t = input.t ?? defaultStatusT
  const tShort = input.tShort ?? defaultShortStatusT

  const days = input.eventDates.map((date) => {
    const slotMinutes = date.slotMinutes ?? SLOT_MINUTES
    const slotGapMinutes = date.slotGapMinutes ?? 0
    const stride = slotMinutes + slotGapMinutes
    const times = slotTimes(slotMinutes, slotGapMinutes)
    const onDate = mine.filter((m) => kstDate(m.scheduledAt) === date.id)
    // 같은 시각(칸)에 미팅이 여러 건이면(바이어 A·B·C가 같은 시간으로 각각 신청, 재신청 등) **전부**
    // 그린다(#10). 표시 순서만 정하고 아무도 버리지 않는다 — 예전엔 여기서 1건만 남겨 나머지를
    // 수락·거절할 수 없었다. onDate는 서버가 내려준 순서(created_at DESC = 최신 먼저)를 그대로
    // 유지하므로 추가 정렬 없이 넘길 수 있다 — sortSlotMeetings는 "배열 앞쪽이 최신"을 전제로
    // 동일 등급을 타이브레이크한다(안정 정렬).
    const byTime = new Map<string, MeetingRecord[]>()
    for (const m of onDate) {
      const key = kstTime(m.scheduledAt)
      const group = byTime.get(key)
      if (group) group.push(m)
      else byTime.set(key, [m])
    }
    const grouped = new Map<string, MeetingRecord[]>()
    for (const [key, group] of byTime) grouped.set(key, sortSlotMeetings(group))

    // 미팅이 여러 슬롯을 점유(30/60/90분)하면 시작칸만 블록으로 렌더하고 뒤 칸은 가린다.
    // 점유 계산은 **활성 대표 건**(occupyingSlotMeeting) 기준 — 같은 칸에서 진 미팅이나 죽은
    // 이력(rejected/cancelled)의 소요시간이 뒤의 빈 칸을 삼켜 "잡을 수 있는 시간"을 감추지 않게 한다.
    // 칸은 stride 간격으로 이어지므로, n칸이 덮는 실제 시간은 (n-1)*stride+slotMinutes다(계약서
    // §1) — slotGapMinutes=0이면 stride===slotMinutes라 예전 공식(ceil(duration/slotMinutes))과
    // 정확히 같은 값을 낸다.
    const span = (m: MeetingRecord) => {
      const duration = m.durationMinutes ?? slotMinutes
      return Math.max(1, 1 + Math.ceil((duration - slotMinutes) / stride))
    }
    // n칸을 점유했을 때 시작 시각부터의 실제 경과(분) — 마지막 칸의 끝까지(중간 텀 포함).
    const spanElapsed = (s: number) => (s - 1) * stride + slotMinutes
    const occupancy = new Map<string, number>() // 시작 시각 → 점유 칸 수(죽은 칸은 1)
    const covered = new Set<string>()
    for (const [start, group] of grouped) {
      const occupier = occupyingSlotMeeting(group)
      const s = occupier ? span(occupier) : 1
      occupancy.set(start, s)
      for (let i = 1; i < s; i++) covered.add(addMinutes(start, i * stride))
    }

    // MeetingRecord → 한 건의 표시 데이터. 액션·라벨·톤이 건별로 독립이라, 한 칸에 여러 건이 쌓여도
    // 수락/거절이 자기 meetingId로 나간다.
    const toSlotMeeting = (m: MeetingRecord, time: string): SlotMeeting => {
      const direction: RequestDirection = resolveDirection(m.requestedByOrgId, input.viewerOrgId)
      const s = span(m)
      const attended = m.attended ?? true // completed의 결과 속성(false=노쇼). 그 외 상태에선 무시.
      // 만료(수락 전 + 시작 지남): 회색·"응답 시간 지남"·액션 없음으로 덮어쓴다(상태값은 proposed 유지).
      const expired = isExpiredProposed(m.status, m.scheduledAt, input.now)
      // 종료경과(확정인데 종료 지남, 미전이): 회의록 미작성 동치 → orange. 상태값은 accepted 유지.
      const ended = isEndedAccepted(m.status, m.scheduledAt, m.durationMinutes, input.now)
      return {
        meetingId: m.id,
        status: m.status,
        attended,
        expired,
        dead: isDeadSlotMeeting(m.status),
        tone: expired ? "gray" : toneFor(m.status, { attended, hasReview: m.hasReview, ended }),
        label: expired ? t("expired") : labelFor(m.status, direction, { attended, hasReview: m.hasReview, ended }, t),
        shortLabel: expired ? tShort("expired") : shortLabelFor(m.status, direction, { attended, hasReview: m.hasReview, ended }, tShort),
        direction,
        actions: expired ? [] : actionsFor(m.status, direction, input.viewerRole, attended),
        counterpartName: m.counterpartName,
        venue: m.venue,
        span: s,
        endTime: addMinutes(time, spanElapsed(s)),
      }
    }

    const slots: TimelineSlot[] = []
    for (const time of times) {
      if (covered.has(time)) continue // 앞 미팅이 점유한 칸
      const group = grouped.get(time)
      if (!group || group.length === 0) {
        slots.push({ kind: "empty", time, tone: "gray" })
        continue
      }
      const meetings = group.map((m) => toSlotMeeting(m, time))
      const s = occupancy.get(time) ?? 1
      // 점유한 뒤 칸들의 시각(시간축에 라벨은 그대로 노출하기 위함) — 90분=["10:30","11:00"].
      const coveredTimes: string[] = []
      for (let i = 1; i < s; i++) coveredTimes.push(addMinutes(time, i * stride))
      slots.push({
        // 단수 필드는 대표 1건(meetings[0])을 그대로 이어받는다 — 칸 톤·"진행 중" 판정·축약 표현용.
        ...meetings[0],
        kind: "meeting",
        time,
        // span/endTime만 대표 건이 아니라 **점유** 기준으로 덮어쓴다(죽은 칸은 1칸).
        span: s,
        endTime: addMinutes(time, spanElapsed(s)),
        coveredTimes,
        meetings,
      })
    }

    // 받은 응답대기 배지(D11): 만료된 건은 처리 불가라 제외.
    const pendingCount = onDate.filter(
      (m) =>
        m.status === "proposed" &&
        resolveDirection(m.requestedByOrgId, input.viewerOrgId) === "received" &&
        !isExpiredProposed(m.status, m.scheduledAt, input.now)
    ).length

    return {
      dateId: date.id,
      label: date.label,
      weekday: weekdayLabel(date.id, locale),
      pendingCount,
      slots,
      isToday: !!input.now && input.now.date === date.id,
      now: resolveNow(date.id, slots, input.now, slotMinutes, slotGapMinutes),
    }
  })

  return { days, totalMeetings: mine.length }
}
