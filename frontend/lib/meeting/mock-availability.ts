// 미팅 신청 모달의 고정 목업 데이터(F-MT-001 Out of Scope: 슬롯 실 조회는 API 연동 시점).
// DX Korea 2026 전시 기간(9/16~9/19)을 가정한 가용/불가 슬롯과 장소 3종을 제공한다.
// MockApiClient.getMeetingAvailability의 구현 디테일 — 컴포넌트는 buildMeetingAvailability만 본다.

import { boothLabel } from "@/lib/types"
import type { Organization } from "@/lib/types"
import { getEventSettings } from "@/lib/event/event-settings"
import type { VenueType } from "@/lib/event/event-settings"
import type { AcceptanceMode, MeetingAvailability, MeetingDate, TimeSlot, VenueKind, VenueOption } from "./types"

// 오전 09:00~11:30, 오후 12:00~17:30 (30분 단위). 불가 슬롯은 dateId+time 조합으로 지정.
const MORNING_TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]
const AFTERNOON_TIMES = [
  "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
  "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
]

// 날짜별 불가(겹침) 시각 — 양쪽 빈 슬롯 교집합을 흉내내는 고정 목업.
const UNAVAILABLE: Record<string, Set<string>> = {
  "2026-09-16": new Set(["09:00", "09:30", "12:00", "12:30", "13:00", "16:30", "17:00", "17:30"]),
  "2026-09-17": new Set(["10:30", "11:00", "12:00", "12:30", "14:30", "15:00"]),
  "2026-09-18": new Set(["09:00", "13:00", "13:30"]),
  "2026-09-19": new Set(["09:00", "09:30", "10:00", "11:30", "12:00", "12:30", "13:00", "14:00", "16:00", "16:30", "17:00", "17:30"]),
}

const DATE_META: { id: string; label: string; weekday: string }[] = [
  { id: "2026-09-16", label: "9/16", weekday: "화" },
  { id: "2026-09-17", label: "9/17", weekday: "수" },
  { id: "2026-09-18", label: "9/18", weekday: "목" },
  { id: "2026-09-19", label: "9/19", weekday: "금" },
]

function buildSlots(dateId: string, times: string[]): TimeSlot[] {
  const blocked = UNAVAILABLE[dateId] ?? new Set<string>()
  return times.map((time) => ({
    id: `${dateId}T${time}`,
    time,
    available: !blocked.has(time),
  }))
}

const MEETING_DATES: MeetingDate[] = DATE_META.map(({ id, label, weekday }) => ({
  id,
  label,
  weekday,
  morning: buildSlots(id, MORNING_TIMES),
  afternoon: buildSlots(id, AFTERNOON_TIMES),
}))

// 행사 설정(VenueType) ↔ 모달 표현 모델(VenueKind) 매핑. 이름이 다른 이유: VenueType은 어드민
// 콘솔·행사 설정 스키마(venue_types)와 맞춘 이름, VenueKind는 기존 모달 UI 계약(컴포넌트 props)이다.
const VENUE_TYPE_TO_KIND: Record<VenueType, VenueKind> = {
  booth: "booth",
  matching_zone: "table",
  business_room: "room",
}

