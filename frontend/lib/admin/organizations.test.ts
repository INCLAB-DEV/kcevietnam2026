import { describe, expect, it } from "vitest"
import {
  countUnsubmitted,
  EMPTY_ORG_FILTERS,
  filterOrganizations,
  scopeToEvent,
  sortOrganizations,
  switchOrgRole,
} from "./organizations"
import {
  KADEX_EVENT_ID,
  MOCK_MEETINGS,
  MOCK_ORGANIZATIONS,
  VIETNAM_EVENT_ID,
} from "./admin-mock"

const KADEX_ORGS = scopeToEvent(MOCK_ORGANIZATIONS, KADEX_EVENT_ID)

describe("행사 스코프", () => {
  it("선택된 행사의 행만 남긴다", () => {
    expect(KADEX_ORGS.length).toBeGreaterThan(0)
    expect(KADEX_ORGS.every((o) => o.event_id === KADEX_EVENT_ID)).toBe(true)
  })

  it("행사를 바꾸면 다른 집합이 나온다 — 스위처가 실제로 데이터를 가른다", () => {
    const vn = scopeToEvent(MOCK_ORGANIZATIONS, VIETNAM_EVENT_ID)
    expect(vn.length).toBeGreaterThan(0)
    expect(vn.map((o) => o.id)).not.toEqual(KADEX_ORGS.map((o) => o.id))
  })

  it("미팅에도 같은 스코프 규칙이 적용된다", () => {
    const vn = scopeToEvent(MOCK_MEETINGS, VIETNAM_EVENT_ID)
    expect(vn.every((m) => m.event_id === VIETNAM_EVENT_ID)).toBe(true)
  })
})

describe("기업 검색·필터", () => {
  it("기본 필터는 전부 통과시킨다", () => {
    expect(filterOrganizations(KADEX_ORGS, EMPTY_ORG_FILTERS)).toHaveLength(KADEX_ORGS.length)
  })

  it("국문·영문 기업명, 담당자, 이메일로 검색된다", () => {
    expect(filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, query: "한울" })).toHaveLength(1)
    expect(
      filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, query: "hanwool" }),
    ).toHaveLength(1)
    expect(filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, query: "서지훈" })).toHaveLength(1)
    expect(
      filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, query: "garuda-nd" }),
    ).toHaveLength(1)
  })

  it("역할 필터가 참가사/바이어를 가른다", () => {
    const ex = filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, roles: ["exhibitor"] })
    expect(ex.every((o) => o.role === "exhibitor")).toBe(true)
    const by = filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, roles: ["buyer"] })
    expect(by.every((o) => o.role === "buyer")).toBe(true)
    expect(ex.length + by.length).toBe(KADEX_ORGS.length)
  })

  it("상태 필터는 다중 선택이다", () => {
    const rows = filterOrganizations(KADEX_ORGS, {
      ...EMPTY_ORG_FILTERS,
      statuses: ["approved", "rejected"],
    })
    expect(rows.every((o) => ["approved", "rejected"].includes(o.application_status))).toBe(true)
  })

  it("대리작성분만 보기 — 아직 없으면 빈 결과", () => {
    expect(
      filterOrganizations(KADEX_ORGS, { ...EMPTY_ORG_FILTERS, proxyOnly: true }),
    ).toHaveLength(0)
    const withProxy = KADEX_ORGS.map((o, i) => (i === 0 ? { ...o, proxy_written: true } : o))
    expect(
      filterOrganizations(withProxy, { ...EMPTY_ORG_FILTERS, proxyOnly: true }),
    ).toHaveLength(1)
  })

  it("검색과 필터는 함께 걸린다(AND)", () => {
    expect(
      filterOrganizations(KADEX_ORGS, {
        ...EMPTY_ORG_FILTERS,
        query: "한울",
        roles: ["buyer"],
      }),
    ).toHaveLength(0)
  })

  it("카테고리와 여러 사업분야를 코드별로 교차 필터링한다", () => {
    const rows = [
      { ...KADEX_ORGS[0], id: "a", role: "exhibitor" as const,
        content_category: "broadcasting", business_field_codes: ["game_production", "content_production"] },
      { ...KADEX_ORGS[0], id: "b", role: "exhibitor" as const,
        content_category: "animation_character", business_field_codes: ["game_production"] },
      { ...KADEX_ORGS[0], id: "c", role: "buyer" as const,
        content_category: null, business_field_codes: ["content_production"] },
    ]
    const filtered = filterOrganizations(rows, {
      ...EMPTY_ORG_FILTERS,
      categories: ["content_production"],
      contentCategories: ["broadcasting"],
    })
    expect(filtered.map((row) => row.id)).toEqual(["a"])
    expect(filterOrganizations(rows, { ...EMPTY_ORG_FILTERS,
      categories: ["game_production", "content_production"] }).map((row) => row.id))
      .toEqual(["a", "b", "c"])
  })
})

