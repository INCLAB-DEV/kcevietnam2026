import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

// 저장 성공/실패 토스트는 화면에 Toaster를 띄우지 않고 호출로 검증한다(buyer-profile-hub.test.tsx와 동일 패턴).
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

import { ChangePasswordDialog } from "./change-password-dialog"
import type { ChangePasswordClient, ChangePasswordResult } from "@/lib/auth/change-password-client"

// 테스트용 평문 — 응답에 노출되면 안 되는 값.
const VALID_CURRENT = "OldPassw0rd"
const VALID_NEW = "NewPassw0rd1"

// client는 module mock이 아니라 컴포넌트의 client prop으로 직접 주입한다(defaultChangePasswordClient
// 스왑보다 결합이 느슨하다 — 이 컴포넌트가 이미 테스트 주입용으로 그 prop을 열어뒀다).
function stubClient(result: ChangePasswordResult) {
  const changePassword = vi.fn(async () => result)
  return { client: { changePassword } satisfies ChangePasswordClient, changePassword }
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "비밀번호 변경" }))
  return screen.findByRole("dialog")
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  values: { current?: string; next?: string; confirm?: string },
) {
  if (values.current !== undefined) {
    await user.type(within(dialog).getByLabelText("현재 비밀번호"), values.current)
  }
  if (values.next !== undefined) {
    await user.type(within(dialog).getByLabelText("새 비밀번호"), values.next)
  }
  if (values.confirm !== undefined) {
    await user.type(within(dialog).getByLabelText("새 비밀번호 확인"), values.confirm)
  }
}

function submitButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "비밀번호 변경" })
}

