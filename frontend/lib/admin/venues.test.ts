import { describe, expect, it } from "vitest"
import { groupByVenueType, isManageableVenueType, validateVenue } from "./venues"
import type { AdminVenue } from "./types"

function venue(over: Partial<AdminVenue> & Pick<AdminVenue, "id" | "venue_type" | "label">): AdminVenue {
  return { event_id: "evt-test", meeting_count: 0, ...over }
}

describe("장소 유형 판정", () => {
  it("zone_table·business_room만 관리 대상이다", () => {
    expect(isManageableVenueType("zone_table")).toBe(true)
    expect(isManageableVenueType("business_room")).toBe(true)
  })

  it("booth는 관리 대상이 아니다(부스는 자동 생성)", () => {
    expect(isManageableVenueType("booth")).toBe(false)
  })

  it("모르는 값도 아니다", () => {
    expect(isManageableVenueType("garage")).toBe(false)
  })
})

describe("장소 입력 검증", () => {
  const existing: AdminVenue[] = [
    venue({ id: "v-1", venue_type: "zone_table", label: "T-01" }),
    venue({ id: "v-2", venue_type: "business_room", label: "Room A" }),
  ]

  it("유형·라벨이 갖춰지고 중복이 없으면 통과", () => {
    const result = validateVenue({ venue_type: "zone_table", label: "T-05" }, existing)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.venue_type).toBe("zone_table")
    expect(result.label).toBe("T-05")
  })

  it("라벨이 비면 막는다", () => {
    const result = validateVenue({ venue_type: "zone_table", label: "   " }, existing)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("label-required")
  })

  it("유효하지 않은 유형(booth 포함)은 막는다", () => {
    const result = validateVenue({ venue_type: "booth", label: "새 부스" }, existing)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("venue-type-invalid")
  })

  it("같은 유형 내 라벨 중복은 막는다", () => {
    const result = validateVenue({ venue_type: "zone_table", label: "T-01" }, existing)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("label-duplicate")
  })

  it("유형이 다르면 같은 라벨이어도 통과한다(백엔드 유니크 제약이 유형별이라)", () => {
    const result = validateVenue({ venue_type: "business_room", label: "T-01" }, existing)
    expect(result.valid).toBe(true)
  })

  it("수정 중인 자기 자신은 중복 검사에서 제외한다(excludeId)", () => {
    const result = validateVenue({ venue_type: "zone_table", label: "T-01" }, existing, "v-1")
    expect(result.valid).toBe(true)
  })

  it("앞뒤 공백은 정리한다", () => {
    const result = validateVenue({ venue_type: "zone_table", label: "  T-09  " }, existing)
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.label).toBe("T-09")
  })
})

describe("유형별 그룹핑", () => {
  it("zone_table·business_room으로 나누고 순서를 유지한다(라벨 순서 = 배정 순서)", () => {
    const rows: AdminVenue[] = [
      venue({ id: "v-1", venue_type: "zone_table", label: "T-01" }),
      venue({ id: "v-2", venue_type: "business_room", label: "Room A" }),
      venue({ id: "v-3", venue_type: "zone_table", label: "T-02" }),
    ]
    const grouped = groupByVenueType(rows)
    expect(grouped.zone_table.map((v) => v.label)).toEqual(["T-01", "T-02"])
    expect(grouped.business_room.map((v) => v.label)).toEqual(["Room A"])
  })

  it("빈 목록도 두 키를 빈 배열로 돌려준다", () => {
    expect(groupByVenueType([])).toEqual({ zone_table: [], business_room: [] })
  })
})
