import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { AdminDashboardView } from "@/components/admin/dashboard-view"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 슈퍼어드민 콘솔 랜딩 — 선택된 행사의 요약(조회 전용).
//
// 접근: 라우트 가드(proxy → route-guard)가 organizer 역할만 통과시키고, 권한등급(master/sub)은
// 셸이 가른다(lib/admin/guard). 접근 제한의 권위는 백엔드(require_event_master, ADR-0012)이며
// 프론트 판정은 UX 표현이다.
//
// 데이터: server-only read seam 경유(ADR-0001/0008). 실연동 시 adminServerClient 1개만 교체한다.
export default async function AdminDashboardPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const [data, settings] = await Promise.all([
    adminServerClient.getDashboard(event.id),
    adminServerClient.getEventSettings(event.id),
  ])

  return (
    <AdminShell
      title="슈퍼어드민 대시보드"
      description={`${event.name} · 시스템 전반의 데이터와 정책을 조회·관리합니다.`}
    >
      <AdminDashboardView data={data} event={event} settings={settings} canWrite={access.canWrite} />
    </AdminShell>
  )
}
