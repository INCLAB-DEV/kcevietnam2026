// 공용 Dialog의 닫기 라벨이 next-intl(common.close)에서 오므로 intl provider로 감싸 렌더한다.
import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
import { toast } from "sonner"
import { InterpretersConsole } from "./interpreters-console"
import type { AdminInterpreter, AdminOrganization } from "@/lib/admin/types"

// 이슈 #16 — 통역사 콘솔의 언어 라벨 표시(②)와 삭제 실패 피드백(①) 회귀.
// mock 모드(기본, NEXT_PUBLIC_AUTH_CLIENT 미설정)에서는 admin-actions의 dispatch가 네트워크 없이
// 항상 성공한다 — 삭제 실패 경로는 실연동 모드로 전환해 fetch를 직접 모킹한다(admin-actions.test.ts와
// 같은 패턴, venues-console.test.tsx와 자매 테스트).

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderConsole(props: ComponentProps<typeof InterpretersConsole>) {
  return render(<InterpretersConsole {...props} />)
}

function itp(
  over: Partial<AdminInterpreter> & Pick<AdminInterpreter, "id" | "name">
): AdminInterpreter {
  return {
    event_id: "evt-test",
    languages: [],
    phone: "010-0000-0000",
    email: null,
    assigned_org_id: null,
    assigned_org_name: null,
    ...over,
  }
}

const org: AdminOrganization = {
  id: "org-1",
  name_ko: "합성참가사",
} as AdminOrganization

describe("InterpretersConsole — 언어 표시(#16②)", () => {
  it("raw 코드 대신 한글 라벨로 보여준다", () => {
    renderConsole({
      interpreters: [
        itp({ id: "i-1", name: "김통역", languages: ["en", "vi"] }),
      ],
      organizations: [org],
      eventId: "evt-1",
      readOnly: false,
    })
    expect(screen.getByText("영어")).toBeInTheDocument()
    expect(screen.getByText("베트남어")).toBeInTheDocument()
    expect(screen.queryByText("en")).not.toBeInTheDocument()
    expect(screen.queryByText("vi")).not.toBeInTheDocument()
  })

  it("other 코드도 라벨(기타)로 보여준다", () => {
    renderConsole({
      interpreters: [itp({ id: "i-1", name: "김통역", languages: ["other"] })],
      organizations: [org],
      eventId: "evt-1",
      readOnly: false,
    })
    expect(screen.getByText("기타")).toBeInTheDocument()
    expect(screen.queryByText("other")).not.toBeInTheDocument()
  })

  it("이미 한글 라벨(저장 직후 낙관적 상태)이어도 그대로 보여준다", () => {
    renderConsole({
      interpreters: [
        itp({ id: "i-1", name: "김통역", languages: ["영어", "베트남어"] }),
      ],
      organizations: [org],
      eventId: "evt-1",
      readOnly: false,
    })
    expect(screen.getByText("영어")).toBeInTheDocument()
    expect(screen.getByText("베트남어")).toBeInTheDocument()
  })
})

describe("InterpretersConsole — 삭제 실패 피드백(#16①)", () => {
  it("DELETE가 실패하면 행을 되돌리고 에러를 보여준다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "internal error" }), {
          status: 500,
        })
    )
    vi.stubGlobal("fetch", fetchSpy)

    renderConsole({
      interpreters: [itp({ id: "i-1", name: "김통역" })],
      organizations: [org],
      eventId: "evt-1",
      readOnly: false,
    })

    await userEvent.click(screen.getByRole("button", { name: "김통역 삭제" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))

    // 실패 시 행과 확인 대화상자를 유지하고 오류를 알린다.
    await waitFor(() => expect(screen.getByText("김통역")).toBeInTheDocument())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "삭제에 실패했어요",
        expect.any(Object)
      )
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("DELETE가 성공하면 행이 그대로 사라진 채 유지된다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchSpy)

    renderConsole({
      interpreters: [itp({ id: "i-1", name: "김통역" })],
      organizations: [org],
      eventId: "evt-1",
      readOnly: false,
    })

    await userEvent.click(screen.getByRole("button", { name: "김통역 삭제" }))
    const dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(screen.queryByText("김통역")).not.toBeInTheDocument()
  })
})
