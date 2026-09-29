// slot-intersection (F-OP-005 D5 / F-OP-003) — 빈 슬롯과 "그 시간에 가능한 상대"를 계산한다.
//
// 그리드는 슬롯-우선이다: 빈 슬롯 [+]을 먼저 고르면, 그 슬롯에 비어있는 반대편 기업만 후보로 남는다.
// "양쪽 빈 슬롯 교집합"(F-OP-005 D5)은 슬롯이 고정된 뒤엔 곧 "상대도 그 슬롯에 비어있는가"가 된다.
// 한 미팅은 그 참가사·바이어 양쪽의 슬롯을 동시에 점유한다 — 한쪽이라도 차 있으면 그 슬롯은 불가.

import type { AssignmentMeeting } from "./forced-assignment"
import { addMinutes, occupiedSlotIds, slotId, spanOf } from "./schedule"

function startMinutes(slotId: string): number {
  const time = slotId.slice(slotId.indexOf("T") + 1)
  const [h, m] = time.split(":").map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1
}

// 두 미팅이 "같은 블록으로 이어진 것"인가 — 그리드 셀 색·라벨·출처 뱃지 + 상세 패널의 방향·장소·액션까지
// 좌우하는 필드가 모두 같아야 병합 안전(다르면 뒤 미팅 정보가 삼켜진다). 병합 블록은 이 필드들을 첫 미팅에서
// 가져가므로 requestedByOrgId(방향 라벨·액션)·venue(장소)도 비교한다(codex review P1). id/slot/duration/
// phantom 등 식별·점유 필드는 비교 대상 아님.
function isSameBlock(a: AssignmentMeeting, b: AssignmentMeeting): boolean {
  return (
    a.status === b.status &&
    a.matchingType === b.matchingType &&
    a.attended === b.attended &&
    a.hasReview === b.hasReview &&
    a.requestedByOrgId === b.requestedByOrgId &&
    a.venue === b.venue
  )
}

// 같은 상대가 시간상 연달아 잡히면 한 미팅(블록)으로 합친다 — 멀티 시간 선택이 없으니 운영자가
// 같은 기업을 인접 슬롯에 배정한 경우를 하나의 연속 미팅으로 표시·점유 처리한다(렌더·빈슬롯 판정 공용).
// 병합 기준: 같은 참가사+바이어 쌍·같은 날짜·시간 연속(뒤 미팅 시작 == 앞 블록의 마지막 칸 + stride)
// AND 표시가 같은 미팅(isSameBlock: status·matchingType·attended·hasReview·requestedByOrgId·venue
// 일치). 점심 등 시간 단절(스트라이드보다 큰 간격)이나 표시 상태가 다르면 별개 블록으로 둔다
// (codex: 병합이 뒤 미팅의 상태·방향·장소를 삼켜 잘못 표시 방지). 합친 미팅의 소요시간은 첫 칸
// 시작부터 마지막 칸 끝까지의 스팬(중간 텀 포함, 계약서 §2), 식별은 첫 미팅을 따른다.
export function mergeConsecutive(
  meetings: AssignmentMeeting[],
  slotMinutes: number,
  slotGapMinutes = 0,
): AssignmentMeeting[] {
  const stride = slotMinutes + slotGapMinutes
  const groups = new Map<string, AssignmentMeeting[]>()
  for (const m of meetings) {
    if (m.phantom) continue
    const dateId = m.slotId.slice(0, m.slotId.indexOf("T"))
    const key = `${m.exhibitorId}|${m.buyerId}|${dateId}`
    const list = groups.get(key)
    if (list) list.push(m)
    else groups.set(key, [m])
  }
  const result: AssignmentMeeting[] = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => startMinutes(a.slotId) - startMinutes(b.slotId))
    let current: AssignmentMeeting | null = null
    let blockStart = -1
    let lastSlotStart = -1
    for (const m of sorted) {
      const start = startMinutes(m.slotId)
      const span = spanOf(m.durationMinutes, slotMinutes, slotGapMinutes)
      const mLastSlotStart = start + (span - 1) * stride
      if (current !== null && start === lastSlotStart + stride && isSameBlock(current, m)) {
        const base: AssignmentMeeting = current
        lastSlotStart = mLastSlotStart
        current = { ...base, durationMinutes: lastSlotStart + slotMinutes - blockStart }
      } else {
        if (current !== null) result.push(current)
        blockStart = start
        lastSlotStart = mLastSlotStart
        current = { ...m, durationMinutes: lastSlotStart + slotMinutes - blockStart }
      }
    }
    if (current !== null) result.push(current)
  }
  return result
}

