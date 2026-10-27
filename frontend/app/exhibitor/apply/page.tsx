import { redirect } from "next/navigation"
import { resolveRequestSession, requestPeriodOverride } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { ExhibitorApplyForm } from "@/components/exhibitor/apply-form"
import type { RegistrantInfo } from "@/lib/bm/registrant-prefill"
import { DEMO_REGISTRANT, DEMO_REVIEW_NOTE } from "@/lib/bm/demo-profile"
import { HelpButton } from "@/components/help/help-button"
import { stepFromQuery } from "@/lib/bm/profile-form-state"
import { isApplicationOpen, resolveApplicationPeriod } from "@/lib/bm/application-period"
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"

export const dynamic = "force-dynamic"

// 비즈매칭 신청기간 — ⚠ 권위 출처는 Event DB(events.application_start / application_end, 이미 존재).
// 실연동 시 FastAPI가 행사에서 내려준다. 데모는 env 임시 주입(미설정 시 항상 열림). 실값: 8/26~9/11.
const APP_OPENS_AT = process.env.BM_APPLICATION_OPENS_AT ?? "2000-01-01"
const APP_CLOSES_AT = process.env.BM_APPLICATION_CLOSES_AT ?? "2999-12-31"
const DEV_PREVIEW = process.env.NODE_ENV !== "production"

function kstToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
}

