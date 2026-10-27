import { describe, it, expect } from "vitest"
import { toMembersCsv, toMembersXls, formatActivity, EXPORT_HEADERS } from "./members-export"
import type { MemberRow } from "./members"

const rows: MemberRow[] = [
  {
    id: "e1",
    name: "드림포지 게임즈",
    nameEn: "Dreamforge Games",
    tab: "exhibitor",
    applicationStatus: "approved",
    primaryContact: "김민수 부장",
    contactPhone: "010-1234-5678",
    contactEmail: "ms.kim@dreamforge-games.example",
    productCategory: "게임 제작",
    importedAt: "2026-06-01T09:00:00+09:00",
    profileCompletion: 100,
    matchCount: 7,
    lastActivityAt: "2026-06-20T09:12:00+09:00",
    boothLabel: "제1전시관 A-12",
  },
  {
    id: "e2",
    name: "코리아, 콘텐츠", // 쉼표 포함 → CSV 따옴표 처리 검증
    nameEn: "Korea, Contents",
    tab: "exhibitor",
    applicationStatus: "registered",
    primaryContact: null,
    contactPhone: null,
    contactEmail: null,
    productCategory: null,
    importedAt: "2026-06-08T09:00:00+09:00",
    profileCompletion: 0,
    matchCount: 0,
    lastActivityAt: null,
  },
]

describe("formatActivity", () => {
  it("ISO에서 날짜만 떼고, 없으면 -", () => {
    expect(formatActivity("2026-06-20T09:12:00+09:00")).toBe("2026-06-20")
    expect(formatActivity(null)).toBe("-")
  })
})

describe("toMembersCsv", () => {
  const csv = toMembersCsv(rows)
  const lines = csv.replace(/^﻿/, "").split("\r\n")

  it("BOM으로 시작한다(Excel 한글)", () => {
    expect(csv.startsWith("﻿")).toBe(true)
  })
  it("헤더 + 받은 행 수만큼 직렬화한다(현재 필터 결과 반영)", () => {
    expect(lines[0]).toBe(EXPORT_HEADERS.join(","))
    expect(lines).toHaveLength(rows.length + 1)
  })
  it("A층 값(구분·운영자 상태라벨·담당자·전시품목·적재일)을 라벨로 푼다", () => {
    expect(lines[1]).toContain("참가사")
    expect(lines[1]).toContain("승인됨") // approved → 운영자 라벨
    expect(lines[1]).toContain("김민수 부장")
    expect(lines[1]).toContain("게임 제작")
    expect(lines[1]).toContain("2026-06-01")
  })
  it("미신청·쉼표 포함 값은 따옴표로 감싼다", () => {
    expect(lines[2]).toContain('"코리아, 콘텐츠"')
    expect(lines[2]).toContain("미신청") // registered → 운영자 라벨
  })
})

describe("toMembersXls", () => {
  it("받은 행만큼 <tr>을 만든다(헤더 1 + 데이터 N)", () => {
    const xls = toMembersXls(rows)
    const trCount = (xls.match(/<tr>/g) ?? []).length
    expect(trCount).toBe(rows.length + 1)
    expect(xls).toContain("<th>기업명(국문)</th>")
    expect(xls).toContain("드림포지 게임즈")
  })
})
