import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { OrganizationsConsole } from "@/components/admin/organizations-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 기업 관리 — 참가사·바이어 통합 테이블 + 신청서 전체 인라인 편집 + 대리작성.
// 목록·신청서 모두 서버에서 선택된 행사로 스코프해 내려보낸다 → 다른 행사 데이터가 애초에
// 클라 페이로드에 실리지 않는다(ADR-0001 경계).
export default async function AdminOrganizationsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access, actorName } = resolved.ctx

  const [organizations, profiles, settings] = await Promise.all([
    adminServerClient.getOrganizations(event.id),
    adminServerClient.getOrgProfiles(event.id),
    adminServerClient.getEventSettings(event.id),
  ])

  const unsubmitted = organizations.filter((o) => o.application_status === "registered").length

  return (
    <AdminShell
      title="기업 관리"
      description={`참가사·바이어 ${organizations.length}개사 · 신청서 미제출 ${unsubmitted}개사(대리작성 대상)`}
    >
      <OrganizationsConsole
        organizations={organizations}
        profiles={profiles}
        eventId={event.id}
        event={event}
        settings={settings}
        // ADR-0012 개정: 신청서 편집/대리작성은 sub도 관할 한정으로 가능(canEditOrgProfiles).
        readOnly={!access.canEditOrgProfiles}
        // 역할 전환 등 거버넌스는 master 전용(canWrite) — 백엔드도 master 전용 유지. 명단 업로드는
        // 여기서 갈리지 않는다(쓰기 가능한 운영자 master·sub 공용, sub 관할은 백엔드가 행 단위로 검사).
        canManageRoles={access.canWrite}
        actorName={actorName}
      />
    </AdminShell>
  )
}
