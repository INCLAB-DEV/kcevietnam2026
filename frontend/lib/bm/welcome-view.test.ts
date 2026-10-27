import { describe, expect, it } from "vitest"
import { resolveWelcomeView, type WelcomeView } from "./welcome-view"
import type { ApplicationStatus } from "./types"

// 신청기간 3국면. open 불리언 하나로 before/closed를 못 가르던 게 approved 리다이렉트 루프의 원인이었다.
const OPEN = { open: true, closed: false } // 신청기간 중
const CLOSED = { open: false, closed: true } // 신청기간 종료
const BEFORE = { open: false, closed: false } // 신청기간 시작 전

// FE ADR-0002 매트릭스(5 status × 중/종료) + 시작 전 국면. 표가 곧 테스트 명세다.
const MATRIX: Array<[ApplicationStatus, { open: boolean; closed: boolean }, WelcomeView]> = [
  ["registered", OPEN, "write-form"],
  ["registered", CLOSED, "closed"],
  ["registered", BEFORE, "closed"],
  ["changes_requested", OPEN, "changes-requested"],
  ["changes_requested", CLOSED, "closed"],
  ["changes_requested", BEFORE, "closed"],
  ["submitted", OPEN, "under-review"],
  ["submitted", CLOSED, "under-review"],
  ["submitted", BEFORE, "under-review"],
  ["approved", OPEN, "enter-service"], // 승인=즉시 입장(2026-09-09 정책 변경). 기간 무관.
  ["approved", CLOSED, "enter-service"],
  ["approved", BEFORE, "enter-service"],
  ["rejected", OPEN, "rejected"],
  ["rejected", CLOSED, "rejected"],
  ["rejected", BEFORE, "rejected"],
]

describe("resolveWelcomeView", () => {
  it.each(MATRIX)("status=%s, period=%o → %s", (status, period, expected) => {
    expect(resolveWelcomeView(status, period)).toBe(expected)
  })

  it("승인자는 신청기간과 무관하게 즉시 입장(enter-service) — 2026-09-09 정책 변경", () => {
    expect(resolveWelcomeView("approved", CLOSED)).toBe("enter-service")
    expect(resolveWelcomeView("approved", OPEN)).toBe("enter-service")
    expect(resolveWelcomeView("approved", BEFORE)).toBe("enter-service")
  })

  it("submitted는 기간과 무관하게 검토 대기(제출 후 잠금, 읽기전용)", () => {
    expect(resolveWelcomeView("submitted", OPEN)).toBe("under-review")
    expect(resolveWelcomeView("submitted", CLOSED)).toBe("under-review")
  })
})
