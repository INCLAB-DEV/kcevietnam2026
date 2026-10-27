// OP-002 — 참가기업 삭제 영향(삭제 확인 다이얼로그가 지우기 전에 읽는 값)의 모양·검증·문구.
//
// 백엔드 GET /api/admin/events/{event}/organizations/{org}/deletion-impact 의 화면용 모양이다.
// 실제 삭제(DELETE)와 **같은 판정 함수**가 만든 값이라(backend app/admin/service.py
// assess_organization_deletion), 여기서 판정을 다시 계산하지 않는다 — deletable을 그대로 믿는다.
//
// 삭제 규칙(이 행사에서 이 기업이 걸린 미팅 기준):
//   · 미팅 없음 / 취소·거절된 미팅만 있음 → 삭제(그 미팅 행도 함께 지운다)
//   · 예정(수락 대기·확정) 미팅이 있음   → 막는다. 먼저 취소해야 한다(취소하면 상대 기업에 알림이 간다)
//   · 완료된 미팅이 있음               → 막는다(상대 기업의 회의록·미팅 이력이 함께 사라진다)
//
// 건수는 삭제하면 **실제로 사라지는 행 수**다(백엔드 테스트가 삭제 전후 DB를 견줘 확인한다). 기업 정보(조직)와
// 로그인 계정은 다른 행사에 이 기업의 흔적이 하나도 없을 때만 함께 지워지고, 그때는 이 기업이 받은 알림 전부와
// 연결 기록(관심 표시·러브콜·AI 추천·대화 채널·통역 배정)도 함께 사라진다 — 그래서 알림 건수는 "그 미팅의
// 알림"이 아니라 지워지는 알림 전체다.
//
// 순수 모듈(React·fetch 없음) — BFF 라우트와 다이얼로그, 테스트가 함께 쓴다.

import { z } from "zod"

const count = z.number().int().nonnegative()

export const MemberDeletionImpactSchema = z.object({
  deletable: z.boolean(),
  // 막는 사유
  scheduledCount: count, // 예정(수락 대기·확정) 미팅
  completedCount: count, // 완료된 미팅
  // 함께 지워지는 것(실제로 사라지는 행 수)
  closedMeetingCount: count, // 취소·거절된 미팅
  reviewCount: count, // 회의록 — 그 미팅의 것 + (기업 정보가 지워지면) 이 기업이 쓴 것
  transcriptionJobCount: count, // 녹음 전사 기록 — 같은 방식
  notificationCount: count, // 알림 — 그 미팅의 알림(양쪽 기업) + (기업 정보가 지워지면) 이 기업이 받은 알림 전부
  draftItemCount: count, // 이 행사의 일괄 배정 기록(초안·확정 항목)
  linkedRecordCount: count, // 관심 표시·러브콜·AI 추천·대화 채널·통역 배정 — 기업 정보가 남으면 0
  memberCount: count, // 로그인 계정 — 기업 정보가 남으면 0
  // 기업 정보(조직)까지 지워지는가. 다른 행사에 이 기업의 흔적이 있으면 false — 이 행사 참가만 빠진다.
  organizationDeleted: z.boolean(),
})

export type MemberDeletionImpact = z.infer<typeof MemberDeletionImpactSchema>

const BackendImpactSchema = z.object({
  deletable: z.boolean(),
  scheduled_count: count,
  completed_count: count,
  closed_meeting_count: count,
  review_count: count,
  transcription_job_count: count,
  notification_count: count,
  draft_item_count: count,
  linked_record_count: count,
  member_count: count,
  organization_deleted: z.boolean(),
})

// 백엔드 응답(snake_case) → 화면 모양. 모양이 어긋나면 null — 호출부가 "읽지 못함"으로 다룬다.
// 빠진 칸을 0으로 채우지 않는다: 모르는 것을 "함께 지워지는 것 없음"으로 보여 주면 안 된다.
export function toMemberDeletionImpact(raw: unknown): MemberDeletionImpact | null {
  const parsed = BackendImpactSchema.safeParse(raw)
  if (!parsed.success) return null
  const b = parsed.data
  return {
    deletable: b.deletable,
    scheduledCount: b.scheduled_count,
    completedCount: b.completed_count,
    closedMeetingCount: b.closed_meeting_count,
    reviewCount: b.review_count,
    transcriptionJobCount: b.transcription_job_count,
    notificationCount: b.notification_count,
    draftItemCount: b.draft_item_count,
    linkedRecordCount: b.linked_record_count,
    memberCount: b.member_count,
    organizationDeleted: b.organization_deleted,
  }
}

// 이 행사 명단에 그 기업이 없다 — 삭제(DELETE)·미리보기(GET deletion-impact)의 백엔드가 구조화된 404
// detail {"code": "ORG_NOT_FOUND", ...}로 알린다. BFF는 **이 코드가 실린 404만** 이 코드로 옮긴다
// (deletionErrorCode). 평문 404(라우팅·배포가 어긋난 "Not Found" 등)와 행사 해석 실패(no_event)는 이것이 아니다.
//
// 화면은 이것을 받아도 그 행을 임의로 숨기지 않고 명단을 서버에서 다시 읽는다. 404만으로는 "다른 운영자가
// 먼저 지웠다"와 "다른 탭에서 행사를 바꿔 요청이 다른 행사로 갔다"(운영자 콘솔은 선택 행사를 쿠키로 고른다)를
// 가를 수 없다 — 정말 지워졌으면 새 명단에서 빠지고, 행사가 바뀌었으면 바뀐 행사의 명단이 보인다.
export const ORG_NOT_FOUND = "ORG_NOT_FOUND"