// 특정 기업이 특정 슬롯에 비어 있는가 — 그 슬롯에 그 기업이 낀 미팅이 없으면 free.
// 멀티슬롯(연속) 미팅의 뒤 칸까지 막으려면 expandOccupancy로 펼친 목록을 넘긴다.
export function isFreeAt(orgId: string, slot: string, meetings: AssignmentMeeting[]): boolean {
  return !meetings.some(
    (m) => m.slotId === slot && (m.exhibitorId === orgId || m.buyerId === orgId),
  )
}

// 기업이 비즈매칭 신청 때 그 슬롯을 "가능"으로 뒀는가 — unavailable[orgId]에 없으면 가능(available).
// 신청자가 지정한 불가 시간대는 배정 대상에서 제외한다(빈 슬롯이어도 그 기업엔 배정 불가).
export function isAvailableAt(
  orgId: string,
  slot: string,
  unavailable?: Record<string, Set<string>>,
): boolean {
  return !unavailable?.[orgId]?.has(slot)
}

// 그 슬롯에 실제로 배정 가능한가 = 비어 있고(free) AND 신청자가 가능으로 둔(available) 슬롯.
export function isOpenAt(
  orgId: string,
  slot: string,
  meetings: AssignmentMeeting[],
  unavailable?: Record<string, Set<string>>,
): boolean {
  return isFreeAt(orgId, slot, meetings) && isAvailableAt(orgId, slot, unavailable)
}

// 멀티슬롯(60/90분) 미팅을 점유 슬롯별 레코드로 펼친다 — 빈슬롯 판정(isFreeAt)이 시작칸뿐 아니라
// 뒤 칸까지 막도록. 펼친 뒤 칸은 phantom=true(카운트·렌더에서 제외). 렌더링은 원본(span)으로 한다.
export function expandOccupancy(
  meetings: AssignmentMeeting[],
  slotMinutes: number,
  slotGapMinutes = 0,
): AssignmentMeeting[] {
  const out: AssignmentMeeting[] = []
  for (const m of meetings) {
    const slots = occupiedSlotIds(m.slotId, m.durationMinutes, slotMinutes, slotGapMinutes)
    out.push(m)
    for (let i = 1; i < slots.length; i++) {
      out.push({ ...m, id: `${m.id}~occ${i}`, slotId: slots[i], phantom: true })
    }
  }
  return out
}

// max_meeting_minutes(분 상한, 계약서 §2 기본 90)를 칸 수 상한으로 환산 — freeRunLength의 기본
// maxSlots가 쓴다. slotGapMinutes=0·maxMeetingMinutes=90이면 기존 "3칸" 상한과 정확히 같다.
export function maxRunSlots(
  maxMeetingMinutes: number,
  slotMinutes: number,
  slotGapMinutes = 0,
): number {
  const stride = slotMinutes + slotGapMinutes
  if (slotMinutes <= 0 || stride <= 0) return 1
  return Math.max(1, 1 + Math.floor((maxMeetingMinutes - slotMinutes) / stride))
}

