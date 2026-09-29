import { BUSINESS_FIELD_LABELS } from "@/lib/bm/fields"
import { describe, it, expect } from "vitest"
import {
  categoryOptions,
  filterMembers,
  isParticipant,
  sortMembers,
  pageCount,
  paginate,
  pageItems,
  EMPTY_FILTERS,
  type MemberRow,
} from "./members"

function row(over: Partial<MemberRow>): MemberRow {
  return {
    id: "x",
    name: "테스트",
    nameEn: "Test",
    tab: "exhibitor",
    applicationStatus: "submitted",
    primaryContact: "홍길동",
    contactPhone: null,
    contactEmail: null,
    productCategory: "콘텐츠 제작",
    importedAt: "2026-06-10T09:00:00+09:00",
    profileCompletion: 100,
    matchCount: 0,
    lastActivityAt: null,
    ...over,
  }
}

// 상태·매칭을 일부러 어긋나게 둬 상태순 정렬과 매칭순 정렬이 서로 다른 순서를 내게 한다.
const rows: MemberRow[] = [
  row({ id: "e1", name: "스타라이트 게임즈", nameEn: "Starlight Games", applicationStatus: "approved", productCategory: "게임 제작", matchCount: 2 }),
  row({ id: "e2", name: "넥서스웹툰", nameEn: "Nexus Webtoon", applicationStatus: "submitted", productCategory: "만화웹툰 제작", matchCount: 9 }),
  row({ id: "e3", name: "한빛게임즈", nameEn: "Hanbit Games", applicationStatus: "registered", productCategory: "게임 제작", matchCount: 0 }),
  row({ id: "b1", name: "케이콘텐츠진흥청", nameEn: "KCPA", tab: "buyer", applicationStatus: "approved", productCategory: "신기술융합콘텐츠", matchCount: 5 }),
]

describe("isParticipant — 미신청/승인대기 vs 승인됨(approved)", () => {
  it("approved만 비즈매칭 참가자다(매칭 노출 기준)", () => {
    expect(isParticipant(row({ applicationStatus: "approved" }))).toBe(true)
    expect(isParticipant(row({ applicationStatus: "submitted" }))).toBe(false)
    expect(isParticipant(row({ applicationStatus: "registered" }))).toBe(false)
    expect(isParticipant(row({ applicationStatus: "rejected" }))).toBe(false)
  })
})

describe("filterMembers — 탭 분리", () => {
  it("참가사 탭은 exhibitor만 남긴다", () => {
    expect(filterMembers(rows, "exhibitor", EMPTY_FILTERS).map((r) => r.id)).toEqual(["e1", "e2", "e3"])
  })
  it("바이어 탭은 buyer만 남긴다", () => {
    expect(filterMembers(rows, "buyer", EMPTY_FILTERS).map((r) => r.id)).toEqual(["b1"])
  })
})

describe("filterMembers — 검색(국/영 기업명)", () => {
  it("국문 기업명으로 검색한다", () => {
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, query: "스타라이트" }).map((r) => r.id)).toEqual(["e1"])
  })
  it("영문 기업명으로도 검색한다", () => {
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, query: "nex" }).map((r) => r.id)).toEqual(["e2"])
  })
})

describe("filterMembers — 패싯", () => {
  it("승인 상태 다중선택으로 거른다", () => {
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, statuses: ["registered"] }).map((r) => r.id)).toEqual(["e3"])
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, statuses: ["approved", "submitted"] }).map((r) => r.id)).toEqual(["e1", "e2"])
  })
  it("전시품목 카테고리로 거른다", () => {
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, categories: ["게임 제작"] }).map((r) => r.id)).toEqual(["e1", "e3"])
  })
  it("매칭 보유 필터는 matchCount>0만 남긴다", () => {
    expect(filterMembers(rows, "exhibitor", { ...EMPTY_FILTERS, hasMatchesOnly: true }).map((r) => r.id)).toEqual(["e1", "e2"])
  })
})

describe("categoryOptions", () => {
  it("데이터 유무와 무관하게 정규 8종을 반환한다", () => {
    expect(categoryOptions()).toEqual(Object.values(BUSINESS_FIELD_LABELS))
  })
})

describe("sortMembers", () => {
  const subset = filterMembers(rows, "exhibitor", EMPTY_FILTERS)
  it("기업명순(가나다)", () => {
    expect(sortMembers(subset, "name").map((r) => r.name)).toEqual(["넥서스웹툰", "스타라이트 게임즈", "한빛게임즈"])
  })
  it("매칭 건수순(내림차순)", () => {
    expect(sortMembers(subset, "matches").map((r) => r.id)).toEqual(["e2", "e1", "e3"])
  })
  it("승인 상태순(approved → submitted → registered)", () => {
    expect(sortMembers(subset, "status").map((r) => r.id)).toEqual(["e1", "e2", "e3"])
  })
  it("원본 배열을 변형하지 않는다", () => {
    const before = subset.map((r) => r.id)
    sortMembers(subset, "name")
    expect(subset.map((r) => r.id)).toEqual(before)
  })
})

describe("pagination", () => {
  const nums = Array.from({ length: 23 }, (_, i) => i + 1)

  it("pageCount는 올림, 빈 목록도 최소 1페이지", () => {
    expect(pageCount(0, 10)).toBe(1)
    expect(pageCount(10, 10)).toBe(1)
    expect(pageCount(23, 10)).toBe(3)
  })

  it("paginate는 1-base 페이지 구간을 자른다", () => {
    expect(paginate(nums, 1, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(paginate(nums, 3, 10)).toEqual([21, 22, 23])
  })

  it("pageItems: 7페이지 이하는 전부 노출", () => {
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it("pageItems: 많으면 1·현재±1·끝 + 생략", () => {
    expect(pageItems(5, 10)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10])
    expect(pageItems(1, 10)).toEqual([1, 2, "ellipsis", 10])
    expect(pageItems(10, 10)).toEqual([1, "ellipsis", 9, 10])
  })
})