describe("정렬", () => {
  it("기업명순은 가나다순", () => {
    const names = sortOrganizations(KADEX_ORGS, "name").map((o) => o.name_ko)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ko")))
  })

  it("상태순은 손댈 것(제출됨·보완요청)을 위로 올린다", () => {
    const first = sortOrganizations(KADEX_ORGS, "status")[0]
    expect(first.application_status).toBe("submitted")
  })

  it("미팅 건수순은 내림차순", () => {
    const counts = sortOrganizations(KADEX_ORGS, "meetings").map((o) => o.meeting_count)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  it("최근 수정순은 최신이 위", () => {
    const dates = sortOrganizations(KADEX_ORGS, "updated").map((o) => o.updated_at)
    expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)))
  })

  it("원본 배열을 변형하지 않는다", () => {
    const before = KADEX_ORGS.map((o) => o.id)
    sortOrganizations(KADEX_ORGS, "meetings")
    expect(KADEX_ORGS.map((o) => o.id)).toEqual(before)
  })
})

describe("미신청 집계", () => {
  it("registered 인 기업만 센다 — 대시보드 카드와 같은 정의", () => {
    expect(countUnsubmitted(KADEX_ORGS)).toBe(
      KADEX_ORGS.filter((o) => o.application_status === "registered").length,
    )
    expect(countUnsubmitted(KADEX_ORGS)).toBeGreaterThan(0)
  })
})

describe("역할 전환 (바이어 ↔ 참가사)", () => {
  const clean = KADEX_ORGS.find((o) => o.meeting_count === 0)!
  const busy = KADEX_ORGS.find((o) => o.meeting_count > 0)!

  it("미팅이 없으면 역할을 바꾼다", () => {
    const next = clean.role === "buyer" ? "exhibitor" : "buyer"
    const outcome = switchOrgRole(clean, next, "2026-08-28T10:00:00+09:00")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.organization.role).toBe(next)
    expect(outcome.organization.updated_at).toBe("2026-08-28T10:00:00+09:00")
    expect(clean.role).not.toBe(next) // 원본 불변
  })

  it("미팅이 잡힌 기업은 막고 정리 안내를 준다", () => {
    const next = busy.role === "buyer" ? "exhibitor" : "buyer"
    const outcome = switchOrgRole(busy, next, "2026-08-28T10:00:00+09:00")
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("has-meetings")
    expect(outcome.message).toContain("미팅 관리")
  })

  it("같은 역할로의 전환은 거절한다", () => {
    const outcome = switchOrgRole(clean, clean.role, "2026-08-28T10:00:00+09:00")
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("same-role")
  })
})

describe("회원가입 유입 커버리지", () => {
  it("신규 가입자(registered)는 '미신청' 집계·필터에 자연히 잡힌다", () => {
    // 회원가입으로 막 들어온 기업 — 명단 임포트분과 같은 상태값으로 유입된다.
    const signup = { ...KADEX_ORGS[0], id: "adm-new-signup", application_status: "registered" as const }
    const rows = [...KADEX_ORGS, signup]

    expect(countUnsubmitted(rows)).toBe(countUnsubmitted(KADEX_ORGS) + 1)
    const filtered = filterOrganizations(rows, { ...EMPTY_ORG_FILTERS, statuses: ["registered"] })
    expect(filtered.map((o) => o.id)).toContain("adm-new-signup")
  })
})
