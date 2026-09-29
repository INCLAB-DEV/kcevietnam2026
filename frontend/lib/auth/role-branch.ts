// 로그인 완료 후 도착 라우트 분기 (F-AU-001 deep module: role-branch / #22, FE ADR-0002 갱신).
// 역할만 보고 도착 라우트를 정하는 순수 함수.
//  - 운영사 → /organizer (OP-001)
//  - 참가사/바이어 → /welcome (HM-002) — 입장 전 단독 랜딩이 application_status×신청기간을 보고
//    안내·동선(작성/검토중/승인/입장/반려/마감)을 고른다. 종전 "프로필 게이트로 홈/프로필 직접 분기"는
//    /welcome으로 흡수됐다(resolveWelcomeView가 participant-gate의 status→화면 매핑을 대체).

import type { AuthRole, ApplicationStatus } from "./auth-types"

// 역할 → 도착 경로(순수). 참가자는 자격(application_status)과 무관하게 입장 전 랜딩으로 보내고,
// 거기서 무엇을 보여줄지는 /welcome이 세션 상태로 정한다(책임 분리).
export function postLoginPath(role: AuthRole): string {
  return role === "organizer" ? "/organizer" : "/welcome"
}

// dev 착지 URL — mock 세션 전용 화면(프로필 등, 아직 실 세션 미지원)이 역할(?as)·상태(?status)를
// 읽게 시드한다. 로그인 결과의 application_status를 ?status로 함께 실어, proxy가 nabi_dev_status
// 쿠키로 미러링하면 /welcome·apply 게이트가 실제 상태(예: submitted)를 본다(없으면 계정 기본값).
// 운영자는 status 무의미 → 생략.
//
// P1-1(실 세션): seedDevSession=false(HTTP 실연동 로그인)면 이 시드를 아예 안 붙인다 — 로그인 BFF가
// 이미 실 세션 쿠키(nabi_session/_role/_status)를 심었으므로 proxy 게이트는 그걸로 충분하고, 여기서
// ?as를 더 붙이면 "dev 스위처가 실 세션보다 우선"이라는 규칙 때문에 방금 로그인한 실 세션이 오히려
// 가려진다(예전 TODO: "Cognito 세션이 붙으면 ?as/?status 시드를 제거" — 이제 그 시점이다). 단, 아직
// 실 세션을 모르는 화면(예: /profile)은 이 시드가 없으면 기본 mock으로 보인다 — 알려진 한계.
export function landingHref(
  role: AuthRole,
  applicationStatus?: ApplicationStatus | null,
  options?: { seedDevSession?: boolean }
): string {
  const path = postLoginPath(role)
  if (options?.seedDevSession === false) return path
  const base = `${path}?as=${role}`
  return applicationStatus && role !== "organizer" ? `${base}&status=${applicationStatus}` : base
}
