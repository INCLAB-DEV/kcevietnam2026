// 참가기업 삭제 BFF — 백엔드 거부를 상태·코드 그대로 올리고 **이유(건수·문장)도 함께** 싣는다.
//
// 화면은 서버가 삭제를 확인한 뒤에만 행을 지운다. 거부됐을 때 "미팅이 있어요" 한마디가 아니라 몇 건이
// 왜 막는지 말하려면 이 라우트가 백엔드 detail의 건수를 버리지 않아야 한다.
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
import { DELETE } from "./route"

const EVENTS = { items: [{ id: "event-first" }] }

function backend(deleteResponse: () => Response) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/api/admin/events")) return Response.json(EVENTS)
    return deleteResponse()
  })
}

const request = () =>
  new Request("http://localhost/api/organizer/members/org-1", { method: "DELETE" })
const params = Promise.resolve({ memberId: "org-1" })

describe("참가기업 삭제 BFF", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
    state.permissionLevel = "master"
  })

  it("행사 스코프 경로로 DELETE를 보내고, 백엔드가 지웠으면(204) 성공을 알린다", async () => {
    const fetchMock = backend(() => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const response = await DELETE(request(), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, id: "org-1" })
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!
    expect(String(call[0])).toMatch(/\/api\/admin\/events\/event-first\/organizations\/org-1$/)
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer session-token" })
  })

  it("미팅 때문에 거부되면(409 ORG_HAS_MEETINGS) 상태별 건수와 문장을 함께 올린다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() =>
        Response.json(
          {
            detail: {
              code: "ORG_HAS_MEETINGS",
              message: "예정된 미팅 2건과 완료된 미팅 1건이 있어 삭제할 수 없습니다",
              meeting_count: 3,
              scheduled_count: 2,
              completed_count: 1,
            },
          },
          { status: 409 },
        ),
      ),
    )

    const response = await DELETE(request(), { params })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "ORG_HAS_MEETINGS",
      message: "예정된 미팅 2건과 완료된 미팅 1건이 있어 삭제할 수 없습니다",
      scheduledCount: 2,
      completedCount: 1,
    })
  })

  it("DB가 막은 경우(409 ORG_DELETE_CONFLICT)도 코드와 문장을 그대로 올린다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() =>
        Response.json(
          { detail: { code: "ORG_DELETE_CONFLICT", message: "아무것도 삭제되지 않았습니다" } },
          { status: 409 },
        ),
      ),
    )

    const response = await DELETE(request(), { params })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: "ORG_DELETE_CONFLICT",
      message: "아무것도 삭제되지 않았습니다",
    })
  })

  it("문자열 detail(403 권한 없음)·본문 없는 실패(500)는 상태 그대로 올린다 — 성공으로 덮지 않는다", async () => {
    vi.stubGlobal("fetch", backend(() => Response.json({ detail: "master 권한이 필요합니다" }, { status: 403 })))
    const forbidden = await DELETE(request(), { params })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ success: false, error: "master 권한이 필요합니다" })

    vi.stubGlobal("fetch", backend(() => new Response("upstream down", { status: 500 })))
    const broken = await DELETE(request(), { params })
    expect(broken.status).toBe(500)
    expect(await broken.json()).toEqual({ success: false, error: "http_500" })
  })

  it("백엔드가 구조화된 코드로 '기업 없음'이라 한 404만 ORG_NOT_FOUND로 올린다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(() =>
        Response.json(
          { detail: { code: "ORG_NOT_FOUND", message: "기업을 찾을 수 없습니다" } },
          { status: 404 },
        ),
      ),
    )

    const response = await DELETE(request(), { params })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      success: false,
      error: "ORG_NOT_FOUND",
      message: "기업을 찾을 수 없습니다",
    })
  })

  // 라우팅·배포가 어긋난 FastAPI 404("Not Found"), 구조화되지 않은 예전 문장, 코드처럼 생긴 평문까지 —
  // 화면이 "기업 없음"으로 보고 명단을 다시 읽지 않게 일반 실패(http_404)로 넘긴다. 문장은 message로만 싣는다.
  it.each(["Not Found", "기업을 찾을 수 없습니다", "ORG_NOT_FOUND"])(
    "평문 detail의 404(%s)는 일반 실패 http_404다",
    async (detail) => {
      vi.stubGlobal("fetch", backend(() => Response.json({ detail }, { status: 404 })))

      const response = await DELETE(request(), { params })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ success: false, error: "http_404", message: detail })
    },
  )

  it("바디 없는 404·다른 코드의 404도 'ORG_NOT_FOUND'가 아니다", async () => {
    vi.stubGlobal("fetch", backend(() => new Response(null, { status: 404 })))
    const empty = await DELETE(request(), { params })
    expect(empty.status).toBe(404)
    expect(await empty.json()).toEqual({ success: false, error: "http_404" })

    vi.stubGlobal(
      "fetch",
      backend(() => Response.json({ detail: { code: "EVENT_GONE", message: "x" } }, { status: 404 })),
    )
    const otherCode = await DELETE(request(), { params })
    expect(otherCode.status).toBe(404)
    expect(await otherCode.json()).toEqual({ success: false, error: "EVENT_GONE", message: "x" })
  })

  it("운영자가 배정된 행사가 없으면(no_event) 삭제를 보내지 않고, '이미 없음'과 섞지 않는다", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ items: [] }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await DELETE(request(), { params })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ success: false, error: "no_event" })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
  })

  it("목업 모드(세션 쿠키 없음) — master는 성공, sub는 403. 백엔드는 부르지 않는다", async () => {
    state.token = null
    const fetchMock = backend(() => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const asMaster = await DELETE(request(), { params })
    expect(asMaster.status).toBe(200)
    expect(await asMaster.json()).toEqual({ success: true, id: "org-1" })

    state.permissionLevel = "sub"
    const asSub = await DELETE(request(), { params })
    expect(asSub.status).toBe(403)
    expect(await asSub.json()).toEqual({ success: false, error: "forbidden_sub" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
