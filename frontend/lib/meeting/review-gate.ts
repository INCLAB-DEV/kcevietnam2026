// H-04 — /meetings/[meetingId]는 원래 MY-002(회의록) 전용으로 만들어졌지만, 확정 전 미팅에도
// 알림이 이 경로로 딥링크한다. 회의록 폼은 미팅이 확정(accepted)된 뒤부터 자유롭게 쓸 수 있어야
// 한다는 게 제품 결정이다(발주자 결정 2026-09-14 — 행사 전이라도 회의록 작성·녹음 업로드를 막지
// 않는다). proposed/rejected/cancelled 등 확정 전·무효 상태에서는 여전히 회의록 폼 대신 미팅
// 상세를 보여준다 — 그 갈림을 결정하는 순수 판정 하나만 여기 둔다(페이지는 이 값으로 분기하기만 한다).

import type { ScheduleStatus } from "@/lib/home/meeting-status-rollup"

export function shouldShowReviewFlow(status: ScheduleStatus): boolean {
  return status === "accepted" || status === "completed"
}
