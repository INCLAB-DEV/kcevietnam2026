import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { NotificationsConsole } from "@/components/admin/notifications-console"
import { notificationLogSummary } from "@/lib/admin/notifications"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 알림 관리 — 6종 타입 × 2채널(인앱/이메일) 발송 이력 + 수동 재발송.
export default async function AdminNotificationsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const logs = await adminServerClient.getNotifications(event.id)

  // 참가자 알림 메일이 꺼져 일부러 보내지 않은 행은 발송·미전달(재발송 대상)에 넣지 않고 따로 센다.
  return (
    <AdminShell title="알림 관리" description={notificationLogSummary(logs)}>
      <NotificationsConsole
        logs={logs}
        eventId={event.id}
        timeZone={event.timezone}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
