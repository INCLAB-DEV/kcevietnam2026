import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { EventSettingsConsole } from "@/components/admin/event-settings-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 행사 설정 — 미팅 시간 단위 / 신청기간 / 운영 정책(장소유형·동일역할 열람) /
// 참가사별 미팅 불가 시간대. 저장은 리소스별로 갈라 나간다(행사 vs 설정 — 백엔드 계약 그대로).
export default async function AdminSettingsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const [settings, organizations] = await Promise.all([
    adminServerClient.getEventSettings(event.id),
    adminServerClient.getOrganizations(event.id),
  ])

  if (!settings) {
    return (
      <AdminShell title="행사 설정" description={event.name}>
        <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
          이 행사의 설정을 찾을 수 없습니다. 행사 관리에서 행사를 다시 확인해 주세요.
        </div>
      </AdminShell>
    )
  }

  return (
    <AdminShell
      title="행사 설정"
      description={`${event.name} · 이 행사에만 적용되는 운영 정책입니다.`}
    >
      <EventSettingsConsole
        event={event}
        settings={settings}
        organizations={organizations}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
