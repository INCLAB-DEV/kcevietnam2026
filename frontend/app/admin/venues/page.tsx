import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { VenuesConsole } from "@/components/admin/venues-console"
import { adminServerClient } from "@/lib/admin/server"

export const dynamic = "force-dynamic"

// 미팅 장소 관리 — 매칭존 테이블·비즈니스 룸 CRUD(부스는 미팅 신청 시 자동 생성이라 대상 아님).
export default async function AdminVenuesPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx

  const venues = await adminServerClient.getVenues(event.id)

  return (
    <AdminShell
      title="미팅 장소 관리"
      description={`장소 ${venues.length}곳 · 라벨 순서가 곧 자동 배정 순서입니다.`}
    >
      <VenuesConsole venues={venues} eventId={event.id} readOnly={!access.canWrite} />
    </AdminShell>
  )
}
