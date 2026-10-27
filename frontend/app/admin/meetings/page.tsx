import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { MeetingsConsole } from "@/components/admin/meetings-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 미팅 관리 — 전체 미팅 조회 + 운영자 강제 취소.
export default async function AdminMeetingsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access, actorName } = resolved.ctx

  const meetings = await adminServerClient.getMeetings(event.id)
  const scheduled = meetings.filter((m) => m.status === "scheduled").length

  return (
    <AdminShell
      title="미팅 관리"
      description={`전체 ${meetings.length}건 · 예정 ${scheduled}건. 예정 건은 운영자가 사유와 함께 취소할 수 있습니다.`}
    >
      <MeetingsConsole
        meetings={meetings}
        eventId={event.id}
        readOnly={!access.canWrite}
        actorName={actorName}
      />
    </AdminShell>
  )
}
