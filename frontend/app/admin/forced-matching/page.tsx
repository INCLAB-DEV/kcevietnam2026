import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { AssignmentHub } from "@/components/organizer/assignment-hub"
import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { serverApiClient } from "@/lib/api-client/server"
import { kstNow } from "@/lib/clock"

export const dynamic = "force-dynamic"

// 행사 운영의 미팅 배정 — 기존 AssignmentHub를 슈퍼어드민 셸 안에서 재사용한다.
// /organizer/forced-matching으로 이동하지 않아 행사 스위처·권한 배너·관리자 nav가 유지된다.
//
// 배정(일괄·강제)은 거버넌스라 master 전용(ADR-0012). 서브어드민이 URL로 들어와도 master 전용 배정
// 그리드를 부르지 않고(403 → 오류 화면) 콘솔 안에서 권한 안내만 그린다. 사이드바에도 sub에겐 없는 메뉴다.
export default async function AdminForcedMatchingPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string; now?: string }>
}) {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)

  if (!resolved.ctx.access.canWrite) {
    return (
      <AdminShell title="미팅 배정">
        <OperatorStatePanel
          kind="forbidden"
          title="미팅 배정은 슈퍼어드민 전용입니다"
          description="일괄·강제 배정은 행사 전체 일정을 바꾸는 작업이라 슈퍼어드민(master)만 할 수 있습니다."
          homeHref="/admin"
          homeLabel="대시보드로"
        />
      </AdminShell>
    )
  }

  const { target, now: nowOverride } = await searchParams
  const data = await serverApiClient.getAssignmentSchedule()
  const now = kstNow(nowOverride)

  return (
    <AdminShell
      title="미팅 배정"
      description="기업별 슬롯 현황을 확인하고 행사 미팅을 배정합니다."
    >
      <AssignmentHub data={data} initialTargetId={target} now={now} />
    </AdminShell>
  )
}
