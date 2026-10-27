import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { OrganizersConsole } from "@/components/admin/organizers-console"
import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 운영자 관리 — 이 행사의 운영자 목록 + 서브어드민 부여·회수.
// 슈퍼어드민(master)은 DB에서만 부여한다 — 이 화면에는 부여 경로가 없다(lib/admin/organizers).
//
// 운영자 목록·부여·회수는 거버넌스라 master 전용 API다(ADR-0012). 서브어드민이 URL로 들어와도 목록을
// 부르지 않고(403 → 오류 화면) 콘솔 안에서 권한 안내만 그린다. 사이드바에도 sub에겐 없는 메뉴다.
export default async function AdminOrganizersPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  if (!access.canWrite) {
    return (
      <AdminShell title="운영자 관리">
        <OperatorStatePanel
          kind="forbidden"
          title="운영자 관리는 슈퍼어드민 전용입니다"
          description="운영자 권한 부여·회수와 운영자 목록은 슈퍼어드민(master)만 볼 수 있습니다."
          homeHref="/admin"
          homeLabel="대시보드로"
        />
      </AdminShell>
    )
  }

  const organizers = await adminServerClient.getOrganizers(event.id)

  return (
    <AdminShell
      title="운영자 관리"
      description={`${event.name}의 관리자 계정과 권한등급을 관리합니다.`}
    >
      <OrganizersConsole
        organizers={organizers}
        eventId={event.id}
        timeZone={event.timezone}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