// 장소 3종(전체 카탈로그). 실제로 내려주는 목록은 행사 설정(venueTypes)으로 걸러낸다: 베트남
// 전시는 부스만 남는다(F-MT-001, 하드코딩 대신 행사 설정에서 읽음 — 다음 행사에서 어드민이 값을
// 늘리면 자동으로 선택 UI가 돌아온다). selectable/문구는 실 경로(FastAPI build_availability)의
// 현재 운영 정책을 그대로 흉내낸다 — 부스만 예약을 받고, 나머지는 '불가능'으로 남긴다.
function allVenueOptions(recipient: Organization): VenueOption[] {
  // 부스 주인은 언제나 참가사다. mock은 상대(recipient) 한쪽만 알기 때문에 상대가 참가사일 때만
  // 기업명을 쓰고, 아니면(참가사가 바이어에게 신청하는 방향) 일반 명칭으로 떨어진다 — 실 경로는
  // 쌍의 참가사에서 직접 뽑으므로 방향과 무관하게 정확하다.
  const exhibitorName = recipient.role === "exhibitor" ? recipient.name : null
  const booth = boothLabel(recipient.booth)
  return [
    {
      kind: "booth",
      name: exhibitorName ? `${exhibitorName} 부스` : "참가기업 부스",
      description: booth ? `참가기업 부스 ${booth} 미팅` : "참가기업 부스에서 미팅",
      badge: { text: "가능", tone: "available" },
      selectable: true,
    },
    {
      kind: "table",
      name: "비즈매칭존 테이블",
      description: "2층 비즈매칭존 · 주최측 지정 테이블",
      badge: { text: "불가능", tone: "unavailable" },
      selectable: false,
      numbers: [
        { id: "T-01", label: "T-01", available: true },
        { id: "T-02", label: "T-02", available: true },
        { id: "T-03", label: "T-03", available: false },
        { id: "T-04", label: "T-04", available: true },
        { id: "T-05", label: "T-05", available: true },
        { id: "T-06", label: "T-06", available: false },
      ],
    },
    {
      kind: "room",
      name: "비즈니스 룸",
      description: "3층 프라이빗 회의실 · 사전 예약 필요",
      badge: { text: "불가능", tone: "unavailable" },
      selectable: false,
      numbers: [
        { id: "Room A", label: "Room A", available: false },
        { id: "Room B", label: "Room B", available: true },
        { id: "Room C", label: "Room C", available: true },
        { id: "Room D", label: "Room D", available: false },
      ],
    },
  ]
}

function venueOptions(recipient: Organization): VenueOption[] {
  const allowedKinds = new Set(getEventSettings().venueTypes.map((t) => VENUE_TYPE_TO_KIND[t]))
  return allVenueOptions(recipient).filter((v) => allowedKinds.has(v.kind))
}

// AI 초안 신청 사유(F-MT-001 D4·User Story 5) — 프로필 기반 자동 생성을 흉내낸 목업.
// 실 연동 시 backend가 신청자 프로필+상대 기업으로 생성(Claude API). 여기선 상대 정보로 템플릿 채움.
function draftReason(recipient: Organization): string {
  const focus = recipient.keywords[0]
  const focusLine = focus
    ? `특히 ${focus} 분야에서 귀사의 기술력과 협력 가능성을 자세히 알고 싶습니다.`
    : `귀사의 기술력과 협력 가능성을 자세히 알고 싶습니다.`
  return [
    `안녕하세요, ${recipient.name} 담당자님.`,
    "",
    `저희는 귀사의 사업 분야에 큰 관심이 있습니다. ${focusLine}`,
    "",
    "행사에서 직접 뵙고 이야기 나눌 수 있기를 기대합니다.",
  ].join("\n")
}

// 진입 상태(ADR-0005)는 실연동 시 backend(acceptance_rule.py)가 소유한다. 목업 단계에선 이 어댑터가
// 그 응답을 대신 만든다 — provenance와 무관하게 "받는 쪽 유형"만으로 결정: 초청 바이어(Hosted)
// 수신만 즉시 확정, 그 외(일반 바이어·Exhibitor)는 수락 대기. FE는 이 값을 재유도하지 않고 그대로 쓴다.
function acceptanceModeFor(recipient: Organization): AcceptanceMode {
  if (recipient.role === "buyer" && recipient.buyerType === "hosted") {
    return "immediate"
  }
  return "pending"
}

// 한 상대 기업에 대한 신청 모달 가용성 묶음(슬롯·장소·AI 초안·진입 상태). MockApiClient가 이 한 함수만 호출한다.
export function buildMeetingAvailability(recipient: Organization): MeetingAvailability {
  return {
    dates: MEETING_DATES,
    venues: venueOptions(recipient),
    draftReason: draftReason(recipient),
    acceptanceMode: acceptanceModeFor(recipient),
    // 이 목의 격자는 위 MORNING_TIMES/AFTERNOON_TIMES가 30분 단위·텀 없음으로 고정돼 있으므로
    // 그 사실과 일치시킨다(mt003gap0001). 값이 어긋나면 모달의 종료 시각·연속 상한이 목 데이터와
    // 따로 논다 — 40분/텀5분 격자를 목으로 시험하려면 위 시각 목록도 함께 바꿔야 한다.
    slotMinutes: 30,
    slotGapMinutes: 0,
    maxMeetingMinutes: 90,
  }
}
