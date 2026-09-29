import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RosterImportReport } from "@/lib/roster/types"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}))
const download = vi.fn()
vi.mock("@/components/admin/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/admin/shared")>()),
  download: (...args: unknown[]) => download(...args),
}))

import { MAX_VISIBLE_ROWS, RosterUploadButton, RosterUploadDialog } from "./roster-upload"

const PASSWORD = "Nabi2026Roster"

const previewReport: RosterImportReport = {
  added: 2,
  updated: 0,
  unchanged: 0,
  skipped: 1,
  changes: [],
  accounts: { created: 1, password_set: 1, password_kept: 0, password_missing: 0, no_account: 1 },
  rows: [
    { row: 2, organizer_member_id: "by-1", org_name: "하노이미디어", email: "tran@hanoi.vn", result: "added", account: "created", password: "set", reason: null },
    { row: 3, organizer_member_id: "by-2", org_name: "다낭미디어", email: "tran@hanoi.vn", result: "added", account: "none", password: null, reason: "duplicate_email_in_file" },
    { row: 4, organizer_member_id: null, org_name: "아이디없음", email: null, result: "skipped", account: "none", password: null, reason: "missing_member_id" },
  ],
}
const appliedReport: RosterImportReport = { ...previewReport }

function csvFile() {
  return new File(["id,role,name_ko,contact_email\r\nby-1,바이어,하노이미디어,tran@hanoi.vn"], "roster.csv", {
    type: "text/csv",
  })
}

function renderDialog(props: Partial<Parameters<typeof RosterUploadDialog>[0]> = {}) {
  return render(<RosterUploadDialog open onOpenChange={vi.fn()} {...props} />)
}

async function fillPasswords(password: string, confirm = password) {
  await userEvent.type(screen.getByLabelText("공통 비밀번호"), password)
  await userEvent.type(screen.getByLabelText("공통 비밀번호 확인"), confirm)
}

function formOf(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return { url, body: init.body as FormData }
}

