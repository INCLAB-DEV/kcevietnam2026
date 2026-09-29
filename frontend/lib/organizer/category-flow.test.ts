import { describe, expect, it } from "vitest"
import { toMemberRow } from "./http-members-client"
import { EMPTY_FILTERS, filterMembers } from "./members"

const record = {
  id: "category-fixture",
  name_ko: "합성 방송사",
  is_exhibitor: true,
  is_buyer: false,
  application_status: "registered" as const,
  content_category: "broadcasting",
  exhibition_categories: ["content_production", "animation_distribution"],
}

describe("실 API → 참가기업 카테고리·사업분야 필터", () => {
  it("서로 독립된 카테고리와 복수 사업분야를 보존한다", () => {
    expect(toMemberRow(record)).toMatchObject({
      contentCategory: "broadcasting",
      businessFields: ["content_production", "animation_distribution"],
    })
  })
  it("복수 사업분야 중 하나만 골라도 해당 기업을 찾는다", () => {
    expect(
      filterMembers([toMemberRow(record)], "exhibitor", {
        ...EMPTY_FILTERS,
        categories: ["content_production"],
      })
    ).toHaveLength(1)
  })
  it("다른 카테고리 선택 시 제외한다", () => {
    expect(
      filterMembers([toMemberRow(record)], "exhibitor", {
        ...EMPTY_FILTERS,
        contentCategories: ["animation_character"],
      })
    ).toHaveLength(0)
  })
})

it("같은 필터 내 OR, 필터 간 AND이며 바이어는 카테고리 조건을 무시한다", () => {
  const row = toMemberRow(record)
  expect(
    filterMembers([row], "exhibitor", {
      ...EMPTY_FILTERS,
      contentCategories: ["animation_character", "broadcasting"],
      categories: ["content_production", "game_production"],
    })
  ).toHaveLength(1)
  expect(
    filterMembers([row], "exhibitor", {
      ...EMPTY_FILTERS,
      categories: ["game_production"],
    })
  ).toHaveLength(0)
  expect(
    filterMembers([{ ...row, tab: "buyer" }], "buyer", {
      ...EMPTY_FILTERS,
      contentCategories: ["animation_character"],
    })
  ).toHaveLength(1)
})
