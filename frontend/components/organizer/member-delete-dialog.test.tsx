// "참가자 삭제" 확인 다이얼로그 — 네 상태(삭제 가능·막힘·조회 실패·명단에 없음)와 서버 거부 뒤의 화면.
// 운영 데이터를 지우는 확인이라 고정하는 것은: 무엇이 지워지는지 **읽은 뒤에만** 삭제를 누를 수 있다.
import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { MemberDeleteDialog, type MemberDeleteOutcome } from "./member-delete-dialog"
import {
  MOCK_DELETION_IMPACT,
  ORG_NOT_FOUND,
  type MemberDeletionImpact,
} from "@/lib/organizer/member-deletion"

function impact(over: Partial<MemberDeletionImpact> = {}): MemberDeletionImpact {
  return { ...MOCK_DELETION_IMPACT, ...over }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderDialog({
  loadImpact,
  onConfirm = vi.fn(async (): Promise<MemberDeleteOutcome> => ({ status: "deleted" })),
  onOpenChange = vi.fn(),
  reloadMembers = vi.fn(),
}: {
  loadImpact: () => Promise<MemberDeletionImpact>
  onConfirm?: () => Promise<MemberDeleteOutcome>
  onOpenChange?: (open: boolean) => void
  reloadMembers?: () => void
}) {
  render(
    <MemberDeleteDialog
      name="툰브릿지"
      loadImpact={loadImpact}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      reloadMembers={reloadMembers}
    />,
  )
  return { onConfirm, onOpenChange, reloadMembers, dialog: screen.getByRole("dialog") }
}

const deleteButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "삭제" })

