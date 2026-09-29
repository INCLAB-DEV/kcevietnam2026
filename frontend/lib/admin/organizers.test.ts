import { describe, expect, it } from "vitest"
import {
  canGrantLevel,
  canRevoke,
  GRANTABLE_LEVELS,
  grantServerErrorMessage,
  MASTER_GRANT_NOTICE,
  SUB_GRANT_CAPABILITY_NOTICE,
  sortOrganizers,
  validateOrganizerGrant,
} from "./organizers"
import { scopeToEvent } from "./organizations"
import { KADEX_EVENT_ID, MOCK_ORGANIZERS } from "./admin-mock"
import type { AdminOrganizer, AdminPermissionLevel } from "./types"

function organizer(
  id: string,
  level: AdminPermissionLevel,
  memberId = `mbr-${id}`,
  grantedAt = "2026-06-01T09:00:00+09:00",
): AdminOrganizer {
  return {
    id,
    event_id: "evt-test",
    member_id: memberId,
    name: `운영자 ${id}`,
    email: `${id}@example.com`,
    permission_level: level,
    trade_office: null,
    granted_at: grantedAt,
  }
}

describe("권한 부여 정책 — 슈퍼어드민은 DB에서만", () => {
  it("이 콘솔에서 부여 가능한 등급은 sub 하나뿐이다", () => {
    expect(GRANTABLE_LEVELS).toEqual(["sub"])
    expect(canGrantLevel("sub")).toBe(true)
    expect(canGrantLevel("master")).toBe(false)
  })

  it("master 부여 시도는 거절된다 (권한 상승 경로 차단)", () => {
    const result = validateOrganizerGrant("trade@kotra.or.kr", "master", [])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("level-not-grantable")
  })

  it("정책 문구가 요구된 문장을 담는다", () => {
    expect(MASTER_GRANT_NOTICE).toContain("데이터베이스에서 직접 부여")
    expect(MASTER_GRANT_NOTICE).toContain("서브어드민만 관리")
  })

  it("master는 회수도 못 한다 — 마지막 슈퍼어드민을 지워 잠기는 걸 막는다", () => {
    expect(canRevoke(organizer("a", "master"))).toBe(false)
    expect(canRevoke(organizer("b", "sub"))).toBe(true)
  })
})

// 부여 대상 = 가입 회원의 로그인 이메일(2026-09-17). 회원 존재 여부는 서버(404 MEMBER_NOT_FOUND)가 판정한다.
describe("서브어드민 부여 검증", () => {
  it("정상 이메일은 통과하고 공백을 다듬는다", () => {
    const result = validateOrganizerGrant("  trade@kotra.or.kr  ", "sub", [])
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.email).toBe("trade@kotra.or.kr")
  })

  it("이메일이 비면 막는다", () => {
    const result = validateOrganizerGrant("   ", "sub", [])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("email-required")
  })

  it("회원 UUID 같은 이메일 아닌 값은 막는다 — 예전 UUID 입력 방식으로 되돌아가지 않는다", () => {
    const result = validateOrganizerGrant("048a8903-a125-4e60-9682-cb6dd0cebb9d", "sub", [])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("email-invalid")
  })

  it("이미 이 행사 운영자인 회원(이메일, 대소문자 무시)은 중복 부여를 막는다", () => {
    const existing = [{ ...organizer("a", "sub"), email: "Trade@Kotra.or.kr" }]
    const result = validateOrganizerGrant("trade@kotra.or.kr", "sub", existing)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("duplicate-member")
  })

  it("master 계정과 같은 회원이면 역시 중복이다", () => {
    const existing = [{ ...organizer("a", "master"), email: "sean@example.com" }]
    const result = validateOrganizerGrant("sean@example.com", "sub", existing)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("duplicate-member")
  })
})

describe("서버 거절·성공 안내 문구", () => {
  it("없는 회원·중복 부여는 서버 코드별로 안내한다", () => {
    expect(grantServerErrorMessage("MEMBER_NOT_FOUND")).toContain("가입한 회원이 없습니다")
    expect(grantServerErrorMessage("ORGANIZER_ALREADY_ASSIGNED")).toContain("이미 이 행사의 운영자")
    expect(grantServerErrorMessage(undefined)).toContain("다시 시도")
  })

  it("성공 안내는 예전의 '조회만' 문구가 아니라 실제 서브어드민 권한을 말한다", () => {
    expect(SUB_GRANT_CAPABILITY_NOTICE).not.toContain("조회만")
    expect(SUB_GRANT_CAPABILITY_NOTICE).toContain("대리작성")
    expect(SUB_GRANT_CAPABILITY_NOTICE).toContain("운영자 관리는 할 수 없습니다")
  })
})

describe("정렬", () => {
  it("슈퍼어드민이 위, 그 다음 서브어드민을 부여 시각 순으로", () => {
    const rows = [
      organizer("c", "sub", "mbr-c", "2026-07-01T09:00:00+09:00"),
      organizer("b", "sub", "mbr-b", "2026-06-01T09:00:00+09:00"),
      organizer("a", "master", "mbr-a", "2026-08-01T09:00:00+09:00"),
    ]
    expect(sortOrganizers(rows).map((o) => o.id)).toEqual(["a", "b", "c"])
  })

  it("원본 배열을 변형하지 않는다", () => {
    const rows = [organizer("c", "sub"), organizer("a", "master")]
    sortOrganizers(rows)
    expect(rows.map((o) => o.id)).toEqual(["c", "a"])
  })
})

describe("행사 스코프 운영자 목업", () => {
  it("행사마다 운영자 목록이 갈린다", () => {
    const kadex = scopeToEvent(MOCK_ORGANIZERS, KADEX_EVENT_ID)
    expect(kadex.length).toBeGreaterThan(0)
    expect(kadex.every((o) => o.event_id === KADEX_EVENT_ID)).toBe(true)
  })

  it("각 행사에 참조용 master가 최소 1명 있다", () => {
    const kadex = scopeToEvent(MOCK_ORGANIZERS, KADEX_EVENT_ID)
    expect(kadex.some((o) => o.permission_level === "master")).toBe(true)
  })
})