// 시작 칸부터 그 기업이 **연달아** 잡을 수 있는 칸 수 — 멀티슬롯(60/90분) 배정에서 "미팅 시간을
// 어디까지 늘릴 수 있나"를 정한다(운영자가 10:00~11:00처럼 시간 범위를 고르는 흐름, F-OP-005 QA B5).
//
// 그리드에 실재하는 칸(daySlots)만 시간순으로 따라가고, 하나라도 그리드에 없거나(운영 종료·점심으로
// 끊김) 이미 차 있거나 그 기업이 불가로 지정한 칸이면 거기서 멈춘다. 반환 0 = 시작 칸부터 못 잡는다.
// meetings에는 **살아있는** 미팅만 넣는다(거절·취소는 칸을 잡지 않는다 — lib/meeting/slot-pick의
// #10 규칙, 백엔드 slot_booking._OCCUPYING과 같은 방향).
export function freeRunLength(options: {
  orgId: string
  startSlotId: string
  slotMinutes: number
  slotGapMinutes?: number // 기본 0(하위호환) — 칸 사이 텀. 후보 칸 전진은 stride(=slotMinutes+이 값) 기준.
  daySlots: ReadonlySet<string> // 그 날짜의 배정 가능한 슬롯 id 집합(그리드 열)
  meetings: AssignmentMeeting[] // expandOccupancy 적용본(멀티슬롯 뒤 칸까지 펼쳐진 목록)
  unavailable?: Record<string, Set<string>>
  maxMeetingMinutes?: number // 기본 90분(계약서 §2) — maxSlots 미지정 시 이 값에서 칸 수 상한을 역산.
  maxSlots?: number // 명시하면 maxMeetingMinutes보다 우선(호출부가 이미 칸 수로 상한을 정할 때).
}): number {
  const { orgId, startSlotId, slotMinutes, daySlots, meetings, unavailable } = options
  const slotGapMinutes = options.slotGapMinutes ?? 0
  const stride = slotMinutes + slotGapMinutes
  const maxSlots =
    options.maxSlots ?? maxRunSlots(options.maxMeetingMinutes ?? 90, slotMinutes, slotGapMinutes)
  const sep = startSlotId.indexOf("T")
  if (sep < 0 || slotMinutes <= 0 || stride <= 0) return 0
  const dateId = startSlotId.slice(0, sep)
  const time = startSlotId.slice(sep + 1)
  let run = 0
  for (let i = 0; i < maxSlots; i++) {
    const slot = slotId(dateId, addMinutes(time, i * stride))
    if (!daySlots.has(slot)) break
    if (!isOpenAt(orgId, slot, meetings, unavailable)) break
    run++
  }
  return run
}

// 한 기업의 빈 슬롯 id 목록(유니버스 중 그 기업이 안 찬 슬롯) — 입력 슬롯 순서를 보존한다.
export function emptySlotsFor(
  orgId: string,
  allSlotIds: string[],
  meetings: AssignmentMeeting[],
): string[] {
  return allSlotIds.filter((slot) => isFreeAt(orgId, slot, meetings))
}

// 한 기업이 가진 미팅 수(셀 채움 카운트·최소 N 판정에 사용). 멀티슬롯 점유 펼침(phantom)은 제외 —
// 한 미팅은 슬롯을 여러 칸 점유해도 1건으로 센다.
export function meetingCountFor(orgId: string, meetings: AssignmentMeeting[]): number {
  return meetings.filter(
    (m) => !m.phantom && (m.exhibitorId === orgId || m.buyerId === orgId),
  ).length
}

// 빈 슬롯에서 "그 시간에 가능한 상대" — 후보 중 그 슬롯에 비어 있는 기업만. 이미 매칭순으로
// 정렬돼 들어온 candidates의 순서를 보존한다(랭킹은 seam에서, 여기선 가용성 필터만).
export function freeCounterpartsAt<T extends { id: string }>(
  slot: string,
  candidates: T[],
  meetings: AssignmentMeeting[],
): T[] {
  return candidates.filter((c) => isFreeAt(c.id, slot, meetings))
}

// 두 기업이 공통으로 비어 있는 슬롯(기업-우선으로 채울 때 쓰는 진짜 교집합) — 슬롯 순서 보존.
export function commonFreeSlots(
  orgA: string,
  orgB: string,
  allSlotIds: string[],
  meetings: AssignmentMeeting[],
): string[] {
  return allSlotIds.filter(
    (slot) => isFreeAt(orgA, slot, meetings) && isFreeAt(orgB, slot, meetings),
  )
}

// 두 기업이 이미 짝지어진 미팅이 있는가(중복 페어 방지).
export function alreadyPaired(
  orgA: string,
  orgB: string,
  meetings: AssignmentMeeting[],
): boolean {
  return meetings.some(
    (m) =>
      (m.exhibitorId === orgA && m.buyerId === orgB) ||
      (m.exhibitorId === orgB && m.buyerId === orgA),
  )
}
