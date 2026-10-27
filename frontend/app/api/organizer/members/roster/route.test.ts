import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ token: "session-token" }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
  }),
}))
vi.mock("@/lib/organizer/backend-proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizer/backend-proxy")>()),
  BACKEND_URL: "http://backend.test",
}))

import { POST } from "./route"

const EVENTS = { items: [{ id: "event-first" }, { id: "event-selected" }] }

// jsdom의 File은 Node(undici) Request 직렬화와 호환되지 않아(파일명 "blob"·빈 본문) multipart 본문을 직접 만든다.
const BOUNDARY = "----nabi-roster-test"
function uploadRequest(fields: Record<string, string>, query = "") {
  const boundary = BOUNDARY
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="roster.csv"\r\nContent-Type: text/csv\r\n\r\nid,role,name_ko\r\nm-1,바이어,A\r\n`,
    ...Object.entries(fields).map(
      ([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ),
    `--${boundary}--\r\n`,
  ]
  return new Request(`http://localhost/api/organizer/members/roster${query}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: parts.join(""),
  })
}

function forwardedText(init: RequestInit): string {
  return new TextDecoder().decode(init.body as ArrayBuffer)
}

// 행사 목록(backendJson은 원본 모듈의 BACKEND_URL을 쓴다)과 적재 호출을 URL 끝으로 가른다.
function backend(importResponse: Response) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (String(url).endsWith("/api/admin/events")) return Response.json(EVENTS)
    return importResponse
  })
}

describe("명단 업로드 BFF — 두 콘솔 공용", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.token = "session-token"
  })

  it("파일·공통 비밀번호·미리보기 플래그를 선택 행사로 그대로 넘기고 결과를 감싼다", async () => {
    const result = { added: 1, updated: 0, unchanged: 0, skipped: 0, changes: [], rows: [] }
    const fetchMock = backend(Response.json(result))
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      uploadRequest(
        { password: "Nabi2026Roster", dry_run: "true", row_report: "true", default_role: "buyer" },
        "?event_id=event-selected",
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, result })
    const importCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/import/roster"))!
    expect(importCall[0]).toBe("http://backend.test/api/admin/import/roster?event_id=event-selected")
    const init = importCall[1] as unknown as RequestInit
    expect(init.method).toBe("POST")
    // boundary가 든 content-type과 원문 본문을 그대로 넘긴다(필드 해석은 FastAPI 한 곳).
    expect(init.headers).toEqual({
      authorization: "Bearer session-token",
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    })
    const text = forwardedText(init)
    expect(text).toContain('name="password"\r\n\r\nNabi2026Roster\r\n')
    expect(text).toContain('name="dry_run"\r\n\r\ntrue\r\n')
    expect(text).toContain('name="row_report"\r\n\r\ntrue\r\n')
    expect(text).toContain('name="default_role"\r\n\r\nbuyer\r\n')
    expect(text).toContain('name="file"; filename="roster.csv"')
    expect(text).toContain("m-1,바이어,A")
  })

  it("event_id가 없으면 운영자의 첫 행사로 올린다(운영자 콘솔)", async () => {
    const fetchMock = backend(Response.json({ added: 0, updated: 0, unchanged: 0, skipped: 0, changes: [] }))
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(uploadRequest({ dry_run: "false" }))

    expect(response.status).toBe(200)
    const importCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/import/roster"))!
    expect(importCall[0]).toBe("http://backend.test/api/admin/import/roster?event_id=event-first")
  })

  it("multipart가 아니면 적재 호출 없이 400", async () => {
    const fetchMock = backend(Response.json({}))
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      new Request("http://localhost/api/organizer/members/roster", { method: "POST", body: "{}" }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, error: "no_file" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("운영자 행사 목록에 없는 event_id는 적재 호출 없이 403", async () => {
    const fetchMock = backend(Response.json({}))
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(uploadRequest({}, "?event_id=attacker-event"))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ success: false, error: "unknown_event" })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/import/roster"))).toBe(false)
  })

  it("세션이 없으면 서버를 호출하지 않고 401(목업 가짜 성공 없음)", async () => {
    state.token = ""
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(uploadRequest({}))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ success: false, error: "no_session" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("백엔드 에러는 코드/문구를 그대로 보여 실패를 성공으로 숨기지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      backend(Response.json({ detail: { code: "PASSWORD_POLICY", message: "정책" } }, { status: 422 })),
    )
    const policy = await POST(uploadRequest({ password: "short" }))
    expect(policy.status).toBe(422)
    expect(await policy.json()).toEqual({ success: false, error: "PASSWORD_POLICY" })

    vi.stubGlobal(
      "fetch",
      backend(Response.json({ detail: "기업명 컬럼을 찾을 수 없습니다(org eager 생성 필수)." }, { status: 400 })),
    )
    const parse = await POST(uploadRequest({}))
    expect(parse.status).toBe(400)
    expect(await parse.json()).toEqual({
      success: false,
      error: "기업명 컬럼을 찾을 수 없습니다(org eager 생성 필수).",
    })
  })
})
