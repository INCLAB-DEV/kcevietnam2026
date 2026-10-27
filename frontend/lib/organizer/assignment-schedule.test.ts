import { describe, expect, it } from "vitest"
import { oppositeCandidates } from "./assignment-schedule"
import type { Organization } from "@/lib/types"

// #6 회귀 테스트 — 운영자 강제 배정에서 상대 후보가 항상 0명이던 결함의 비-AI 폴백.
// AI 매칭 추천(recsByOrgId)이 실 세션에서 항상 비어 있던 게 원인이라, 후보 출처를
// "반대편 기업 전체 목록"(이름순)으로 바꿨다 — 점수는 지어내지 않는다(aiScore: null).

function org(id: string, role: "exhibitor" | "buyer", name: string): Organization {
  return { id, role, name, keywords: [] }
}

describe("oppositeCandidates", () => {
  const exhibitors = [org("ex-1", "exhibitor", "나 참가사"), org("ex-2", "exhibitor", "가 참가사")]
  const buyers = [org("by-1", "buyer", "다 바이어"), org("by-2", "buyer", "나 바이어")]
  const data = { exhibitors, buyers }

  it("참가사 기준으로는 바이어 전체를 후보로 낸다(이름 가나다순)", () => {
    const result = oppositeCandidates(data, "exhibitor")
    expect(result.map((r) => r.org.id)).toEqual(["by-2", "by-1"]) // "나 바이어" < "다 바이어"
  })

  it("바이어 기준으로는 참가사 전체를 후보로 낸다(이름 가나다순)", () => {
    const result = oppositeCandidates(data, "buyer")
    expect(result.map((r) => r.org.id)).toEqual(["ex-2", "ex-1"]) // "가 참가사" < "나 참가사"
  })

  it("점수를 지어내지 않는다 — aiScore는 항상 null", () => {
    const result = oppositeCandidates(data, "exhibitor")
    expect(result.every((r) => r.aiScore === null)).toBe(true)
  })

  it("반대편 목록이 비어 있으면 빈 배열을 낸다", () => {
    expect(oppositeCandidates({ exhibitors: [], buyers }, "buyer")).toEqual([])
  })
})
