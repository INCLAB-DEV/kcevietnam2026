// /admin 접근 판정의 순수 로직. 화면·레이아웃은 이 결과로 렌더/리다이렉트만 한다.
//
// 두 겹이다:
//  ① 라우트 게이트(proxy → lib/auth/route-guard): /admin/* 은 organizer 역할만 통과. 그 외 역할은
//     진입 전에 자기 홈으로 되돌려진다 — 여기까지는 역할(role) 판정.
//  ② 권한등급 게이트(이 모듈): organizer 안에서 master/sub를 가른다(ADR-0012). master=슈퍼어드민
//     (전체 CRUD), sub=서브어드민.
//
// ADR-0012 개정(2026-09-09): 기업 신청서 편집·대리작성(담당자 보강 포함)은 sub도 **관할 기업에
// 한해** 할 수 있게 열렸다. 그래서 sub의 권한은 두 축으로 갈린다:
//   · canEditOrgProfiles — 기업 신청서 편집/대리작성(관할 한정). master·sub 모두 true.
//   · canWrite — 거버넌스(행사 설정·역할 전환·운영자 부여 등). master만 true.
//     명단 업로드는 여기 속하지 않는다(발주자 지시 2026-09-16) — master·sub 공용이고, sub는 자기
//     바이어만 반영되도록 백엔드(app.roster.import_service 관할 검사)가 행 단위로 거른다.
// 관할 필터 자체(어떤 기업이 sub 관할인가)는 백엔드가 강제한다(require_event_operator +
// check_jurisdiction). 프론트 판정은 UX용 표현이며, 실연동 시 서버가 한 번 더 거절한다.

import type { AccountRole, PermissionLevel } from "@/lib/mock/session"

export interface AdminGuardSession {
  role: AccountRole
  permissionLevel?: PermissionLevel
}

export type AdminAccess =
  // 슈퍼어드민 — 모든 섹션 조회·수정.
  | { kind: "full"; canWrite: true; canEditOrgProfiles: true }
  // 서브어드민 — 기업 신청서는 관할 한정 편집 가능, 거버넌스는 조회만. 안내 배너를 띄운다.
  | { kind: "read-only"; canWrite: false; canEditOrgProfiles: true; notice: string }
  // 그 외 역할 — 진입 불가. 자기 홈으로 되돌린다.
  | { kind: "denied"; canWrite: false; canEditOrgProfiles: false; redirectTo: string }

const READ_ONLY_NOTICE =
  "서브어드민 계정은 관할 기업의 신청서 편집·대리작성과 자기 바이어 명단 업로드만 할 수 있습니다. 행사 설정·역할 전환·운영자 부여 등 거버넌스 작업은 조회만 가능합니다."

// 역할별 홈 — 참가자는 본 서비스 대시보드, 그 외는 로그인.
function homeFor(role: AccountRole): string {
  return role === "buyer" || role === "exhibitor" ? "/" : "/login"
}

export function resolveAdminAccess(session: AdminGuardSession): AdminAccess {
  if (session.role !== "organizer") {
    return { kind: "denied", canWrite: false, canEditOrgProfiles: false, redirectTo: homeFor(session.role) }
  }
  // permissionLevel 미상은 안전하게 sub로 떨어뜨린다 — 권한 미상이 곧 거버넌스 전권이 되면 안 된다
  // (default-deny). sub도 기업 신청서 편집은 되지만 거버넌스(canWrite)는 막힌다.
  if (session.permissionLevel !== "master") {
    return { kind: "read-only", canWrite: false, canEditOrgProfiles: true, notice: READ_ONLY_NOTICE }
  }
  return { kind: "full", canWrite: true, canEditOrgProfiles: true }
}

// 쓰기 가능 여부 단축 술어 — 컴포넌트가 액션 노출을 가를 때 쓴다.
export function canWriteAdmin(access: AdminAccess): boolean {
  return access.canWrite
}
