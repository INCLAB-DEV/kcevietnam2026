import { describe, it, expect } from "vitest"
import { canViewOrg, counterpartOrgs, counterpartRole, visibleOrgs } from "./visibility"
import type { Organization } from "@/lib/types"

const exhibitorA: Organization = { id: "e1", name: "한화시스템", role: "exhibitor", keywords: ["레이더"] }
const exhibitorB: Organization = { id: "e2", name: "LIG넥스원", role: "exhibitor", keywords: ["유도무기"] }
const buyerA: Organization = { id: "b1", name: "방위사업청", role: "buyer", keywords: ["레이더"] }
const buyerB: Organization = { id: "b2", name: "육군본부", role: "buyer", keywords: ["전차"] }
const orgs = [exhibitorA, exhibitorB, buyerA, buyerB]

describe("counterpartRole / counterpartOrgs — AI 추천(항상 완전 대칭)", () => {
  it("바이어의 상대는 참가사", () => {
    expect(counterpartRole("buyer")).toBe("exhibitor")
    expect(counterpartOrgs("buyer", orgs)).toEqual([exhibitorA, exhibitorB])
  })

  it("참가사의 상대는 바이어", () => {
    expect(counterpartRole("exhibitor")).toBe("buyer")
    expect(counterpartOrgs("exhibitor", orgs)).toEqual([buyerA, buyerB])
  })
})

describe("visibleOrgs — 기업 탐색 디렉터리 노출(베트남 전시 정책: 참가기업은 참가기업을 못 본다)", () => {
  it("기본값(allowSameRoleDiscovery 미지정)은 상대 역할만 — 바이어 뷰어", () => {
    expect(visibleOrgs("buyer", orgs)).toEqual([exhibitorA, exhibitorB])
  })

  it("기본값은 상대 역할만 — 참가사 뷰어도 대칭으로 바이어만(더 이상 참가사끼리 안 보인다)", () => {
    expect(visibleOrgs("exhibitor", orgs)).toEqual([buyerA, buyerB])
  })

  it("allowSameRoleDiscovery=false를 명시해도 동일(상대 역할만)", () => {
    expect(visibleOrgs("buyer", orgs, false)).toEqual([exhibitorA, exhibitorB])
    expect(visibleOrgs("exhibitor", orgs, false)).toEqual([buyerA, buyerB])
  })

  it("allowSameRoleDiscovery=true(다른 행사에서 어드민이 켠 경우)면 양쪽 역할 모두 노출", () => {
    expect(visibleOrgs("buyer", orgs, true)).toEqual(orgs)
    expect(visibleOrgs("exhibitor", orgs, true)).toEqual(orgs)
  })
})

describe("canViewOrg — 상세 페이지(DV-002) 접근 게이트", () => {
  it("기본값은 상대 역할 상세만 볼 수 있다", () => {
    expect(canViewOrg("buyer", exhibitorA)).toBe(true)
    expect(canViewOrg("buyer", buyerA)).toBe(false)
    expect(canViewOrg("exhibitor", buyerA)).toBe(true)
    expect(canViewOrg("exhibitor", exhibitorA)).toBe(false)
  })

  it("allowSameRoleDiscovery=true면 같은 역할 상세도 볼 수 있다", () => {
    expect(canViewOrg("exhibitor", exhibitorA, true)).toBe(true)
    expect(canViewOrg("buyer", buyerA, true)).toBe(true)
  })
})
