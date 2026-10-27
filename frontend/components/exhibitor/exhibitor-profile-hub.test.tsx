import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 허브가 저장 후 router.refresh()로 서버 컴포넌트를 갱신한다 — 테스트 환경엔 app router가 없으므로 모킹.
const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}))
// 저장 성공/실패 토스트는 화면에 Toaster를 띄우지 않고 호출로 검증한다(members-table.test와 동일 패턴).
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: toastSuccess,
    error: toastError,
    info: vi.fn(),
  }),
}))

import { ExhibitorProfileHub } from "./exhibitor-profile-hub"

// mock 경로(orgEventRoleId 없음)는 lib/bm/mock-exhibitor-client.test.ts·apply-form.test.tsx가 이미
// 다룬다. 이 파일은 실 세션 경로(orgEventRoleId 있음) — FastAPI(BFF 경유) 조회/저장으로 배선되고,
// 조회 실패는 데모 폴백 없이 에러 UI로 정직하게 떨어진다(silent 데모 폴백 제거 원칙).

type ApiProfile = Record<string, unknown>

function apiProfile(over: ApiProfile = {}): ApiProfile {
  return {
    org_event_role_id: "role-1",
    application_status: "approved",
    organization_name_ko: "실 참가사",
    organization_name_en: "Real Exhibitor",
    intro_ko: "국문 소개",
    intro_en: "English intro",
    ...over,
  }
}

// GET은 첫 인자만(상대경로), PATCH/POST는 init.method로 가른다.
function stubFetch(get: ApiProfile, patched?: ApiProfile, patchOk = true) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (!patchOk) {
        return { ok: false, status: 422, text: async () => "rejected" }
      }
      return { ok: true, json: async () => patched ?? get }
    }
    return { ok: true, json: async () => get }
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

function patchCall(spy: ReturnType<typeof stubFetch>) {
  return spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")
}

