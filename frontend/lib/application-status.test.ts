import { describe, expect, it } from "vitest"
import {
  APPLICATION_STATUSES,
  canEdit,
  canReview,
  canSelfEditProfile,
  hasApplication,
  isMatchingExposed,
  type ApplicationStatus,
} from "./application-status"

// 승인 게이트 술어의 정본 계약 — 상태값 분기는 코드 전체가 이 술어들로만 판정한다(문자열 비교 금지).

describe("승인 게이트 술어", () => {
  it("매칭 노출은 approved만", () => {
    expect(APPLICATION_STATUSES.filter(isMatchingExposed)).toEqual(["approved"])
  })

  it("검토 대상은 submitted만", () => {
    expect(APPLICATION_STATUSES.filter(canReview)).toEqual(["submitted"])
  })

  it("활성 신청서는 submitted·changes_requested·approved", () => {
    expect(APPLICATION_STATUSES.filter(hasApplication)).toEqual([
      "submitted",
      "changes_requested",
      "approved",
    ])
  })
})

describe("canEdit(작성 폼 진입) vs canSelfEditProfile(마이페이지 구획 편집)", () => {
  it("작성 폼은 미작성·보완요청만 열린다(제출 후 잠금)", () => {
    expect(APPLICATION_STATUSES.filter(canEdit)).toEqual([
      "registered",
      "changes_requested",
    ])
  })

  it("마이페이지 구획 편집은 승인 후 정정까지 열린다 — approved가 추가 대상", () => {
    expect(APPLICATION_STATUSES.filter(canSelfEditProfile)).toEqual([
      "registered",
      "changes_requested",
      "approved",
    ])
  })

  it("검토 대기(submitted)와 반려(rejected)는 두 경로 모두 잠긴다", () => {
    for (const locked of ["submitted", "rejected"] as ApplicationStatus[]) {
      expect(canEdit(locked)).toBe(false)
      expect(canSelfEditProfile(locked)).toBe(false)
    }
  })

  it("승인된 프로필은 작성 폼으로는 못 열고 마이페이지에서만 고친다(F-BM-004 D5 — 상태 비강등)", () => {
    expect(canEdit("approved")).toBe(false)
    expect(canSelfEditProfile("approved")).toBe(true)
  })
})
