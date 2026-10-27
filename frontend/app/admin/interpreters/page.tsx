import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { InterpretersConsole } from "@/components/admin/interpreters-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 통역사 관리 — CRUD + 참가기업 배정(기업당 1명).
export default async function AdminInterpretersPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const [interpreters, organizations] = await Promise.all([
    adminServerClient.getInterpreters(event.id),
    adminServerClient.getOrganizations(event.id),
  ])

  return (
    <AdminShell
      title="통역사 관리"
      description={`통역사 ${interpreters.length}명 · 참가기업당 1명씩 배정합니다.`}
    >
      <InterpretersConsole
        interpreters={interpreters}
        organizations={organizations}
        eventId={event.id}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