describe("MemberDeleteDialog — 삭제 영향을 읽는 동안", () => {
  it("삭제 버튼이 비활성이고, 함께 지워지는 것에 대해 아무 말도 하지 않는다", () => {
    const pending = deferred<MemberDeletionImpact>()
    const { dialog } = renderDialog({ loadImpact: () => pending.promise })

    expect(within(dialog).getByText("'툰브릿지'을(를) 이 행사 명단에서 삭제합니다.")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("삭제하면 함께 지워지는 것을 확인하는 중")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    expect(within(dialog).queryByText(/함께 삭제/)).not.toBeInTheDocument()
  })
})

describe("MemberDeleteDialog — 삭제 가능", () => {
  it("함께 지워지는 것을 건수와 함께 보여 주고 삭제를 받는다", async () => {
    const { dialog, onConfirm } = renderDialog({
      loadImpact: async () =>
        impact({
          closedMeetingCount: 2,
          reviewCount: 1,
          notificationCount: 3,
          linkedRecordCount: 2,
          memberCount: 1,
        }),
    })

    expect(
      await within(dialog).findByText("취소·거절된 미팅 2건과 회의록 1건·알림 3건이 함께 삭제됩니다."),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText("이 기업과 연결된 관심 표시·러브콜·AI 추천 등 2건도 함께 삭제됩니다."),
    ).toBeInTheDocument()
    expect(within(dialog).getByText("로그인 계정 1개도 삭제됩니다.")).toBeInTheDocument()
    expect(within(dialog).getByText("되돌릴 수 없습니다.")).toBeInTheDocument()

    await userEvent.click(deleteButton(dialog))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("미팅이 없는 기업은 없다고 분명히 말한다", async () => {
    const { dialog } = renderDialog({ loadImpact: async () => impact() })

    expect(await within(dialog).findByText("함께 삭제되는 미팅은 없습니다.")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeEnabled()
  })

  it("서버 응답을 기다리는 동안 삭제를 다시 누를 수도, 닫을 수도 없다", async () => {
    const answer = deferred<MemberDeleteOutcome>()
    const onConfirm = vi.fn(() => answer.promise)
    const onOpenChange = vi.fn()
    const { dialog } = renderDialog({ loadImpact: async () => impact(), onConfirm, onOpenChange })

    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))
    expect(deleteButton(dialog)).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled()
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledTimes(1)

    answer.resolve({ status: "failed" })
    // 실패하면 그대로 남아 다시 누를 수 있다.
    await waitFor(() => expect(deleteButton(dialog)).toBeEnabled())
  })
})

describe("MemberDeleteDialog — 막힘", () => {
  it("예정 미팅 — 이유와 할 일을 알리고 삭제 버튼을 막는다", async () => {
    const { dialog, onConfirm } = renderDialog({
      loadImpact: async () => impact({ deletable: false, scheduledCount: 2 }),
    })

    expect(
      await within(dialog).findByText(
        "예정된 미팅이 2건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요.",
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByText("지금은 삭제할 수 없습니다")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    expect(within(dialog).queryByText("되돌릴 수 없습니다.")).not.toBeInTheDocument()

    await userEvent.click(deleteButton(dialog))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("완료 미팅 — 삭제할 수 없는 이유를 알린다. 예정 미팅도 있으면 둘 다 알린다", async () => {
    const { dialog } = renderDialog({
      loadImpact: async () => impact({ deletable: false, scheduledCount: 1, completedCount: 1 }),
    })

    expect(
      await within(dialog).findByText(
        "완료된 미팅이 1건 있어 삭제할 수 없습니다(상대 기업의 회의록이 함께 사라집니다).",
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText("예정된 미팅이 1건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요."),
    ).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
  })
})

describe("MemberDeleteDialog — 조회 실패", () => {
  it("읽지 못했다고 알리고 삭제를 막는다 — '함께 지워지는 것 없음'처럼 보이지 않는다", async () => {
    const { dialog, onConfirm } = renderDialog({
      loadImpact: async () => {
        throw new Error("http_500")
      },
    })

    expect(await within(dialog).findByText("삭제 영향을 확인하지 못했어요")).toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    expect(within(dialog).queryByText(/함께 삭제/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText("되돌릴 수 없습니다.")).not.toBeInTheDocument()

    await userEvent.click(deleteButton(dialog))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // 평문 404(라우팅·배포가 어긋난 "Not Found" 등)도 BFF가 http_404로 넘기는 일반 실패다.
  it.each(["http_500", "http_404"])(
    "일반 실패(%s)는 '명단에 없음'으로 보이지 않고, 명단을 다시 읽게 하지 않는다",
    async (code) => {
      const { dialog, reloadMembers } = renderDialog({
        loadImpact: async () => {
          throw new Error(code)
        },
      })

      expect(await within(dialog).findByText("삭제 영향을 확인하지 못했어요")).toBeInTheDocument()
      expect(within(dialog).getByRole("button", { name: "다시 확인" })).toBeInTheDocument()
      expect(
        within(dialog).queryByText("이 행사 명단에서 찾을 수 없는 기업이에요"),
      ).not.toBeInTheDocument()
      expect(reloadMembers).not.toHaveBeenCalled()
    },
  )

  it("다시 확인하면 다시 읽고, 읽히면 삭제할 수 있게 된다", async () => {
    const loadImpact = vi
      .fn<() => Promise<MemberDeletionImpact>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(impact({ closedMeetingCount: 1 }))
    const { dialog } = renderDialog({ loadImpact })

    await userEvent.click(await within(dialog).findByRole("button", { name: "다시 확인" }))

    expect(await within(dialog).findByText("취소·거절된 미팅 1건이 함께 삭제됩니다.")).toBeInTheDocument()
    expect(loadImpact).toHaveBeenCalledTimes(2)
    expect(deleteButton(dialog)).toBeEnabled()
  })
})

describe("MemberDeleteDialog — 이 행사 명단에 없는 기업(미리보기 404 ORG_NOT_FOUND)", () => {
  it("일반 실패와 다른 안내를 단정하지 않는 말로 띄우고, 삭제·다시 확인 없이 명단을 한 번 다시 읽게 한다", async () => {
    const loadImpact = vi.fn(async (): Promise<MemberDeletionImpact> => {
      throw new Error(ORG_NOT_FOUND)
    })
    const { dialog, onConfirm, reloadMembers } = renderDialog({ loadImpact })

    expect(
      await within(dialog).findByText("이 행사 명단에서 찾을 수 없는 기업이에요"),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "다른 운영자가 먼저 삭제했거나 다른 탭에서 행사를 바꿨을 수 있어요. 명단을 새로 불러왔어요.",
      ),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText("삭제 영향을 확인하지 못했어요")).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "다시 확인" })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/함께 삭제/)).not.toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    await waitFor(() => expect(reloadMembers).toHaveBeenCalledTimes(1))

    await userEvent.click(deleteButton(dialog))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(reloadMembers).toHaveBeenCalledTimes(1)
    expect(loadImpact).toHaveBeenCalledTimes(1)
  })
})

describe("MemberDeleteDialog — 서버가 삭제를 거부했을 때", () => {
  it("미리보기를 읽은 뒤 미팅이 생겼으면, 서버가 센 건수로 막힘 상태가 된다", async () => {
    const onConfirm = vi.fn(
      async (): Promise<MemberDeleteOutcome> => ({
        status: "blocked",
        scheduledCount: 1,
        completedCount: 0,
      }),
    )
    const { dialog } = renderDialog({
      loadImpact: async () => impact({ closedMeetingCount: 1 }),
      onConfirm,
    })

    await userEvent.click(await within(dialog).findByRole("button", { name: "삭제" }))

    expect(
      await within(dialog).findByText(
        "예정된 미팅이 1건 있습니다. 미팅 관리에서 먼저 취소한 뒤 삭제해 주세요.",
      ),
    ).toBeInTheDocument()
    // 낡은 "삭제 가능" 화면은 남지 않는다.
    expect(within(dialog).queryByText("취소·거절된 미팅 1건이 함께 삭제됩니다.")).not.toBeInTheDocument()
    expect(deleteButton(dialog)).toBeDisabled()
    await userEvent.click(deleteButton(dialog))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
