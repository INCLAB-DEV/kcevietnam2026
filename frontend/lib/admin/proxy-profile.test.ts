import { describe, expect, it } from "vitest"
import {
  applyProxyWrite,
  canProxyWrite,
  statusAfterProxyWrite,
} from "./proxy-profile"
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"
import type { AdminOrganization } from "./types"

function org(status: ApplicationStatus): AdminOrganization {
  return {
    id: "adm-ex-999",
    event_id: "evt-test",
    role: "exhibitor",
    name_ko: "테스트기업",
    name_en: null,
    country: null,
    application_status: status,
    proxy_written: false,
    proxy_written_by: null,
    proxy_written_at: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    category: null,
    business_field_codes: [],
    content_category: null,
    booth_label: null,
    registered_by: null,
    meeting_count: 0,
    unavailable_slots: [],
    updated_at: "2026-08-01T09:00:00+09:00",
  }
}

const AT = "2026-08-28T10:00:00+09:00"

describe("대리작성 상태 규칙", () => {
  it("미신청(registered) 기업만 대리작성할 수 있다", () => {
    expect(canProxyWrite("registered")).toBe(true)
    for (const s of APPLICATION_STATUSES.filter((s) => s !== "registered")) {
      expect(canProxyWrite(s)).toBe(false)
    }
  })

  it("master 대리작성은 승인되어 즉시 매칭 대상이 된다", () => {
    const result = applyProxyWrite(org("registered"), "정세훈", AT, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.organization.application_status).toBe("approved")
    expect(statusAfterProxyWrite(true)).toBe("approved")
  })

  it("sub 대리작성은 master 승인 대기로 제출한다", () => {
    const result = applyProxyWrite(org("registered"), "박무역", AT, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.organization.application_status).toBe("submitted")
    expect(statusAfterProxyWrite(false)).toBe("submitted")
  })

  it("대리작성은 작성자·시각을 기록하고 proxy_written 플래그를 세운다", () => {
    const result = applyProxyWrite(org("registered"), "정세훈", AT, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.organization.proxy_written).toBe(true)
    expect(result.organization.proxy_written_by).toBe("정세훈")
    expect(result.organization.proxy_written_at).toBe(AT)
    expect(result.organization.updated_at).toBe(AT)
  })

  it("이미 제출한 기업은 대리작성이 거절된다 (심사 대기열 오염 방지)", () => {
    for (const s of ["submitted", "changes_requested", "approved", "rejected"] as const) {
      const result = applyProxyWrite(org(s), "정세훈", AT, true)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe("not-unsubmitted")
      expect(result.message).toContain("정정")
    }
  })

  it("대리작성 후에는 신청서 정정 경로를 사용한다", () => {
    const first = applyProxyWrite(org("registered"), "정세훈", AT, true)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyProxyWrite(first.organization, "박무역", "2026-08-29T10:00:00+09:00", true)
    expect(second.ok).toBe(false)
  })
})
