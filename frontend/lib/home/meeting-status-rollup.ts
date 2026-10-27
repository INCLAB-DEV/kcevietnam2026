// Schedule Table 행을 상태별 건수로 집계하는 읽기 전용 규칙 (HM-001 블록 ①).
// 상태값·수락 규칙은 ADR-0005를 따른다. 상태는 상위(생성 시점)에서 받는 쪽 유형에 따라
// 이미 결정되므로(초청 바이어=accepted / 일반 바이어·Exhibitor=proposed), 여기서는 세기만 한다.

// ADR-0010 보정: noshow는 상태가 아니라 completed 미팅의 결과 속성(불참 여부)이다. 미팅이 끝나면
// 상태는 completed 하나, "노쇼였는지"는 MeetingRecord.attended(=post_meeting_reviews 입력값)로 표현한다.
export type ScheduleStatus =
  | "proposed"
  | "accepted"
  | "completed"
  | "cancelled"
  | "rejected"

// viewer 기준 요청 방향: sent=내가 신청(상대 수락 대기) / received=상대가 신청(내가 수락해야) /
// organizer=운영자가 배정(신청 주체인 org가 없음, MeetingRecord.requestedByOrgId===null).
// proposed 건에만 의미가 있다. organizer는 참가자 신청 경로(POST /api/meetings)로는 만들어지지
// 않아 현재는 사실상 도달하지 않지만, 백엔드 계약(MeetingOut.requested_by_org_id nullable —
// "organizer 생성이면 None")을 그대로 반영해 타입을 넓혀둔다(resolveDirection 참고).
export type RequestDirection = "sent" | "received" | "organizer"

export interface ScheduleEntry {
  id: string
  status: ScheduleStatus
  hasReview: boolean
  // 참석 여부(completed에서만 의미, false=노쇼). 미지정 시 참석. 노쇼는 회의록 대상에서 제외하는 데 쓴다.
  attended?: boolean
  direction: RequestDirection
}

export interface MeetingStatusRollup {
  upcoming: number // accepted (확정·미진행)
  sentRequests: number // proposed & 내가 보냄
  receivedRequests: number // proposed & 내가 받음 (내가 수락해야)
  completed: number // 미팅 완료(노쇼 포함 — 노쇼는 completed의 결과 속성)
  pendingReview: number // 완료 AND 리뷰 미작성
  // #3(F9) — 홈 카드는 여전히 성사 안 된 건을 현황에서 뺀다(의도된 설계, 유지). 다만 "왜 미팅
  // 화면 블록 수와 다른가"를 설명하려면 취소·거절 건수를 별도로 알아야 해서 추가한다.
  // 미팅 화면(timeline.ts)은 이 두 상태도 회색 블록으로 그대로 그리므로, upcoming+sentRequests+
  // receivedRequests+completed+cancelled+rejected ≈ 미팅 화면에서 눈에 보이는 총 블록 수다
  // (행사기간 밖 미팅·슬롯 중복 등 다른 요인이 없다는 전제 하에).
  cancelled: number
  rejected: number
}


// 분류 정의(단일 소스). rollup 카운트와 MY-001 상단 스트립의 "처리 대상" 선별이 모두 이 술어를
// 공유해, 한쪽 정의만 바뀌어 카운트/대상이 어긋나는 일을 없앤다(codex P2).
export function isReceivedRequest(e: ScheduleEntry): boolean {
  return e.status === "proposed" && e.direction === "received" // 받은 미팅요청(내가 수락해야)
}
export function isPendingReview(e: ScheduleEntry): boolean {
  // 회의록 작성 대상 = 완료 & 참석 & 미작성. 노쇼(미참석)는 회의록 불가라 제외(참석으로 정정하면 대상이 됨).
  return e.status === "completed" && (e.attended ?? true) && !e.hasReview
}

export function rollupMeetingStatus(entries: ScheduleEntry[]): MeetingStatusRollup {
  const count = (status: ScheduleStatus) => entries.filter((e) => e.status === status).length
  const proposedBy = (direction: RequestDirection) =>
    entries.filter((e) => e.status === "proposed" && e.direction === direction).length

  return {
    upcoming: count("accepted"),
    sentRequests: proposedBy("sent"),
    receivedRequests: entries.filter(isReceivedRequest).length,
    completed: count("completed"),
    pendingReview: entries.filter(isPendingReview).length,
    cancelled: count("cancelled"),
    rejected: count("rejected"),
  }
}
