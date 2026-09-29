// OP-005 배정 저장소 — 확정된 배정(강제 배정·단일/전체 포화배정)의 서버 측 목업 영속.
// React 무의존 순수 모듈(buyer-profile-store와 동일 패턴) — route handler(서버)가 쓰고,
// serverApiClient.getAssignmentSchedule()이 mock 픽스처 위에 병합해 "새로고침 후 유지"를 만든다.
// 실연동 시 이 모듈은 FastAPI가 대체하고(배정은 backend #53 소관), 라우트 내부만 proxy로 바뀐다.

import type { AssignmentMeeting } from "./forced-assignment"

// id → meeting. 프로세스 생존 동안 유지(dev 서버 메모리). 재시작 시 초기화 — 목업 한계.
let state: Record<string, AssignmentMeeting> = {}

export function listStoredAssignments(): AssignmentMeeting[] {
  return Object.values(state)
}

// 추가 전용(포화배정 비파괴 원칙 미러). 같은 id 재전송은 덮어써 멱등으로 처리한다.
export function addAssignments(meetings: AssignmentMeeting[]): number {
  for (const m of meetings) state[m.id] = m
  return meetings.length
}

export function removeAssignment(id: string): boolean {
  if (!(id in state)) return false
  delete state[id]
  return true
}

// 테스트 전용 초기화.
export function __resetAssignmentsForTest(): void {
  state = {}
}
