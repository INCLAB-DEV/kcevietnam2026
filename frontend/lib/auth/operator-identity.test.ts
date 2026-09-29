import { describe, expect, it } from "vitest"
import {
  OPERATOR_FALLBACK_NAME,
  operatorPermissionLevel,
  operatorSidebarUser,
  type OperatorMe,
} from "./operator-identity"

const me = (over: Partial<OperatorMe> = {}): OperatorMe => ({
  member_id: "mbr-1",
  organizer_id: "org-1",
  name: "Sean (슈퍼관리자)",
  email: "sean111400@naver.com",
  phone: "010-1111-2222",
  affiliation: "마인즈그라운드 운영팀",
  events: [{ event_id: "evt-a", permission_level: "master" }],
  ...over,
})

describe("operatorSidebarUser — 실 운영자 신원", () => {
  it("백엔드가 준 값을 그대로 그린다", () => {
    expect(operatorSidebarUser(me())).toEqual({
      name: "Sean (슈퍼관리자)",
      affiliation: "마인즈그라운드 운영팀",
      email: "sean111400@naver.com",
      phone: "010-1111-2222",
    })
  })

  it("조회 실패(null)면 전 필드를 비운다 — 목업 인물로 대체하지 않는다", () => {
    expect(operatorSidebarUser(null)).toEqual({
      name: null,
      affiliation: null,
      email: null,
      phone: null,
    })
  })

  it("일부 필드만 없으면 그 필드만 비운다", () => {
    const user = operatorSidebarUser(me({ phone: null, affiliation: null }))
    expect(user.phone).toBeNull()
    expect(user.affiliation).toBeNull()
    expect(user.name).toBe("Sean (슈퍼관리자)")
  })
})

describe("operatorPermissionLevel — 등급은 계정×행사(ADR-0012)", () => {
  const multi = me({
    events: [
      { event_id: "evt-a", permission_level: "master" },
      { event_id: "evt-b", permission_level: "sub" },
    ],
  })

  it("행사별로 다른 등급을 고른다", () => {
    expect(operatorPermissionLevel(multi, "evt-a")).toBe("master")
    expect(operatorPermissionLevel(multi, "evt-b")).toBe("sub")
  })

  it("행사를 지정하지 않으면 배정된 첫 행사의 등급(구 organizer 콘솔의 단일 행사 전제)", () => {
    expect(operatorPermissionLevel(multi)).toBe("master")
  })

  it("배정 없는 행사·조회 실패·빈 배정은 undefined — 등급을 지어내지 않는다", () => {
    expect(operatorPermissionLevel(multi, "evt-zzz")).toBeUndefined()
    expect(operatorPermissionLevel(null, "evt-a")).toBeUndefined()
    expect(operatorPermissionLevel(me({ events: [] }))).toBeUndefined()
  })

  it("계약 밖 등급 문자열은 undefined로 접는다(권한 상승 방지)", () => {
    const weird = me({ events: [{ event_id: "evt-a", permission_level: "owner" }] })
    expect(operatorPermissionLevel(weird, "evt-a")).toBeUndefined()
  })
})

describe("OPERATOR_FALLBACK_NAME", () => {
  it("사람 이름이 아니라 역할명이다 — 가짜 신원을 그리지 않기 위한 자리표시", () => {
    expect(OPERATOR_FALLBACK_NAME).toBe("운영자")
  })
})
