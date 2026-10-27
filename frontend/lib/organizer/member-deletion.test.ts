// 참가기업 삭제 영향 — 백엔드 응답 변환과 다이얼로그 문구.
// 여기서 고정하는 것: ① 모양이 어긋난 응답은 0으로 채우지 않고 "읽지 못함"이 된다 ② 문구가 건수와
// 할 일을 구체적으로 말한다 ③ "명단에 없음"(ORG_NOT_FOUND)은 백엔드의 구조화된 404에서만 나오고 다른 실패와 갈린다.
import { describe, expect, it } from "vitest"

import {
  describeDeletionBlockers,
  deletionErrorCode,
  describeDeletionConsequences,
  isOrgNotFoundError,
  MOCK_DELETION_IMPACT,
  MemberDeletionImpactSchema,
  ORG_NOT_FOUND,
  toMemberDeletionImpact,
  type MemberDeletionImpact,
} from "./member-deletion"

const BACKEND = {
  organization_id: "org-1",
  deletable: true,
  scheduled_count: 0,
  completed_count: 0,
  closed_meeting_count: 2,
  review_count: 1,
  transcription_job_count: 0,
  notification_count: 3,
  draft_item_count: 1,
  linked_record_count: 4,
  member_count: 1,
  organization_deleted: true,
  other_event_count: 0,
}

function impact(over: Partial<MemberDeletionImpact> = {}): MemberDeletionImpact {
  return { ...MOCK_DELETION_IMPACT, ...over }
}

describe("toMemberDeletionImpact", () => {
  it("백엔드 응답(snake_case)을 화면 모양으로 옮긴다", () => {
    expect(toMemberDeletionImpact(BACKEND)).toEqual({
      deletable: true,
      scheduledCount: 0,
      completedCount: 0,
      closedMeetingCount: 2,
      reviewCount: 1,
      transcriptionJobCount: 0,
      notificationCount: 3,
      draftItemCount: 1,
      linkedRecordCount: 4,
      memberCount: 1,
      organizationDeleted: true,
    })
  })

  it("칸이 빠지거나 형이 다른 응답은 null이다 — 0으로 채우지 않는다", () => {
    const missing: Record<string, unknown> = { ...BACKEND }
    delete missing.review_count
    expect(toMemberDeletionImpact(missing)).toBeNull()
    const noLinked: Record<string, unknown> = { ...BACKEND }
    delete noLinked.linked_record_count
    expect(toMemberDeletionImpact(noLinked)).toBeNull()
    expect(toMemberDeletionImpact({ ...BACKEND, scheduled_count: "2" })).toBeNull()
    expect(toMemberDeletionImpact({ ...BACKEND, closed_meeting_count: -1 })).toBeNull()
    expect(toMemberDeletionImpact({ ...BACKEND, deletable: "yes" })).toBeNull()
    expect(toMemberDeletionImpact(null)).toBeNull()
    expect(toMemberDeletionImpact({})).toBeNull()
  })

  it("변환 결과는 화면 스키마를 통과한다(BFF → 클라이언트 계약)", () => {
    expect(MemberDeletionImpactSchema.safeParse(toMemberDeletionImpact(BACKEND)).success).toBe(true)
    expect(MemberDeletionImpactSchema.safeParse({ deletable: true }).success).toBe(false)
  })
})

describe("describeDeletionBlockers", () => {
  it("막는 것이 없으면 빈 배열이다", () => {
    expect(describeDeletionBlockers({ scheduledCount: 0, completedCount: 0 })).toEqual([])
  })

  it("예정 미팅 — 건수와 할 일(먼저 취소)을 말한다", () => {
    expect(describeDeletionBlockers({ scheduledCount: 2, completedCount: 0 })).toEqual([
      "예정된 미팅이 2건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요.",
    ])
  })

  it("완료 미팅 — 건수와 삭제할 수 없는 이유를 말한다", () => {
    expect(describeDeletionBlockers({ scheduledCount: 0, completedCount: 1 })).toEqual([
      "완료된 미팅이 1건 있어 삭제할 수 없습니다(상대 기업의 회의록이 함께 사라집니다).",
    ])
  })

  it("둘 다 있으면 둘 다 알린다", () => {
    expect(describeDeletionBlockers({ scheduledCount: 1, completedCount: 3 })).toHaveLength(2)
  })
})

