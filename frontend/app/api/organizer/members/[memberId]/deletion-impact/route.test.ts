// 참가기업 삭제 영향 미리보기 BFF — 삭제(DELETE)와 같은 행사 스코프 경로로 읽어, 화면 모양으로 옮긴다.
//
// 판정(삭제 가능 여부)은 FastAPI가 한다 — 여기서 고정하는 건 "경로를 맞게 만들고, 거부·실패를 성공으로
// 덮지 않고, 모양이 어긋난 응답을 '함께 지워지는 것 없음'으로 바꾸지 않는다"다.
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  token: "session-token" as string | null,
  permissionLevel: "master" as "master" | "sub",
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/mock/session-server", () => ({
  resolveRequestGuard: async () => ({ authenticated: true }),
  resolveRequestSession: async () => ({ role: "organizer", permissionLevel: state.permissionLevel }),
}))
import { GET } from "./route"

const EVENTS = { items: [{ id: "event-first" }] }

const BACKEND_IMPACT = {
  organization_id: "org-1",
  deletable: true,
  scheduled_count: 0,
  completed_count: 0,
  closed_meeting_count: 2,
  review_count: 1,
  transcription_job_count: 0,
  notification_count: 3,
  draft_item_count: 1,
  linked_record_count: 2,
  member_count: 1,
  organization_deleted: true,
  other_event_count: 0,
}

function backend(impactResponse: Response) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/api/admin/events")) return Response.json(EVENTS)
    return impactResponse
  })
}

const request = () => new Request("http://localhost/api/organizer/members/org-1/deletion-impact")
const params = Promise.resolve({ memberId: "org-1" })

describe("참가기업 삭제 영향 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
    state.permissionLevel = "master"
  })

  it("행사 스코프 경로로 읽어 화면 모양(camelCase)으로 돌려준다", async () => {
    const fetchMock = backend(Response.json(BACKEND_IMPACT))
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(request(), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      id: "org-1",
      impact: {
        deletable: true,
        scheduledCount: 0,
        completedCount: 0,
        closedMeetingCount: 2,
        reviewCount: 1,
        transcriptionJobCount: 0,
        notificationCount: 3,
        draftItemCount: 1,
        linkedRecordCount: 2,
        memberCount: 1,
        organizationDeleted: true,
      },
    })
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/deletion-impact"))!
    // 삭제(DELETE .../organizations/org-1)와 같은 행사·같은 기업 — 뒤에 /deletion-impact만 붙는다.
    expect(String(call[0])).toMatch(
      /\/api\/admin\/events\/event-first\/organizations\/org-1\/deletion-impact$/,
    )
    expect((call[1] as RequestInit).method).toBe("GET")
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer session-token" })
  })

  it("막힌 판정도 그대로 옮긴다(예정·완료 건수)", async () => {
    vi.stubGlobal(
      "fetch",
      backend(
        Response.json({ ...BACKEND_IMPACT, deletable: false, scheduled_count: 2, completed_count: 1 }),
      ),
    )

    const body = await (await GET(request(), { params })).json()

    expect(body.impact).toMatchObject({ deletable: false, scheduledCount: 2, completedCount: 1 })
  })

  it("권한 없음(403)은 상태 그대로, 구조화된 '기업 없음' 404는 ORG_NOT_FOUND로 올린다 — 성공으로 덮지 않는다", async () => {
    vi.stubGlobal("fetch", backend(Response.json({ detail: "master 권한이 필요합니다" }, { status: 403 })))
    const forbidden = await GET(request(), { params })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ success: false, error: "master 권한이 필요합니다" })

    vi.stubGlobal(
      "fetch",
      backend(
        Response.json(
          { detail: { code: "ORG_NOT_FOUND", message: "기업을 찾을 수 없습니다" } },
          { status: 404 },
        ),
      ),
    )
    const missing = await GET(request(), { params })
    expect(missing.status).toBe(404)
    // 화면은 이 코드로 일반 실패와 가른다("이 행사 명단에서 찾을 수 없는 기업" — 명단을 다시 읽는다).
    expect(await missing.json()).toEqual({ success: false, error: "ORG_NOT_FOUND" })
  })

  // 라우팅·배포가 어긋난 FastAPI 404("Not Found"), 구조화되지 않은 예전 문장, 코드처럼 생긴 평문까지 —
  // "기업 없음"이 아니라 일반 실패 http_404다(화면은 "확인하지 못했어요" + 다시 확인).
  it.each(["Not Found", "기업을 찾을 수 없습니다", "ORG_NOT_FOUND"])(
    "평문 detail의 404(%s)는 일반 실패 http_404다",
    async (detail) => {
      vi.stubGlobal("fetch", backend(Response.json({ detail }, { status: 404 })))

      const response = await GET(request(), { params })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ success: false, error: "http_404" })
    },
  )

  // linked_record_count가 없는 응답(이 칸을 모르는 예전 백엔드)도 "연결 기록 없음"으로 보이면 안 된다.
  it.each(["closed_meeting_count", "linked_record_count"])(
    "백엔드 응답에 %s가 빠지면 502 — 빠진 칸을 0으로 채워 내려주지 않는다",
    async (field) => {
      const partial: Record<string, unknown> = { ...BACKEND_IMPACT }
      delete partial[field]
      vi.stubGlobal("fetch", backend(Response.json(partial)))

      const response = await GET(request(), { params })

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ success: false, error: "invalid_upstream" })
    },
  )

  it("운영자가 배정된 행사가 없으면 백엔드 미리보기까지 가지 않는다", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ items: [] }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(request(), { params })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ success: false, error: "no_event" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("목업 모드(세션 쿠키 없음) — master에게는 '그냥 삭제'로 답하고 백엔드를 부르지 않는다", async () => {
    state.token = null
    const fetchMock = backend(Response.json(BACKEND_IMPACT))
    vi.stubGlobal("fetch", fetchMock)

    const response = await GET(request(), { params })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.impact).toMatchObject({ deletable: true, closedMeetingCount: 0, scheduledCount: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("목업 모드의 sub는 403 — 삭제가 master 전용이라 미리보기도 그렇다", async () => {
    state.token = null
    state.permissionLevel = "sub"
    vi.stubGlobal("fetch", backend(Response.json(BACKEND_IMPACT)))

    const response = await GET(request(), { params })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ success: false, error: "forbidden_sub" })
  })
})