describe("ChangePasswordDialog", () => {
  afterEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it("트리거로 열리고 현재/새/확인 세 필드가 렌더된다", async () => {
    const user = userEvent.setup()
    const { client } = stubClient({ outcome: "succeeded" })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    expect(within(dialog).getByLabelText("현재 비밀번호")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("새 비밀번호")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("새 비밀번호 확인")).toBeInTheDocument()
  })

  it("새 비밀번호와 확인이 다르면 불일치 힌트를 보이고 클라이언트를 호출하지 않는다", async () => {
    const user = userEvent.setup()
    const { client, changePassword } = stubClient({ outcome: "succeeded" })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    await fillForm(user, dialog, { current: VALID_CURRENT, next: VALID_NEW, confirm: "Different1" })
    await user.click(submitButton(dialog))

    expect(await within(dialog).findByText("새 비밀번호가 일치하지 않아요.")).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it("새 비밀번호가 정책 미달이면 제출을 막고 정책 힌트를 보인다", async () => {
    const user = userEvent.setup()
    const { client, changePassword } = stubClient({ outcome: "succeeded" })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    await fillForm(user, dialog, { current: VALID_CURRENT, next: "abc", confirm: "abc" })
    await user.click(submitButton(dialog))

    expect(
      await within(dialog).findByText("비밀번호는 8자 이상, 영문과 숫자를 포함해야 해요."),
    ).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it("성공하면 토스트를 띄우고 다이얼로그를 닫으며 다음에 열었을 때 필드가 비어 있다", async () => {
    const user = userEvent.setup()
    const { client } = stubClient({ outcome: "succeeded" })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    await fillForm(user, dialog, { current: VALID_CURRENT, next: VALID_NEW, confirm: VALID_NEW })
    await user.click(submitButton(dialog))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    const reopened = await openDialog(user)
    expect(within(reopened).getByLabelText("현재 비밀번호")).toHaveValue("")
    expect(within(reopened).getByLabelText("새 비밀번호")).toHaveValue("")
    expect(within(reopened).getByLabelText("새 비밀번호 확인")).toHaveValue("")
  })

  it("현재 비밀번호 불일치(invalid_current)는 서버 메시지로 에러 토스트를 띄우고 다이얼로그를 연 채 입력을 유지한다", async () => {
    const user = userEvent.setup()
    const message = "현재 비밀번호가 일치하지 않습니다"
    const { client } = stubClient({ outcome: "invalid_current", message })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    await fillForm(user, dialog, { current: "wrong-password", next: VALID_NEW, confirm: VALID_NEW })
    await user.click(submitButton(dialog))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message))
    expect(await within(dialog).findByText(message)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("현재 비밀번호")).toHaveValue("wrong-password")
  })

  it("정책 위반(policy_violation)은 서버 문구를 그대로 보여준다", async () => {
    const user = userEvent.setup()
    const message = "비밀번호는 최소 8자, 영문+숫자를 포함해야 합니다"
    const { client } = stubClient({ outcome: "policy_violation", message })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    // 서버까지 보내려면 클라이언트 zod는 통과해야 한다 — 정책 위반은 서버 판정을 흉내낸 것.
    await fillForm(user, dialog, { current: VALID_CURRENT, next: VALID_NEW, confirm: VALID_NEW })
    await user.click(submitButton(dialog))

    expect(await within(dialog).findByText(message)).toBeInTheDocument()
  })

  it("세션 만료(unauthenticated)는 안내 토스트만 띄우고 리다이렉트하지 않는다", async () => {
    const user = userEvent.setup()
    const { client } = stubClient({ outcome: "unauthenticated" })
    render(<ChangePasswordDialog client={client} />)

    const dialog = await openDialog(user)
    await fillForm(user, dialog, { current: VALID_CURRENT, next: VALID_NEW, confirm: VALID_NEW })
    await user.click(submitButton(dialog))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("세션이 만료됐어요. 다시 로그인해주세요."),
    )
    // 다이얼로그가 그대로 열려 있다(강제 이동 없음) — 입력을 잃지 않는다.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})

// 다이얼로그를 여는 버튼은 바꿔 끼울 수 있다(trigger) — 프로필 메뉴가 없는 "미팅만" 행사에서 사이드바가
// 작은 텍스트 버튼으로 같은 다이얼로그를 연다(F-NV-001 D15). 폼·검증·제출은 진입점과 무관하게 같다.
describe("ChangePasswordDialog — 진입 버튼 교체(trigger)", () => {
  afterEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it("trigger를 넘기면 기본 버튼 대신 그 요소가 다이얼로그를 연다", async () => {
    const user = userEvent.setup()
    const { client } = stubClient({ outcome: "succeeded" })
    render(
      <ChangePasswordDialog
        client={client}
        trigger={
          <button type="button" data-testid="custom-trigger">
            사이드바용 진입점
          </button>
        }
      />,
    )

    // 기본 버튼(마이페이지 헤더용)은 그려지지 않는다 — 진입점은 하나다.
    expect(screen.queryByRole("button", { name: "비밀번호 변경" })).not.toBeInTheDocument()

    await user.click(screen.getByTestId("custom-trigger"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("현재 비밀번호")).toBeInTheDocument()
  })

  it("교체한 진입점으로 열어도 같은 폼으로 변경이 끝까지 된다", async () => {
    const user = userEvent.setup()
    const { client, changePassword } = stubClient({ outcome: "succeeded" })
    render(
      <ChangePasswordDialog
        client={client}
        trigger={<button type="button">열기</button>}
      />,
    )

    await user.click(screen.getByRole("button", { name: "열기" }))
    const dialog = await screen.findByRole("dialog")
    await fillForm(user, dialog, { current: VALID_CURRENT, next: VALID_NEW, confirm: VALID_NEW })
    await user.click(submitButton(dialog))

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: VALID_CURRENT,
        newPassword: VALID_NEW,
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it("trigger를 생략하면 기본 버튼이다(프로필 화면의 기존 진입점 — 변함없음)", () => {
    const { client } = stubClient({ outcome: "succeeded" })
    render(<ChangePasswordDialog client={client} />)

    expect(screen.getByRole("button", { name: "비밀번호 변경" })).toBeInTheDocument()
  })
})