describe("명단 업로드 다이얼로그(두 콘솔 공용)", () => {
  beforeEach(() => {
    refresh.mockClear()
    download.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("미리보기(dry_run)로 행별 결과를 보여주고, 적용하면 공통 비밀번호와 함께 반영한 뒤 목록을 새로고침한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: previewReport }))
      .mockResolvedValueOnce(Response.json({ success: true, result: appliedReport }))
    vi.stubGlobal("fetch", fetchMock)
    const onApplied = vi.fn()
    renderDialog({ eventId: "event-1", onApplied })

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    expect(screen.getByText("roster.csv")).toBeInTheDocument()
    await fillPasswords(PASSWORD)
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled() // 미리보기 전엔 적용 불가

    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    await waitFor(() => expect(screen.getByText("미리보기 — 아직 저장되지 않았어요")).toBeInTheDocument())
    const preview = formOf(fetchMock, 0)
    expect(preview.url).toBe("/api/organizer/members/roster?event_id=event-1")
    expect(preview.body.get("password")).toBe(PASSWORD)
    expect(preview.body.get("dry_run")).toBe("true")
    expect(preview.body.get("row_report")).toBe("true")
    expect(screen.getByText("신규 2 · 갱신 0 · 무변경 0 · 건너뜀 1")).toBeInTheDocument()
    expect(screen.getByText("로그인 가능해질 계정 1 · 비밀번호 유지 0 · 비밀번호 없음 0 · 계정 없음 1")).toBeInTheDocument()
    const table = screen.getByRole("table")
    expect(within(table).getByText("같은 이메일이 파일 위쪽 행에 이미 있어요")).toBeInTheDocument()
    expect(within(table).getByText("id가 비어 있어요")).toBeInTheDocument()
    expect(within(table).getByText("비밀번호 설정")).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled() // 미리보기는 저장하지 않으니 새로고침도 없다

    await userEvent.click(screen.getByRole("button", { name: "적용" }))

    await waitFor(() => expect(screen.getByText("반영 완료")).toBeInTheDocument())
    const applied = formOf(fetchMock, 1)
    expect(applied.body.get("dry_run")).toBe("false")
    expect(applied.body.get("password")).toBe(PASSWORD)
    expect(screen.getByText("비밀번호 설정 1 · 비밀번호 유지 0 · 비밀번호 없음 0 · 계정 없음 1")).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onApplied).toHaveBeenCalledWith(appliedReport)
    expect(document.body.textContent).not.toContain(PASSWORD) // 평문을 화면에 남기지 않는다(입력칸 값 제외)
  })

  it("확인 비밀번호가 다르면 전송하지 않고 불일치를 알린다", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await fillPasswords(PASSWORD, `${PASSWORD}9`)
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    expect(screen.getByRole("alert")).toHaveTextContent("비밀번호가 일치하지 않아요.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("정책(8자 이상·영문+숫자)에 안 맞으면 전송하지 않는다", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await fillPasswords("onlyletters")
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    expect(screen.getByRole("alert")).toHaveTextContent("비밀번호는 8자 이상, 영문과 숫자를 포함해야 해요.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("공통 비밀번호를 비우면 로그인 불가 경고를 보여주고 password 없이 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: previewReport }))
    vi.stubGlobal("fetch", fetchMock)
    renderDialog()

    expect(screen.getByText("비워 두면 새로 만든 계정은 비밀번호가 없어 로그인할 수 없어요.")).toBeInTheDocument()
    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const call = formOf(fetchMock, 0)
    expect(call.url).toBe("/api/organizer/members/roster") // 행사 미지정 → BFF가 운영자의 첫 행사로
    expect(call.body.has("password")).toBe(false)
  })

  it("미리보기 뒤 비밀번호를 바꾸면 다시 미리보기 전까지 적용할 수 없다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, result: previewReport })))
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await fillPasswords(PASSWORD)
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "적용" })).toBeEnabled())

    await userEvent.type(screen.getByLabelText("공통 비밀번호"), "x")

    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled()
    expect(screen.queryByText("미리보기 — 아직 저장되지 않았어요")).not.toBeInTheDocument()
  })

  it("서버 거부 사유를 코드별 안내로 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ success: false, error: "ROSTER_PASSWORD_COLUMN" }, { status: 400 }))
    )
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "파일에 비밀번호 컬럼이 있어요. 파일에서 지우고 공통 비밀번호 칸을 사용하세요."
      )
    )
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled()
  })

  it("템플릿 예시 행이 남아 있으면 미리보기에서 경고한다", async () => {
    const withExample: RosterImportReport = {
      ...previewReport,
      rows: [{ ...previewReport.rows![0], email: "buyer@example.com" }],
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, result: withExample })))
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    await waitFor(() =>
      expect(
        screen.getByText("템플릿 예시 행(example.com 이메일)이 1건 남아 있어요. 지우고 다시 올려 주세요.")
      ).toBeInTheDocument()
    )
  })

  it("템플릿 다운로드는 BOM이 붙은 공용 CSV를 내려준다", async () => {
    renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "템플릿 다운로드" }))

    expect(download).toHaveBeenCalledTimes(1)
    const [filename, content, mime] = download.mock.calls[0] as [string, string, string]
    expect(filename).toBe("nabi-roster-template.csv")
    expect(mime).toBe("text/csv;charset=utf-8")
    expect(Array.from(new TextEncoder().encode(content).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(content).toContain("id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,content_category")
  })

  it("행이 아주 많으면 확인이 필요한 행을 먼저 넣어 표를 자른다", async () => {
    const okRows = Array.from({ length: MAX_VISIBLE_ROWS + 20 }, (_, i) => ({
      ...previewReport.rows![0],
      row: i + 2,
      organizer_member_id: `ok-${i}`,
      email: `ok${i}@hanoi.vn`,
    }))
    const problem = { ...previewReport.rows![2], row: MAX_VISIBLE_ROWS + 50, organizer_member_id: "late-problem" }
    const big: RosterImportReport = { ...previewReport, rows: [...okRows, problem] }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, result: big })))
    renderDialog()

    await userEvent.upload(screen.getByLabelText("명단 파일"), csvFile())
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }))

    const table = await screen.findByRole("table")
    expect(within(table).getAllByRole("row")).toHaveLength(MAX_VISIBLE_ROWS + 1) // 헤더 포함
    expect(within(table).getByText("late-problem")).toBeInTheDocument()
    expect(
      screen.getByText(`전체 ${big.rows!.length}행 중 확인이 필요한 행을 먼저, ${MAX_VISIBLE_ROWS}행까지만 표에 보여줘요.`)
    ).toBeInTheDocument()
  })

  it("버튼은 닫혀 있을 땐 다이얼로그를 마운트하지 않고, 누르면 연다", async () => {
    render(<RosterUploadButton eventId="event-1" />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "명단 업로드" }))

    expect(within(screen.getByRole("dialog")).getByText("1. 템플릿 작성")).toBeInTheDocument()
  })
})
