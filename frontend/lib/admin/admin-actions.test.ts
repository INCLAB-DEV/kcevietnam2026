import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createEvent,
  createVenue,
  deleteVenue,
  grantSubAdmin,
  isAdminHttpMode,
  renameVenue,
  resendNotification,
} from "./admin-actions"

// 어드민 쓰기 시움의 실연동 스왑 검증 — 스위치에 따라 mock(네트워크 미사용)과
// 실 HTTP(같은 출처 BFF 프록시 호출)가 갈린다.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("실연동 모드 판정", () => {
  it("NEXT_PUBLIC_AUTH_CLIENT=http 일 때만 실연동이다", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    expect(isAdminHttpMode()).toBe(true)
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "")
    expect(isAdminHttpMode()).toBe(false)
  })
})

describe("mock 모드(스위치 꺼짐) — 요청을 보내지 않고 성공한다", () => {
  it("행사 생성이 네트워크 없이 성공한다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "")
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createEvent({
      name: "테스트 행사",
      venue_name: "",
      exhibition_start: "",
      exhibition_end: "",
      application_start: "",
      application_end: "",
      timezone: "Asia/Seoul",
    })

    expect(result).toEqual({ success: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("실연동 모드 — 같은 출처 BFF로 계약을 조립해 보낸다", () => {
  it("알림 재발송이 /api/admin 경로로 POST 된다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await resendNotification("evt-1", "log-9")

    expect(result).toEqual({ success: true })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/notifications/log-9/resend")
    expect(init?.method).toBe("POST")
  })

  it("백엔드 실패는 성공으로 속이지 않고 에러를 되돌린다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "이 행사의 운영자(master) 권한이 필요합니다." }), {
          status: 403,
        }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await resendNotification("evt-1", "log-9")

    expect(result.success).toBe(false)
    expect(result.error).toBe("이 행사의 운영자(master) 권한이 필요합니다.")
  })

  it("세션 없음(401)도 에러로 드러난다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ success: false, error: "no_session" }), { status: 401 }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await resendNotification("evt-1", "log-9")

    expect(result.success).toBe(false)
    expect(result.error).toBe("http_401")
  })
})

describe("미팅 장소 액션 — 경로·메서드 계약", () => {
  it("장소 추가가 POST .../venues로 간다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createVenue("evt-1", { venue_type: "zone_table", label: "T-05" })

    expect(result).toEqual({ success: true })
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/venues")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(init?.body as string)).toEqual({ venue_type: "zone_table", label: "T-05" })
  })

  it("이름 변경이 PATCH .../venues/{id}로 라벨만 보낸다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await renameVenue("evt-1", "vn-1", "T-09")

    expect(result).toEqual({ success: true })
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/venues/vn-1")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(init?.body as string)).toEqual({ label: "T-09" })
  })

  it("삭제가 DELETE .../venues/{id}로 간다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await deleteVenue("evt-1", "vn-1")

    expect(result).toEqual({ success: true })
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/venues/vn-1")
    expect(init?.method).toBe("DELETE")
  })
})

describe("미팅 장소 액션 — {code, message} 에러 바디를 code로 분기한다", () => {
  it("라벨 중복(409)은 문자열 메시지가 아니라 code를 에러로 돌려준다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: { code: "VENUE_LABEL_TAKEN", message: "이미 같은 이름의 장소가 있습니다: T-01" } }),
          { status: 409 },
        ),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createVenue("evt-1", { venue_type: "zone_table", label: "T-01" })

    expect(result.success).toBe(false)
    expect(result.error).toBe("VENUE_LABEL_TAKEN")
  })

  it("사용 중 삭제(409)도 code(VENUE_IN_USE)로 분기된다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: { code: "VENUE_IN_USE", message: "사용 중", meeting_count: 3 } }),
          { status: 409 },
        ),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await deleteVenue("evt-1", "vn-1")

    expect(result.success).toBe(false)
    expect(result.error).toBe("VENUE_IN_USE")
  })

  it("부스 대상 수정(422 VENUE_NOT_MANAGEABLE)도 code로 분기된다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: { code: "VENUE_NOT_MANAGEABLE", message: "부스는 수정할 수 없습니다" } }),
          { status: 422 },
        ),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await renameVenue("evt-1", "vn-booth", "새 이름")

    expect(result.success).toBe(false)
    expect(result.error).toBe("VENUE_NOT_MANAGEABLE")
  })

  it("code 없는 에러 바디는 기존처럼 http_상태코드로 접는다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ detail: [{ msg: "필드 오류" }] }), { status: 422 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createVenue("evt-1", { venue_type: "zone_table", label: "" })

    expect(result.success).toBe(false)
    expect(result.error).toBe("http_422")
  })
})

// 서브어드민 부여(2026-09-17) — 대상은 로그인 이메일, 화면은 서버가 돌려준 배정 행으로만 목록을 갱신한다.
describe("서브어드민 부여 — 이메일 계약·서버 응답 전달", () => {
  it("POST 본문은 {email, permission_level:'sub'}이고 성공 응답의 배정 행을 그대로 돌려준다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const created = {
      id: "eo-1",
      event_id: "evt-1",
      member_id: "m-1",
      name: "박무역",
      email: "trade@kotra.or.kr",
      permission_level: "sub",
      trade_office: null,
      granted_at: "2026-09-17T01:00:00Z",
    }
    const fetchSpy = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(created), { status: 201 }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const result = await grantSubAdmin("evt-1", "trade@kotra.or.kr")

    expect(result).toEqual({ success: true, organizer: created })
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/organizers")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ email: "trade@kotra.or.kr", permission_level: "sub" })
  })

  it("없는 회원(404 MEMBER_NOT_FOUND)은 행 없이 코드로 실패한다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: { code: "MEMBER_NOT_FOUND", message: "없음" } }), { status: 404 })),
    )

    const result = await grantSubAdmin("evt-1", "nobody@kotra.or.kr")

    expect(result).toEqual({ success: false, error: "MEMBER_NOT_FOUND" })
  })

  it("네트워크 오류도 던지지 않고 실패로 돌려준다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))

    const result = await grantSubAdmin("evt-1", "trade@kotra.or.kr")

    expect(result).toEqual({ success: false, error: "network" })
  })
})
