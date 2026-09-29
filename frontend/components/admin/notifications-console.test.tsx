import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
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
