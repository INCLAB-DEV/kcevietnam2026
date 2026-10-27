import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MemberDetail } from "@/components/organizer/member-detail"
import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { serverApiClient } from "@/lib/api-client/server"
import { kstNow } from "@/lib/clock"
import { hasApplication } from "@/lib/application-status"
import { indexOrgs, type AssignmentScheduleData } from "@/lib/organizer/assignment-schedule"
import { resolveOrganizerConsoleAccess } from "@/lib/organizer/console-access"
import { MEMBER_TAB_LABELS, type MemberRow } from "@/lib/organizer/members"

export const dynamic = "force-dynamic"

// OP-003 운영자용 기업 디테일(F-OP-003 / 이슈 #54). 프로필(조회) + 이 기업 미팅 일정 + 단일 기업
// 빈슬롯 보충(모드① 자동채움 / 모드② 추천→선택). OP-002 목록·OP-005 배정 허브 양쪽에서 같은 라우트로 진입.
// 크롬(사이드바)은 app/organizer/layout.tsx가 소유한다. 데이터는 api-client seam 경유(ADR-0008).
// org 프로필이 있는 기업(매칭 모집단)만 풀 상세, 그 외 명단행은 안내.
//
// 권한 갈래(ADR-0012 읽기 vs 거버넌스, 2026-09-17):
//  · master — 행사 전역 배정 그리드(getAssignmentSchedule)로 상세 + 보충(배정) 액션까지.
//  · sub — 조회 전용. 기업 단위 일정(getOrganizationSchedule, 관할 검사)만 읽는다: 자기 바이어·국내기업은
//    열리고, 다른 sub의 바이어는 403 → 콘솔 안 "열람 권한 없음" 안내. 배정 액션(자동채움·빈 슬롯)은 숨긴다.
//    참가사 일정을 열어도 자기 바이어와의 미팅만 보인다(백엔드가 관할로 좁혀 내려준다).
export default async function OrganizerMemberDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>
  searchParams: Promise<{ now?: string }>
}) {
  const { organizationId } = await params
  const { now: nowOverride } = await searchParams
  const now = kstNow(nowOverride)
  const access = await resolveOrganizerConsoleAccess()
  const canAssign = access.permissionLevel === "master"

  // OP-003 org 프로필은 운영자-real로 페치되는 배정 스케줄 로스터에서 집는다(discover getOrganization은
  // buyer/exhibitor 세션 전용이라 운영자 세션에선 mock으로 떨어져 실 승인기업을 못 찾던 버그 — 2026-09-09).
  const [member, scheduleResult] = await Promise.all([
    serverApiClient.getMember(organizationId),
    canAssign
      ? serverApiClient.getAssignmentSchedule().then((data) => ({ status: "ok" as const, data }))
      : serverApiClient.getOrganizationSchedule(organizationId),
  ])

  if (scheduleResult.status !== "ok") {
    return (
      <DetailFrame title={member?.name ?? "기업 디테일"} subtitle="OP-003 기업 디테일">
        {scheduleResult.status === "forbidden" ? (
          <OperatorStatePanel
            kind="forbidden"
            title="이 기업을 열람할 권한이 없습니다"
            description="다른 운영자가 관리하는 바이어입니다. 내가 관리하는 바이어와 국내기업만 열람할 수 있습니다."
            homeHref="/organizer/members"
            homeLabel="목록으로"
          />
        ) : (
          <OperatorStatePanel
            kind="not_found"
            title="해당 기업을 찾을 수 없습니다"
            homeHref="/organizer/members"
            homeLabel="목록으로"
          />
        )}
      </DetailFrame>
    )
  }

  return (
    <OrganizerMemberDetail
      organizationId={organizationId}
      member={member}
      schedule={scheduleResult.data}
      now={now}
      readOnly={!canAssign}
    />
  )
}

function OrganizerMemberDetail({
  organizationId,
  member,
  schedule,
  now,
  readOnly,
}: {
  organizationId: string
  member: MemberRow | null
  schedule: AssignmentScheduleData
  now: { date: string; time: string }
  readOnly: boolean
}) {
  // 이중역할 org 대비 member.tab을 우선하고, 못 찾으면 인덱스 폴백. "프로필 보유" 판정은 신청서 제출
  // 여부(hasApplication)로 — 백엔드가 상세를 주는 기준과 동일.
  const pool = member?.tab === "buyer" ? schedule.buyers : schedule.exhibitors
  const org =
    pool.find((o) => o.id === organizationId) ??
    indexOrgs(schedule)[organizationId] ??
    null
  const hasProfile = !!member && hasApplication(member.applicationStatus)

  const title = org?.name ?? member?.name ?? "기업 디테일"
  const subtitle = member ? `${MEMBER_TAB_LABELS[member.tab]} · OP-003 기업 디테일` : "OP-003 기업 디테일"

  return (
    <DetailFrame title={title} subtitle={subtitle}>
      {org && hasProfile ? (
        <MemberDetail org={org} member={member} data={schedule} now={now} readOnly={readOnly} />
      ) : member ? (
        <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
          이 기업은 아직 비즈매칭 프로필이 없어 일정·배정을 표시할 수 없습니다(명단 등록 단계). 프로필이 제출되면 미팅 일정과 빈슬롯 보충이 열립니다.
        </div>
      ) : (
        <OperatorStatePanel
          kind="not_found"
          title="해당 기업을 찾을 수 없습니다"
          homeHref="/organizer/members"
          homeLabel="목록으로"
        />
      )}
    </DetailFrame>
  )
}

function DetailFrame({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Button variant="ghost" size="sm" className="-ml-2 self-start text-muted-foreground" asChild>
          <Link href="/organizer/members">← 목록으로</Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>
      {children}
    </div>
  )
}
