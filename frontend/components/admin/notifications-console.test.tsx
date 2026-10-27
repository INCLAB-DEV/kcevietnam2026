import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { NotificationsConsole } from "./notifications-console"
import type { AdminNotificationLog } from "@/lib/admin/types"

// N5 회귀 — 참가자 알림함엔 application_approved(승인완료)가 정상 표시되는데, 운영자 콘솔의
// "알림 타입" 필터 목록엔 이 타입이 빠져 있어 필터링이 불가능했다(.e2e-artifacts/e2e-verify-round.md
// N5). ADMIN_NOTIFICATION_TYPES가 참가자 쪽 정본(lib/home/notification.ts NotificationType)을
// 재사용하도록 고쳤으니, 필터 드롭다운에 "승인 완료"가 실제로 뜨는지 잠근다.

const logs: AdminNotificationLog[] = [
  {
    id: "n1",
    event_id: "evt-1",
    type: "application_approved",
    channel: "in_app",
    recipient_org_id: "org-1",
    recipient_org_name: "한류웨이브스튜디오",
    meeting_id: null,
    sent_at: "2026-09-12T23:34:00+09:00",
    delivered: true,
    resend_count: 0,
  },
]

describe("NotificationsConsole — 알림 타입 필터(N5)", () => {
  it("필터 드롭다운에 '승인 완료'가 다른 6종과 함께 표시된다", async () => {
    const user = userEvent.setup()
    render(<NotificationsConsole logs={logs} eventId="evt-1" timeZone="Asia/Seoul" readOnly={false} />)
    await user.click(screen.getByRole("button", { name: "알림 타입" }))
    expect(screen.getByRole("menuitemcheckbox", { name: "승인 완료" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "미팅 신청" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "미팅 수락" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "미팅 취소" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "미팅 리마인더" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "후기 요청" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: "회의록 준비" })).toBeInTheDocument()
  })

  it("'승인 완료'로 필터링하면 application_approved 행만 남는다", async () => {
    const user = userEvent.setup()
    render(<NotificationsConsole logs={logs} eventId="evt-1" timeZone="Asia/Seoul" readOnly={false} />)
    await user.click(screen.getByRole("button", { name: "알림 타입" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: "승인 완료" }))
    expect(screen.getByText("한류웨이브스튜디오")).toBeInTheDocument()
  })
})

