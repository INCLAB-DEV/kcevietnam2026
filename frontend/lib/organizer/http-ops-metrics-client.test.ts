import { afterEach, describe, expect, it, vi } from "vitest"
import { OPERATOR_FORBIDDEN_DIGEST, OperatorHttpError } from "@/lib/auth/operator-errors"
import { fetchOpsMetricsInput } from "./http-ops-metrics-client"

// unwrap()의 401 처리(로그인 리다이렉트) 회귀 테스트 — organizer 세션 쿠키는 있으나 백엔드가 거부한
// 경우(예: DB 리셋으로 organizer 매핑 소실) getOpsDashboard가 raw Error를 던져 /organizer가 SSR
// 500("This page couldn't load")으로 떨어지던 버그를 고정한다. 401이 아닌 실패(진짜 서버 문제)는
// 기존처럼 Error로 전파돼야 한다. fetch stub 패턴은 lib/meeting/meeting-actions.test.ts와 동일.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchOpsMetricsInput — 백엔드 인증 실패 처리", () => {
  it("401이면 raw Error를 던지지 않고 /login으로 redirect한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "인증이 필요합니다" }), { status: 401 })),
    )

    await expect(fetchOpsMetricsInput("stale-token")).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;.*;\/login;/),
    })
  })

  it("401이 아닌 실패(예: 500)는 기존처럼 Error로 전파한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "internal" }), { status: 500 })),
    )

    await expect(fetchOpsMetricsInput("token")).rejects.toThrow(/organizer ops-metrics read failed/)
  })
})

// 2026-09-17 — sub 관할 스코프·권한 거절의 전달.
function routeFetch(opsBody: unknown, opsStatus = 200) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/api/admin/events")) {
      return new Response(JSON.stringify({ items: [{ id: "evt-1", timezone: "Asia/Seoul", slot_minutes: 30 }] }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify(opsBody), { status: opsStatus })
  })
}

const EMPTY_OPS = {
  roster: { exhibitor_registrants: 0, buyer_registrants: 0 },
  participants: [],
  meetings: [],
  reviews: [],
  schedule: { operating_start: "09:00", operating_end: "18:00", slot_minutes: 30, slot_gap_minutes: 0, event_days: 3 },
  saturation_runs: [],
}

describe("fetchOpsMetricsInput — 집계 모집단(scope)·권한 거절", () => {
  it("응답 scope를 그대로 전달한다(sub=jurisdiction)", async () => {
    vi.stubGlobal("fetch", routeFetch({ ...EMPTY_OPS, scope: "jurisdiction" }))
    await expect(fetchOpsMetricsInput("token")).resolves.toMatchObject({ scope: "jurisdiction" })
  })

  it("scope가 없는 구 응답은 행사 전역(event)으로 읽는다", async () => {
    vi.stubGlobal("fetch", routeFetch(EMPTY_OPS))
    await expect(fetchOpsMetricsInput("token")).resolves.toMatchObject({ scope: "event" })
  })

  it("403은 digest를 실은 OperatorHttpError — 콘솔 error.tsx가 권한 안내로 바꾼다", async () => {
    vi.stubGlobal("fetch", routeFetch({ detail: "이 행사의 운영자(master) 권한이 필요합니다." }, 403))
    const failure = fetchOpsMetricsInput("token")
    await expect(failure).rejects.toBeInstanceOf(OperatorHttpError)
    await expect(failure).rejects.toMatchObject({ status: 403, digest: OPERATOR_FORBIDDEN_DIGEST })
  })
})
