import { AssignmentHub } from "@/components/organizer/assignment-hub"
import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { serverApiClient } from "@/lib/api-client/server"
import { kstNow } from "@/lib/clock"
import { resolveOrganizerConsoleAccess } from "@/lib/organizer/console-access"

export const dynamic = "force-dynamic"

// 비즈매칭 배정 허브(OP-005 / F-OP-005). 스케줄 매트릭스(기업×슬롯) — 빈 슬롯을 직접 채우는 Forced와
// 우상단 전체 포화배정(일괄)을 한 화면에서. 크롬(사이드바)은 app/organizer/layout.tsx가 소유한다.
// 접근 제한의 권위는 백엔드 가드(require_event_master, ADR-0012) — 프론트 가드는 UX 표현이다.
// 데이터는 api-client seam 경유(ADR-0008): 추천 점수는 서버에서 계산, 화면은 selection만(ADR-0001).
// ?target= : OP-002 "개별 추천" 딥링크로 들어온 대상 기업(사전선택).
//
// 배정(일괄·강제)은 거버넌스라 master 전용이다(ADR-0012). sub가 URL로 직접 들어와도 master 전용 그리드를
// 부르지 않고(부르면 403 → 오류 화면) 콘솔 안에서 권한 안내를 그린다. nav에도 sub에겐 이 메뉴가 없다.
export default async function OrganizerForcedMatchingPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string; now?: string }>
}) {
  const access = await resolveOrganizerConsoleAccess()
  if (access.permissionLevel !== "master") {
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">비즈매칭 배정</h1>
        </header>
        <OperatorStatePanel
          kind="forbidden"
          title="매칭 배정은 슈퍼 운영자 전용입니다"
          description="일괄·강제 배정은 행사 전체 일정을 바꾸는 작업이라 슈퍼 운영자(master)만 할 수 있습니다. 관할 바이어의 미팅 현황은 매칭 현황과 참가기업 관리에서 확인해 주세요."
          homeHref="/organizer"
          homeLabel="매칭 현황으로"
        />
      </div>
    )
  }

  const { target, now: nowOverride } = await searchParams
  const data = await serverApiClient.getAssignmentSchedule()
  const now = kstNow(nowOverride)

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">비즈매칭 배정</h1>
        <p className="text-sm text-muted-foreground">
          기업별 슬롯 현황을 보고 빈 슬롯을 직접 채우거나(Forced), 전체 포화배정으로 한꺼번에 채웁니다.
          단일 기업 보충은 기업명을 눌러 상세에서 진행합니다.
        </p>
      </header>
      <AssignmentHub data={data} initialTargetId={target} now={now} />
    </div>
  )
}