// "이 행사 명단에 없음"의 안내 — 단정하지 않는다(404만으로는 지워졌는지 행사가 바뀌었는지 모른다). 삭제 확인
// 다이얼로그(미리보기 404)와 명단의 토스트(삭제 404)가 같은 문장을 쓴다.
export const MEMBER_NOT_FOUND_HINT =
  "다른 운영자가 먼저 삭제했거나 다른 탭에서 행사를 바꿨을 수 있어요. 명단을 새로 불러왔어요."

// 미리보기 읽기(getMemberDeletionImpact)가 던진 오류가 "이 행사 명단에 없음"인가.
export function isOrgNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === ORG_NOT_FOUND
}

// BFF가 삭제·미리보기의 백엔드 실패에 붙일 오류 코드 — 두 BFF가 마지막에 이 함수를 거친다.
//   · ORG_NOT_FOUND는 백엔드가 구조화된 코드(code — 문자열 detail이면 없다)로 그렇게 말한 404에만 붙는다.
//   · 그 밖의 404 중 코드가 없는 것(평문 detail·빈 바디)은 일반 실패 http_404다 — 문장을 그대로 코드 자리에
//     두지 않는다(평문이 우연히 "ORG_NOT_FOUND"여도 "기업 없음"이 되지 않게).
//   · 다른 상태의 오류가 우연히 ORG_NOT_FOUND와 같아도 http_{status}로 바꾼다. 나머지는 호출부가 고른 error 그대로.
export function deletionErrorCode(status: number, code: string | undefined, error: string): string {
  if (status === 404) {
    if (code === ORG_NOT_FOUND) return ORG_NOT_FOUND
    if (code === undefined) return "http_404"
  }
  return error === ORG_NOT_FOUND ? `http_${status}` : error
}

// 목업 모드(dev 스위처 — 실 저장소가 없다)의 삭제 영향. 지울 서버 데이터가 없으니 "그냥 삭제"다.
export const MOCK_DELETION_IMPACT: MemberDeletionImpact = {
  deletable: true,
  scheduledCount: 0,
  completedCount: 0,
  closedMeetingCount: 0,
  reviewCount: 0,
  transcriptionJobCount: 0,
  notificationCount: 0,
  draftItemCount: 0,
  linkedRecordCount: 0,
  memberCount: 0,
  organizationDeleted: true,
}

type Blockers = Pick<MemberDeletionImpact, "scheduledCount" | "completedCount">

// 삭제를 막는 이유와 할 일 — 한 줄에 사유 하나. 막는 것이 없으면 빈 배열.
// 다이얼로그(미리보기)와 삭제 거부(409) 안내가 같은 문구를 쓴다.
export function describeDeletionBlockers({ scheduledCount, completedCount }: Blockers): string[] {
  const lines: string[] = []
  if (scheduledCount > 0) {
    lines.push(
      `예정된 미팅이 ${scheduledCount}건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요.`,
    )
  }
  if (completedCount > 0) {
    lines.push(
      `완료된 미팅이 ${completedCount}건 있어 삭제할 수 없습니다(상대 기업의 회의록이 함께 사라집니다).`,
    )
  }
  return lines
}

// 삭제하면 함께 지워지는 것 — 한 줄에 한 가지. 삭제 가능할 때 다이얼로그가 보여 준다.
// 회의록·전사 기록·알림은 "그 미팅의 것"만이 아니라(기업 정보가 지워지면 이 기업 것도 함께 간다) 지워지는
// 전체 건수라, 미팅에 매단 말("그 미팅의")을 붙이지 않는다.
export function describeDeletionConsequences(impact: MemberDeletionImpact): string[] {
  const lines: string[] = []
  const records = [
    impact.reviewCount > 0 ? `회의록 ${impact.reviewCount}건` : null,
    impact.transcriptionJobCount > 0 ? `녹음 전사 기록 ${impact.transcriptionJobCount}건` : null,
    impact.notificationCount > 0 ? `알림 ${impact.notificationCount}건` : null,
  ].filter((part): part is string => part !== null)
  if (impact.closedMeetingCount > 0) {
    lines.push(
      records.length > 0
        ? `취소·거절된 미팅 ${impact.closedMeetingCount}건과 ${records.join("·")}이 함께 삭제됩니다.`
        : `취소·거절된 미팅 ${impact.closedMeetingCount}건이 함께 삭제됩니다.`,
    )
  } else {
    lines.push("함께 삭제되는 미팅은 없습니다.")
    if (records.length > 0) lines.push(`${records.join("·")}이 함께 삭제됩니다.`)
  }
  if (impact.linkedRecordCount > 0) {
    lines.push(
      `이 기업과 연결된 관심 표시·러브콜·AI 추천 등 ${impact.linkedRecordCount}건도 함께 삭제됩니다.`,
    )
  }
  if (impact.draftItemCount > 0) {
    lines.push(`일괄 배정 기록 ${impact.draftItemCount}건도 삭제됩니다.`)
  }
  if (!impact.organizationDeleted) {
    lines.push(
      "다른 행사에도 이 기업의 기록이 있어 기업 정보와 로그인 계정은 남고, 이 행사 참가만 삭제됩니다.",
    )
  } else if (impact.memberCount > 0) {
    lines.push(`로그인 계정 ${impact.memberCount}개도 삭제됩니다.`)
  }
  return lines
}