describe("describeDeletionConsequences", () => {
  it("닫힌 미팅과 함께 지워지는 회의록·알림을 건수와 함께 나열한다", () => {
    expect(
      describeDeletionConsequences(
        impact({ closedMeetingCount: 2, reviewCount: 1, notificationCount: 3, memberCount: 1 }),
      ),
    ).toEqual([
      "취소·거절된 미팅 2건과 회의록 1건·알림 3건이 함께 삭제됩니다.",
      "로그인 계정 1개도 삭제됩니다.",
    ])
  })

  it("알림 건수는 미팅에 매달지 않는다 — 기업 정보가 지워지면 이 기업 인박스의 미팅 무관 알림도 들어 있다", () => {
    const lines = describeDeletionConsequences(impact({ closedMeetingCount: 1, notificationCount: 5 }))
    expect(lines).toEqual(["취소·거절된 미팅 1건과 알림 5건이 함께 삭제됩니다."])
    expect(lines.join(" ")).not.toContain("그 미팅의")
  })

  it("미팅이 없어도 함께 지워지는 알림이 있으면 따로 알린다", () => {
    expect(describeDeletionConsequences(impact({ notificationCount: 2 }))).toEqual([
      "함께 삭제되는 미팅은 없습니다.",
      "알림 2건이 함께 삭제됩니다.",
    ])
  })

  it("연결 기록(관심 표시·러브콜·AI 추천 등)이 있으면 한 줄로 알린다", () => {
    expect(describeDeletionConsequences(impact({ linkedRecordCount: 3, memberCount: 1 }))).toEqual([
      "함께 삭제되는 미팅은 없습니다.",
      "이 기업과 연결된 관심 표시·러브콜·AI 추천 등 3건도 함께 삭제됩니다.",
      "로그인 계정 1개도 삭제됩니다.",
    ])
  })

  it("딸린 것이 없는 닫힌 미팅은 미팅만 말한다", () => {
    expect(describeDeletionConsequences(impact({ closedMeetingCount: 1 }))).toEqual([
      "취소·거절된 미팅 1건이 함께 삭제됩니다.",
    ])
  })

  it("녹음 전사 기록과 일괄 배정 기록(초안·확정 항목)도 있으면 알린다", () => {
    expect(
      describeDeletionConsequences(
        impact({ closedMeetingCount: 1, transcriptionJobCount: 2, draftItemCount: 4 }),
      ),
    ).toEqual([
      "취소·거절된 미팅 1건과 녹음 전사 기록 2건이 함께 삭제됩니다.",
      "일괄 배정 기록 4건도 삭제됩니다.",
    ])
  })

  it("미팅이 없으면 없다고 분명히 말한다(읽지 못한 것과 구분된다)", () => {
    expect(describeDeletionConsequences(impact())).toEqual(["함께 삭제되는 미팅은 없습니다."])
  })

  it("다른 행사에도 기록이 있는 기업은 기업 정보와 로그인 계정이 남는다고 알린다", () => {
    const lines = describeDeletionConsequences(
      impact({ organizationDeleted: false, memberCount: 0, closedMeetingCount: 1 }),
    )
    expect(lines).toContain(
      "다른 행사에도 이 기업의 기록이 있어 기업 정보와 로그인 계정은 남고, 이 행사 참가만 삭제됩니다.",
    )
    expect(lines.join(" ")).not.toContain("로그인 계정 0개")
  })
})

describe("deletionErrorCode — BFF가 붙이는 오류 코드의 마지막 관문", () => {
  it("구조화된 코드가 ORG_NOT_FOUND인 404만 ORG_NOT_FOUND다", () => {
    expect(deletionErrorCode(404, ORG_NOT_FOUND, ORG_NOT_FOUND)).toBe(ORG_NOT_FOUND)
  })

  it("코드 없는 404(평문 detail·빈 바디)는 문장과 상관없이 http_404다", () => {
    expect(deletionErrorCode(404, undefined, "Not Found")).toBe("http_404")
    expect(deletionErrorCode(404, undefined, "기업을 찾을 수 없습니다")).toBe("http_404")
    expect(deletionErrorCode(404, undefined, ORG_NOT_FOUND)).toBe("http_404")
    expect(deletionErrorCode(404, undefined, "http_404")).toBe("http_404")
  })

  it("다른 코드의 404는 그 코드 그대로다(화면에는 일반 실패)", () => {
    expect(deletionErrorCode(404, "EVENT_GONE", "EVENT_GONE")).toBe("EVENT_GONE")
  })

  it("다른 상태는 호출부의 error 그대로 — 우연히 ORG_NOT_FOUND와 같으면 http_{status}로 바꾼다", () => {
    expect(deletionErrorCode(409, "ORG_HAS_MEETINGS", "ORG_HAS_MEETINGS")).toBe("ORG_HAS_MEETINGS")
    expect(deletionErrorCode(403, undefined, "master 권한이 필요합니다")).toBe("master 권한이 필요합니다")
    expect(deletionErrorCode(409, ORG_NOT_FOUND, ORG_NOT_FOUND)).toBe("http_409")
    expect(deletionErrorCode(403, undefined, ORG_NOT_FOUND)).toBe("http_403")
  })
})

describe("isOrgNotFoundError", () => {
  it("'명단에 없음'(ORG_NOT_FOUND)으로 던진 오류만 참이다 — 다른 실패와 섞이지 않는다", () => {
    expect(isOrgNotFoundError(new Error(ORG_NOT_FOUND))).toBe(true)
    expect(isOrgNotFoundError(new Error("http_500"))).toBe(false)
    expect(isOrgNotFoundError(new Error("no_event"))).toBe(false)
    expect(isOrgNotFoundError(new Error("invalid_response"))).toBe(false)
    expect(isOrgNotFoundError(ORG_NOT_FOUND)).toBe(false)
    expect(isOrgNotFoundError(undefined)).toBe(false)
  })
})
