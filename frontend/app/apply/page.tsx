import { redirect } from "next/navigation"
import { ApplyForm } from "@/components/apply/apply-form"
import { HelpButton } from "@/components/help/help-button"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"
import type { ProfileSeed } from "@/lib/apply/buyer-profile-store"

export const dynamic = "force-dynamic"

// BM-001 — 바이어 프로필 작성(3단계)/제출/완료. 진입 경로(F-BM-001 D-진입):
//  - 딥링크 로그인 후 바이어(프로필 미작성 안내)
//  - BM-004 항목별 수정(?step=N) — 특정 단계 직접 진입
// 참가사는 F-BM-002(별도 폼), 운영자는 해당 없음 → 리다이렉트.
// 미인증 접근은 route-guard가 /login으로 차단한다(인증 바이어 전용).
//
// 저장/조회/제출은 실 세션이면 FastAPI 경유(ADR-0008, BM-001 실배선) — exhibitor/apply/page.tsx와
// 동일 패턴으로 resolveHttpSession()+fetchMe()에서 바이어 role의 org_event_role_id·isReal을 도출해
// ApplyForm에 내려준다. mock/dev(?as=buyer)는 기존 그대로 resolveRequestSession() 기반.
export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>
}) {
  const { step } = await searchParams
  const session = await resolveRequestSession()
  const realSession = await resolveHttpSession()
  // 역할 가드는 real 세션이면 로그인 BFF가 심은 역할 쿠키를 따른다(exhibitor/apply/page.tsx와 동일 원칙) —
  // resolveRequestSession()은 dev 전환 쿠키(?as=) 기반 mock 세션이라 real 세션에선 기본값(buyer)으로
  // 고정돼, 이 보정이 없으면 real exhibitor가 /apply로 잘못 튕겨나간다.
  const role = realSession?.role ?? session.role

  // 참가사/운영자는 BM-001 대상이 아니다.
  if (role === "organizer") redirect("/organizer")
  if (role === "exhibitor") redirect("/exhibitor/profile")

  const initialStepParam = step != null ? Number(step) : undefined

  // org_event_role_id — 실 세션이면 fetchMe()에서 바이어 role의 실 UUID를 도출(exhibitor/apply/page.tsx와
  // 동일 패턴), 없으면 mock 세션 orgId(mock 스토어의 키)로 폴백. isReal은 그 실 UUID 확보 여부로 정한다
  // (ApplyForm이 이 값으로 getBuyerClient(isReal)를 골라 실 백엔드/mock을 선택).
  const me = realSession ? await fetchMe() : null
  const buyerRole = me?.roles.find((r) => r.is_buyer) ?? null
  const isReal = !!buyerRole?.org_event_role_id
  const orgEventRoleId = buyerRole?.org_event_role_id ?? session.orgId

  // status는 실 세션이면 fetchMe()의 바이어 role.application_status(유효값만, 아니면 registered
  // 폴백, exhibitor/apply/page.tsx와 동일 원칙) — mock 세션은 기존 그대로 세션에서(폴백 registered).
  const rawStatus = buyerRole?.application_status
  const isValidStatus =
    rawStatus != null && (APPLICATION_STATUSES as readonly string[]).includes(rawStatus)
  const applicationStatus: ApplicationStatus = realSession
    ? isValidStatus
      ? (rawStatus as ApplicationStatus)
      : "registered"
    : (session.applicationStatus ?? "registered")

  // 인증 바이어 — 명단/세션이 가진 식별 정보를 신청서에 미리 채운다(재입력 방지, F-BM-001 US3).
  // 데모 소스는 세션(name·affiliation·email·phone) = 명단 등록 정보. 실 세션은 프리필 없이(seed
  // 미전달) 사용자가 직접 채우게 한다 — 실사용자에게 가짜 회사명·연락처를 보여주지 않는다
  // (exhibitor/apply/page.tsx와 동일 원칙). 영문명·직위·국가 등은 주관사 명단 컬럼 확정 후 매핑(HITL 블로커).
  const seed: ProfileSeed | undefined = isReal
    ? undefined
    : {
        organizationNameKo: session.user.affiliation,
        contactNameKo: session.user.name,
        contactEmail: session.user.email,
        tel: session.user.phone,
      }

  // 인증 바이어 신청서 — 단독 화면(AppShell 밖, ADR-0002). 상태 안내·라우팅은 /welcome이 담당,
  // 이 페이지는 폼만. 진입 자격(신청기간 중 AND registered|changes_requested)은 route-guard가 강제.
  return (
    <main className="min-h-svh bg-background px-4 py-8 sm:py-12">
      <ApplyForm
        profileKey={session.orgId}
        orgEventRoleId={orgEventRoleId}
        isReal={isReal}
        seed={seed}
        initialStepParam={initialStepParam}
        applicationStatus={applicationStatus}
      />
      {/* 단독 화면(AppShell 밖)이라 셸 도움말이 없다 — 바이어 신청서 도움말을 직접 얹는다(F-HELP). */}
      <HelpButton role="buyer" />
    </main>
  )
}