// 참가자 알림 메일(nt004mail0001) — 꺼진 행사에서 보내지 않은 이메일 행은 "보내지 않음"으로 읽히고(미전달이
// 아니다), 꺼진 동안의 이메일 재발송은 서버가 409 PARTICIPANT_EMAIL_DISABLED로 거절한다.
describe("NotificationsConsole — 참가자 알림 메일 꺼짐", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const base: AdminNotificationLog = {
    id: "d-muted",
    event_id: "evt-1",
    type: "meeting_accepted",
    channel: "email",
    recipient_org_id: "org-1",
    recipient_org_name: "픽셀아츠 스튜디오",
    meeting_id: "m-1",
    sent_at: "2026-10-20T10:00:00+07:00",
    delivered: false,
    resend_count: 0,
    skip_reason: "event_email_disabled",
  }
  const failed: AdminNotificationLog = {
    ...base,
    id: "d-failed",
    recipient_org_name: "VinaContent",
    skip_reason: null,
    sent_at: "2026-10-20T09:00:00+07:00",
  }

  function rowOf(name: string) {
    return screen.getByText(name).closest("tr") as HTMLElement
  }

  it("보내지 않은 행은 '보내지 않음 (참가사·바이어 알림 메일 꺼짐)'이고 미전달 수에 들지 않는다", async () => {
    const user = userEvent.setup()
    render(
      <NotificationsConsole logs={[base, failed]} eventId="evt-1" timeZone="Asia/Ho_Chi_Minh" readOnly={false} />,
    )

    expect(within(rowOf("픽셀아츠 스튜디오")).getByText("보내지 않음 (참가사·바이어 알림 메일 꺼짐)")).toBeInTheDocument()
    expect(within(rowOf("픽셀아츠 스튜디오")).queryByText("미전달")).not.toBeInTheDocument()
    expect(within(rowOf("VinaContent")).getByText("미전달")).toBeInTheDocument()
    // "미전달만" 배지는 진짜 실패 1건만 센다.
    const failedOnly = screen.getByRole("button", { name: /미전달만/ })
    expect(failedOnly).toHaveTextContent("1")

    await user.click(failedOnly)
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
    expect(screen.getByText("VinaContent")).toBeInTheDocument()
  })

  it("꺼진 행사의 재발송이 409로 거절되면 그 안내를 보여주고 행을 바꾸지 않는다", async () => {
    const user = userEvent.setup()
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async () =>
      Response.json(
        {
          detail: {
            code: "PARTICIPANT_EMAIL_DISABLED",
            message: "참가자 알림 메일이 꺼져 있습니다. 행사 설정에서 켠 뒤 다시 보내세요.",
          },
        },
        { status: 409 },
      ),
    )
    vi.stubGlobal("fetch", fetchSpy)
    render(<NotificationsConsole logs={[base]} eventId="evt-1" timeZone="Asia/Ho_Chi_Minh" readOnly={false} />)

    await user.click(within(rowOf("픽셀아츠 스튜디오")).getByRole("button", { name: /재발송/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(toastError.mock.calls[0][1]).toMatchObject({
      description: "참가사·바이어 알림 메일이 꺼져 있습니다. 행사 설정에서 켠 뒤 다시 보내세요.",
    })
    // 보낸 것처럼 바뀌지 않는다 — 여전히 보내지 않음, 재발송 횟수도 그대로.
    const row = rowOf("픽셀아츠 스튜디오")
    expect(within(row).getByText("보내지 않음 (참가사·바이어 알림 메일 꺼짐)")).toBeInTheDocument()
    expect(within(row).queryByText("전달됨")).not.toBeInTheDocument()
    expect(within(row).queryByText("1회")).not.toBeInTheDocument()
    expect(within(row).getByRole("button", { name: /재발송/ })).toBeEnabled()
  })

  it("200이어도 서버가 delivered=false(메일 서버 실패·주소 없음)라고 답하면 전달됨으로 바꾸지 않는다", async () => {
    const user = userEvent.setup()
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ id: "d-failed", channel: "email", delivered: false, sent_at: null }),
      ),
    )
    render(<NotificationsConsole logs={[failed]} eventId="evt-1" timeZone="Asia/Ho_Chi_Minh" readOnly={false} />)

    await user.click(within(rowOf("VinaContent")).getByRole("button", { name: /재발송/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe("메일을 보내지 못했어요")
    const row = rowOf("VinaContent")
    expect(within(row).getByText("미전달")).toBeInTheDocument()
    expect(within(row).queryByText("전달됨")).not.toBeInTheDocument()
    expect(within(row).getByText("1회")).toBeInTheDocument() // 시도는 했다
    expect(within(row).getByRole("button", { name: /재발송/ })).toBeEnabled()
  })

  it("다시 켠 뒤의 재발송이 성공하면 전달됨으로 바뀐다", async () => {
    const user = userEvent.setup()
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ id: "d-muted", channel: "email", delivered: true, sent_at: null }),
      ),
    )
    render(<NotificationsConsole logs={[base]} eventId="evt-1" timeZone="Asia/Ho_Chi_Minh" readOnly={false} />)

    await user.click(within(rowOf("픽셀아츠 스튜디오")).getByRole("button", { name: /재발송/ }))

    const row = rowOf("픽셀아츠 스튜디오")
    expect(await within(row).findByText("전달됨")).toBeInTheDocument()
    expect(within(row).queryByText("보내지 않음 (참가사·바이어 알림 메일 꺼짐)")).not.toBeInTheDocument()
    expect(within(row).getByText("1회")).toBeInTheDocument()
  })
})
