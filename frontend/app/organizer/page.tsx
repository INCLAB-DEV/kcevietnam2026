import { OpsDashboardView } from "@/components/organizer/dashboard"
import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { serverApiClient } from "@/lib/api-client/server"
import { operatorErrorKind } from "@/lib/auth/operator-errors"
import { resolveOrganizerConsoleAccess } from "@/lib/organizer/console-access"
import type { OpsDashboard } from "@/lib/api-client/types"

export const dynamic = "force-dynamic"

// 운영사 랜딩(OP-001 / F-OP-001) — 매칭 현황 대시보드(읽기 전용). 로그인 직후 착지점.
// 크롬(사이드바·신원·로그아웃)은 app/organizer/layout.tsx가 소유한다 — 이 페이지는 본문만.
// 접근 제한의 권위는 백엔드 가드(require_event_operator, ADR-0012) — 프론트 가드는 UX 리다이렉트.
// 집계는 seam 뒤(서버)에서만 — 실연동 시 FastAPI 집계로 교체(ADR-0008 경계 B). 호출처는 그대로.
//
// master는 행사 전역, sub(무역관)는 자기가 관리하는 바이어의 매칭 활동만 받는다(응답 scope). 백엔드가
// 아직 sub를 403으로 막는 구버전이어도(배포 순서 어긋남) 착지 화면이 오류로 무너지지 않게, 권한 거절은
// 이 자리에서 안내로 바꾼다 — 그 외 실패는 error.tsx(레이아웃 안)로 올린다.
export default async function OrganizerPage() {
  const access = await resolveOrganizerConsoleAccess()
  let data: OpsDashboard
  try {
    data = await serverApiClient.getOpsDashboard()
  } catch (error) {
    if (operatorErrorKind(error) !== "forbidden") throw error
    return (
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
        <OperatorStatePanel
          kind="forbidden"
          title="매칭 현황을 불러올 권한이 없습니다"
          description="이 계정의 운영자 권한으로는 매칭 현황을 볼 수 없습니다. 참가기업 관리에서 관할 기업을 확인해 주세요."
          homeHref="/organizer/members"
          homeLabel="참가기업 관리로"
        />
      </div>
    )
  }
  return <OpsDashboardView data={data} canManageAssignments={access.permissionLevel === "master"} />
}