describe("ExhibitorProfileHub — 실 세션(orgEventRoleId)", () => {
  beforeEach(() => {
    refresh.mockClear()
    toastSuccess.mockClear()
    toastError.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("BFF(/api/bm/exhibitor/{id})를 호출하고, 미완성이어도 데모로 바꾸지 않고 실 프로필을 그대로 보여준다", async () => {
    const fetchSpy = stubFetch({
      org_event_role_id: "role-1",
      application_status: "registered",
      organization_name_ko: "실 참가사",
    })

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)

    expect(await screen.findByText("실 참가사")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledWith("/api/bm/exhibitor/role-1", undefined)
    // 데모 fallback 이메일은 나오지 않는다(실 세션은 데모로 바꿔치기하지 않는다).
    expect(screen.queryByText("manager@hanwhasystems.com")).not.toBeInTheDocument()
  })

  it("조회 실패 시 데모로 폴백하지 않고 에러 UI를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("no session") })
    )

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)

    expect(await screen.findByText("프로필을 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.queryByText("manager@hanwhasystems.com")).not.toBeInTheDocument()
  })

  // ── 구획별 자체 수정(마이페이지 강화) ────────────────────────────────────────
  it("승인(approved) 상태에서 회사소개 구획을 고쳐 저장하면 그 단계 PATCH가 나가고 서버 응답이 조회에 반영된다", async () => {
    const fetchSpy = stubFetch(
      apiProfile(),
      apiProfile({ intro_ko: "새 국문 소개" })
    )

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 참가사")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "회사소개" }))
    await userEvent.click(
      await screen.findByRole("button", { name: "회사소개 수정" })
    )

    const dialog = await screen.findByRole("dialog")
    const introKo = within(dialog).getByPlaceholderText(
      "우리 회사의 강점·차별점을 적어주세요."
    )
    await userEvent.clear(introKo)
    await userEvent.type(introKo, "새 국문 소개")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(patchCall(fetchSpy)).toBeTruthy())
    const [url, init] = patchCall(fetchSpy)!
    expect(url).toBe("/api/bm/exhibitor/role-1/steps/2")
    expect((init as RequestInit).method).toBe("PATCH")
    // 2단계(회사소개)가 소유한 필드만 — 다른 구획 필드는 담기지 않는다(부분 저장).
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      intro_ko: "새 국문 소개",
      intro_en: "English intro",
      available_languages: [],
    })

    // 서버가 확인해 준 값이 조회에 반영된다(낙관적 갱신이 아니라 응답 반영).
    expect(await screen.findByText("새 국문 소개")).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("저장이 실패하면 에러 토스트를 띄우고 조회 값은 옛 값 그대로 남는다", async () => {
    stubFetch(apiProfile(), undefined, false)

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 참가사")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "회사소개" }))
    await userEvent.click(
      await screen.findByRole("button", { name: "회사소개 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    const introKo = within(dialog).getByPlaceholderText(
      "우리 회사의 강점·차별점을 적어주세요."
    )
    await userEvent.clear(introKo)
    await userEvent.type(introKo, "저장 실패할 소개")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    // 다이얼로그는 열린 채 입력을 유지하고, 뒤의 조회 값은 서버의 옛 값 그대로 남는다.
    expect(
      within(await screen.findByRole("dialog")).getByDisplayValue("저장 실패할 소개")
    ).toBeInTheDocument()
    expect(screen.getByText("국문 소개")).toBeInTheDocument()
  })

  it("기본정보 저장은 참가자가 못 고치는 부스 스냅샷을 페이로드에서 빼고, 부스·회사명은 입력이 아니라 텍스트로만 보인다", async () => {
    const fetchSpy = stubFetch(
      apiProfile({
        business_reg_no: "123-45-67890",
        booth_hall: "7",
        booth_pavilion: "대한민국관",
        booth_location: "A-101",
        booth_type: "독립부스",
        booth_count: 2,
      })
    )

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)
    await userEvent.click(
      await screen.findByRole("button", { name: "기본정보 수정" })
    )
    const dialog = await screen.findByRole("dialog")

    // 회사명·부스는 읽기전용 텍스트 — 편집 가능한 입력으로는 잡히지 않는다.
    expect(within(dialog).getByText("A-101")).toBeInTheDocument()
    expect(within(dialog).queryByDisplayValue("A-101")).toBeNull()
    expect(within(dialog).queryByDisplayValue("실 참가사")).toBeNull()

    // 참가자가 고칠 수 있는 필드(사업자등록번호)는 입력이다.
    const regNo = within(dialog).getByDisplayValue("123-45-67890")
    await userEvent.clear(regNo)
    await userEvent.type(regNo, "999-88-77777")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(patchCall(fetchSpy)).toBeTruthy())
    const body = JSON.parse(String((patchCall(fetchSpy)![1] as RequestInit).body))
    expect(body.business_reg_no).toBe("999-88-77777")
    for (const operatorOwned of [
      "booth_hall",
      "booth_pavilion",
      "booth_location",
      "booth_type",
      "booth_count",
      "application_status",
      "unavailable_meeting_slots",
    ]) {
      expect(body).not.toHaveProperty(operatorOwned)
    }
  })

  it("필수 항목을 비우면 저장하지 않고 안내만 띄운다(작성 폼과 같은 검증 정본)", async () => {
    const fetchSpy = stubFetch(apiProfile())

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 참가사")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "회사소개" }))
    await userEvent.click(
      await screen.findByRole("button", { name: "회사소개 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.clear(
      within(dialog).getByPlaceholderText("우리 회사의 강점·차별점을 적어주세요.")
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    expect(
      await within(dialog).findByText("필수 항목을 채워야 저장할 수 있어요.")
    ).toBeInTheDocument()
    expect(patchCall(fetchSpy)).toBeUndefined()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("검토 대기(submitted)는 조회 전용 — 어떤 구획에도 수정 버튼이 없다", async () => {
    stubFetch(apiProfile({ application_status: "submitted" }))

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 참가사")).toBeInTheDocument()

    expect(screen.queryByRole("button", { name: /수정/ })).toBeNull()
    await userEvent.click(screen.getByRole("tab", { name: "회사소개" }))
    expect(screen.queryByRole("button", { name: /수정/ })).toBeNull()
    // 잠금 안내가 유지된다(구획 편집이 열렸다는 안내로 바뀌지 않는다).
    expect(
      screen.getByText(/제출 후에는 수정할 수 없어요/)
    ).toBeInTheDocument()
    // 조회 전용 상태여도 헤더의 비밀번호 변경(headerAction)은 계정 기능이라 그대로 남는다.
    expect(screen.getByRole("button", { name: "비밀번호 변경" })).toBeInTheDocument()
  })

  it("보완 요청(changes_requested)도 구획을 직접 고칠 수 있다", async () => {
    stubFetch(apiProfile({ application_status: "changes_requested" }))

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)

    expect(
      await screen.findByRole("button", { name: "기본정보 수정" })
    ).toBeInTheDocument()
  })
})