// BM-002 참가사 프로필 작성 — 5단계 폼(기본정보·전시품목·회사소개·타겟담당자·완료). 단독 화면(AppShell 밖).
// 명단에만 등록된 참가사를 비즈매칭 참가자로 전환하는 승격 게이트(F-BM-002). 상태 안내·라우팅은 /welcome,
// 이 페이지는 폼만(책임 분리, ADR-0002). 진입 자격(신청기간 중 AND registered|changes_requested)은
// route-guard가 강제 — 미충족은 /welcome으로 리다이렉트되므로 여기 도달 시 작성 가능 상태다.
// 저장/조회/제출은 전부 FastAPI 경유(ADR-0008) — #26 백엔드 연동 전엔 mock 클라이언트로 렌더.
// dev 계정/상태 전환: /exhibitor/apply?as=exhibitor&status=changes_requested (proxy가 쿠키로 미러).
export default async function ExhibitorApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>
}) {
  // 세션은 쿠키에서 읽는다 — ?as/?status는 proxy가 쿠키로 미러링 후 URL에서 제거하므로 searchParams에 없다.
  const session = await resolveRequestSession()
  const realSession = await resolveHttpSession()
  // 역할 가드는 real 세션이면 로그인 BFF가 심은 역할 쿠키를 따른다(exhibitor/profile/page.tsx와 동일 원칙) —
  // resolveRequestSession()은 dev 전환 쿠키(?as=) 기반 mock 세션이라 real 세션에선 기본값(buyer)으로
  // 고정돼, 이 보정이 없으면 real exhibitor가 /profile 로 잘못 튕겨나간다.
  const role = realSession?.role ?? session.role
  // 참가사 전용(접근 권한) — 바이어는 BM-001, 운영자는 작성 대상 아님.
  if (role === "organizer") redirect("/organizer")
  if (role === "buyer") redirect("/profile")

  const { step } = await searchParams

  // org_event_role_id — 실 세션이면 fetchMe()에서 참가사 role의 실 UUID를 도출(exhibitor-profile-hub와
  // 동일 패턴), 없으면 mock 세션 orgId(mock 스토어의 키)로 폴백. isReal은 그 실 UUID 확보 여부로 정한다
  // (ExhibitorApplyForm이 이 값으로 getExhibitorClient(isReal)를 골라 실 백엔드/mock을 선택).
  const me = realSession ? await fetchMe() : null
  const exhibitorRole = me?.roles.find((r) => r.is_exhibitor) ?? null
  const isReal = !!exhibitorRole?.org_event_role_id
  const orgEventRoleId = exhibitorRole?.org_event_role_id ?? session.orgId

  // 제출 후 잠금(BM-005 반전, ADR-0002): 작성/수정 = 신청기간 중 AND status ∈ {registered, changes_requested}.
  // route-guard가 진입을 막지만 폼도 같은 기준으로 canEdit을 계산한다(방어적 일치). 기간은 env + dev 오버라이드.
  // status는 실 세션이면 fetchMe()의 exhibitor role.application_status(유효값만, 아니면 registered 폴백,
  // welcome/page.tsx와 동일 원칙) — mock 세션은 기존 그대로 세션에서(폴백 registered).
  const rawStatus = exhibitorRole?.application_status
  const isValidStatus =
    rawStatus != null && (APPLICATION_STATUSES as readonly string[]).includes(rawStatus)
  const status: ApplicationStatus = realSession
    ? isValidStatus
      ? (rawStatus as ApplicationStatus)
      : "registered"
    : (session.applicationStatus ?? "registered")
  const periodOverride = DEV_PREVIEW ? await requestPeriodOverride() : null
  const period = resolveApplicationPeriod({
    override: periodOverride,
    opensAt: APP_OPENS_AT,
    closesAt: APP_CLOSES_AT,
  })
  const canEdit =
    isApplicationOpen(kstToday(), period) &&
    (status === "registered" || status === "changes_requested")

  // changes_requested면 운영자 보완 요청 메모를 폼 상단 배너로 보여준다(무엇을 고쳐야 하는지 안내).
  // 실 세션은 organization_event_roles.review_note가 아직 fetchMe 응답에 없어 undefined(하드코딩 데모 메모 금지).
  const reviewNote = isReal ? undefined : status === "changes_requested" ? DEMO_REVIEW_NOTE : undefined

  // registrant: 행사 등록(명단/로스터) 정보 — 1단계 기본정보를 자동 프리필한다(실연동 시 registrants.raw 매핑).
  // ⚠ 확인 필요(HITL): "행사 등록 시 자동 채워지는 필드"의 실제 집합·출처는 주최사 명단 컬럼 확정 후
  //   닫힌다. 아직 실 데이터 원천이 없으므로 실 세션은 회사·부스 등 로스터 스칼라 필드는 프리필하지
  //   않는다 — 실사용자에게 가짜 회사명·대표자명을 보여주지 않는다. mock 모드는 기존 데모값 유지.
  //   단, 담당자(attendees)는 예외(2026-09-12, 발주자 결정): 가입 시 이미 확보된 회원 본인 정보
  //   (member_name/email/phone, GET /api/me)이므로 가짜값이 아니다 — 신청서에 담당자가 0명일 때
  //   buildRegistrantPrefill이 이 정보로 첫 담당자 초안을 채운다(사용자가 지우고 다시 입력 가능).
  const realRegistrant: RegistrantInfo | undefined =
    isReal && me && (me.member_name || me.member_email || me.member_phone)
      ? {
          contactNameKo: me.member_name ?? undefined,
          contactTitle: me.member_title ?? undefined,
          contactEmail: me.member_email ?? undefined,
          contactPhone: me.member_phone ?? undefined,
        }
      : undefined

  return (
    <main className="min-h-svh bg-background px-4 py-8 sm:py-12">
      <ExhibitorApplyForm
        orgEventRoleId={orgEventRoleId}
        isReal={isReal}
        initialStep={stepFromQuery(step ?? null)}
        canEdit={canEdit}
        reviewNote={reviewNote}
        applicationStatus={status}
        // 목업 세션의 등록정보는 가상 데모값(lib/bm/demo-profile.ts) — 실 세션에는 쓰지 않는다.
        registrant={isReal ? realRegistrant : DEMO_REGISTRANT}
      />
      {/* 단독 화면(AppShell 밖)이라 셸 도움말이 없다 — 참가사 신청서 도움말을 직접 얹는다(F-HELP). */}
      <HelpButton role="exhibitor" />
    </main>
  )
}
