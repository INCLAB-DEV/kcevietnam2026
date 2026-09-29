// 미팅 신청 3탭 모달(F-MT-001 D4)의 클라이언트 선택 모델.
// 목업 단계: 슬롯 가용성·미팅 생성은 실 API 없이 고정 목업으로 표현(F-MT-001 Out of Scope).
// 실 연동 시점에 양쪽 빈 슬롯 교집합 계산 + FastAPI 미팅 생성으로 대체된다(F-MT-001 D13).

// 미팅 장소 3종 (F-MT-001 D4): 참가사 부스 · 비즈매칭존 테이블 · 비즈니스 룸.
export type VenueKind = "booth" | "table" | "room"

// 신청 시 미팅이 들어갈 진입 상태(accepted=immediate / proposed=pending). ADR-0005 규칙은
// 백엔드가 소유(ADR-0008)하며, seam 페이로드(MeetingAvailability)로 내려온다. 표현 모듈
// (acceptance.ts)도 이 contract 타입을 import해 쓴다 — 의존 방향은 표현 → contract.
export type AcceptanceMode = "immediate" | "pending"

// 30분 단위 슬롯. id는 날짜+시각으로 유일.
export interface TimeSlot {
  id: string // 예: "2026-09-16T10:00"
  time: string // 표시용 "10:00"
  available: boolean // 양쪽 모두 가능 여부 (목업: 일부 false)
}

// 신청 가능 날짜. 오전/오후로 슬롯을 나눠 보여준다.
export interface MeetingDate {
  id: string // "2026-09-16"
  label: string // "9/16"
  weekday: string // "화"
  morning: TimeSlot[]
  afternoon: TimeSlot[]
}

// 장소 하위 번호(테이블/룸). 부스는 번호 선택이 없다.
export interface VenueNumber {
  id: string // "T-01" / "Room B"
  label: string
  available: boolean
}

// 장소 선택지. badge는 가용성 표시(가능 / 잔여 N석 등). "unavailable"은 실 백엔드 계약
// (VenueBadgeOut.tone)에만 있는 값 — 목업은 만들지 않지만 화면은 받아 그릴 수 있어야 한다.
export interface VenueOption {
  kind: VenueKind
  name: string
  description: string
  badge?: { text: string; tone: "available" | "limited" | "unavailable" }
  numbers?: VenueNumber[] // 테이블/룸만. 부스는 undefined.
}

// 미팅 신청 모달이 한 상대 기업에 대해 읽는 가용성 묶음(슬롯·장소·AI 초안·진입 상태).
// 데이터 출처는 api-client seam(MockApiClient.getMeetingAvailability) — 화면은 받은 값을 그리기만 한다.
// 실연동 시 FastAPI가 양쪽 빈 슬롯 교집합 + Claude 초안으로 채운다(F-MT-001 D13).
export interface MeetingAvailability {
  dates: MeetingDate[]
  venues: VenueOption[]
  draftReason: string
  // 신청 시 미팅이 들어갈 진입 상태(accepted=immediate / proposed=pending). ADR-0005 규칙은
  // 백엔드가 소유하므로(ADR-0008) FE는 재유도하지 않고 seam이 내려준 이 값을 그대로 쓴다.
  acceptanceMode: AcceptanceMode
  // 격자 모양 세 축(Phase 1, mt003gap0001). TimeSlot이 **시작 시각만** 싣고 종료 시각을 안 실으므로
  // "선택 구간의 끝"과 소요시간 라벨은 이 값들로 계산해야 한다 — 30분을 상수로 박으면 40분 상담이
  // 화면에 "10:00 - 10:30"으로 찍힌다. 간격(stride) = slotMinutes + slotGapMinutes.
  slotMinutes: number
  slotGapMinutes: number
  // 연속 슬롯을 이은 미팅 1건의 **스팬** 상한(분). 칸 수 상한이 아니다: 40분/텀5분에서 2칸은 85분,
  // 3칸은 130분이라 같은 "3칸"이라도 상한 90분이면 2칸까지만 된다.
  maxMeetingMinutes: number
}

// 3탭 진행 중 누적되는 선택 상태.
export interface MeetingDraft {
  dateId: string | null
  slotIds: string[] // 연속 슬롯 — 개수 상한이 아니라 maxMeetingMinutes(분)로 제한한다
  venueKind: VenueKind | null
  venueNumber: string | null // 테이블/룸 번호 (부스는 null)
  reason: string
}
