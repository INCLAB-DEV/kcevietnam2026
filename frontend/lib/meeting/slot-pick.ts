// slot-pick — 한 슬롯(같은 시간 칸)에 미팅이 여러 건 걸릴 때의 **표시 순서**와 **대표 1건**,
// 그리고 **뒤 칸을 점유하는 건**을 정하는 단일 규칙 (#2 → #10).
//
// 참가자 타임라인(lib/meeting/timeline.ts)과 운영자 강제 배정 그리드
// (components/organizer/assignment-hub.tsx)가 각자 다른 코드로 이 문제를 풀다가 사고가 났다 —
// 한쪽은 Map.set 마지막-승리(서버가 최신순으로 내려줘서 결과적으로 "가장 오래된 것이 이김"),
// 다른 한쪽은 Array.find 첫-매치(서버가 오래된순이라 역시 "가장 오래된 것이 이김"). 둘 다 배열
// 순서에 우연히 의존했을 뿐 규칙을 명시하지 않았다. 이 모듈이 그 규칙을 코드로 고정한다.
//
// 규칙(등급): 죽은 미팅(rejected/cancelled)이 산 미팅(accepted/proposed)을 절대 가리지 않는다.
//   확정(accepted) > 대기(proposed) > 완료(completed) > 거절(rejected)/취소(cancelled)
// 같은 등급이면 배열에서 먼저 나오는 쪽이 이긴다 — 즉 **호출부는 반드시 "최신이 먼저(newest-first)"
// 순서로 후보를 넘겨야 한다.** timeline.ts는 서버가 이미 created_at DESC로 주는 목록을 그대로 쓰면
// 되고, assignment-hub.tsx는 서버가 created_at ASC라 후보를 뒤집어서 넘겨야 한다(각 호출부 주석 참고).
//
// #10에서 "슬롯 = 미팅 1개" 가정을 버렸다. 화면은 sortSlotMeetings()로 **한 칸의 전부**를 쌓아
// 그리고(활성이 위·죽은 것이 아래), pickSlotMeeting()은 대표 1건이 필요한 자리(칸 톤·진행 중 판정·
// 축약 뱃지)에만 남는다. 세 함수가 같은 SLOT_PRIORITY를 쓰므로 정렬 첫 원소 === 대표 건이다.

import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"

// 숫자가 작을수록 우선순위가 높다(먼저 이긴다 = 위에 그려진다).
const SLOT_PRIORITY: Record<ScheduleStatus, number> = {
  accepted: 0,
  proposed: 1,
  completed: 2,
  rejected: 3,
  cancelled: 3,
}

// 죽은 미팅 = 더 이상 아무 일도 일어나지 않는 이력(거절·취소). 발주자 요구대로 화면에서 지우지는
// 않되(#10), 한 줄로 축약해 보여주고 뒤 칸을 점유하지 않는다.
export function isDeadSlotMeeting(status: ScheduleStatus): boolean {
  return status === "rejected" || status === "cancelled"
}

// 한 칸의 미팅 전부를 표시 순서로 정렬한다 — 활성(확정·대기)이 위, 죽은 것(거절·취소)이 아래.
// Array.prototype.sort는 안정 정렬(ES2019+)이라 같은 등급끼리는 입력 순서가 그대로 유지된다
// = 호출부의 "배열 앞쪽이 최신" 계약이 그대로 타이브레이크가 된다.
export function sortSlotMeetings<T extends { status: ScheduleStatus }>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort((a, b) => SLOT_PRIORITY[a.status] - SLOT_PRIORITY[b.status])
}

// 대표 1건(= sortSlotMeetings(candidates)[0]). 칸의 상태색·"진행 중" 판정처럼 한 칸에 하나만
// 있을 수 있는 표현에 쓴다. 배열을 새로 만들지 않도록 정렬 없이 최솟값만 훑는다.
export function pickSlotMeeting<T extends { status: ScheduleStatus }>(
  candidates: readonly T[]
): T | undefined {
  let best: T | undefined
  for (const m of candidates) {
    if (!best || SLOT_PRIORITY[m.status] < SLOT_PRIORITY[best.status]) best = m
  }
  return best
}

// 뒤 칸을 실제로 점유(가림)하는 건 — 대표 건이되 **죽은 미팅은 칸을 삼키지 않는다**.
// 90분짜리 거절 이력이 뒤의 빈 칸 두 개를 먹어 "잡을 수 있는 시간"을 감추던 잠재 버그를 막는다
// (#2에서 한 번 잡은 회귀 — 죽은 건만 남은 칸에서 되살아나지 않게 여기서 규칙으로 고정).
// 반환값이 없으면(전부 죽은 칸) 점유는 1칸이다.
export function occupyingSlotMeeting<T extends { status: ScheduleStatus }>(
  candidates: readonly T[]
): T | undefined {
  const best = pickSlotMeeting(candidates)
  return best && !isDeadSlotMeeting(best.status) ? best : undefined
}
