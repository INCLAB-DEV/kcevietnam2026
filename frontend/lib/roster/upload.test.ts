import { afterEach, describe, expect, it, vi } from "vitest"
import { uploadRoster } from "./upload"

const file = new File(["id,role,name_ko\r\nm-1,바이어,A"], "roster.csv", { type: "text/csv" })
const report = { added: 1, updated: 0, unchanged: 0, skipped: 0, changes: [], rows: [] }

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, body: init.body as FormData, method: init.method }
}

describe("uploadRoster — 두 콘솔 공용 업로드 클라이언트", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("선택 행사·공통 비밀번호·미리보기 플래그를 하나의 BFF로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: report }))
    vi.stubGlobal("fetch", fetchMock)

    const outcome = await uploadRoster({
      file,
      eventId: "event 1",
      password: "Nabi2026Roster",
      defaultRole: "exhibitor",
      dryRun: true,
    })

    expect(outcome).toEqual({ success: true, report })
    const call = lastCall(fetchMock)
    expect(call.url).toBe("/api/organizer/members/roster?event_id=event%201")
    expect(call.method).toBe("POST")
    expect(call.body.get("password")).toBe("Nabi2026Roster")
    expect(call.body.get("dry_run")).toBe("true")
    expect(call.body.get("row_report")).toBe("true")
    expect(call.body.get("default_role")).toBe("exhibitor")
  })

  it("비밀번호가 비면 password 필드를 싣지 않고, 행사가 없으면 쿼리도 없다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: report }))
    vi.stubGlobal("fetch", fetchMock)

    await uploadRoster({ file, password: "", dryRun: false })

    const call = lastCall(fetchMock)
    expect(call.url).toBe("/api/organizer/members/roster")
    expect(call.body.has("password")).toBe(false)
    expect(call.body.has("default_role")).toBe(false)
    expect(call.body.get("dry_run")).toBe("false")
  })

  it("서버 거부·네트워크 오류를 성공으로 바꾸지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ success: false, error: "PASSWORD_POLICY" }, { status: 422 }))
    )
    expect(await uploadRoster({ file, password: "short", dryRun: true })).toEqual({
      success: false,
      error: "PASSWORD_POLICY",
      status: 422,
    })

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    expect(await uploadRoster({ file, dryRun: true })).toEqual({ success: false, error: "network" })
  })
})
