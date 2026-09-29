import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { NotificationsConsole } from "@/components/admin/notifications-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 알림 관리 — 6종 타입 × 2채널(인앱/이메일) 발송 이력 + 수동 재발송.
export default async function AdminNotificationsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const logs = await adminServerClient.getNotifications(event.id)
  const failed = logs.filter((l) => !l.delivered).length

  return (
    <AdminShell
      title="알림 관리"
      description={`발송 ${logs.length}건${failed > 0 ? ` · 미전달 ${failed}건(재발송 대상)` : ""}`}
    >
      <NotificationsConsole
        logs={logs}
        eventId={event.id}
        timeZone={event.timezone}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
