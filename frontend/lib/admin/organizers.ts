// 운영자(회원 역할) 관리의 순수 규칙.
//
// 권한 부여 정책(발주 확정):
//   · **슈퍼어드민(master)은 DB에서만 부여한다.** 이 콘솔에는 부여 경로가 없다 — 관리자 페이지에서
//     최고 권한을 만들 수 있으면, 한 번 뚫린 서브어드민 계정이 스스로를 슈퍼어드민으로 올릴 수
//     있게 된다(권한 상승). 그래서 UI·타입·액션 세 겹에서 모두 막는다.
//   · 서브어드민(sub)은 슈퍼어드민이 이 화면에서 부여·회수한다.
//
// master 회수도 막는다: 부여할 수 없는 권한을 회수만 할 수 있으면 마지막 슈퍼어드민을 지우고
// 아무도 콘솔에 못 들어가는 상태를 만들 수 있다(복구는 DB 작업뿐).

import type { AdminOrganizer, AdminPermissionLevel } from "./types"

// UI에 항상 노출하는 정책 문구. 화면 여러 곳에서 같은 문장을 쓰도록 한 곳에 둔다.
export const MASTER_GRANT_NOTICE =
  "슈퍼어드민(master) 권한은 데이터베이스에서 직접 부여됩니다 — 이 화면에서는 서브어드민만 관리할 수 있습니다."

// 이 콘솔에서 부여 가능한 권한등급 — sub 하나뿐.
export const GRANTABLE_LEVELS: readonly AdminPermissionLevel[] = ["sub"]

export function canGrantLevel(level: AdminPermissionLevel): boolean {
  return level === "sub"
}

// 회수 가능 여부 — sub만. master는 DB 소관이라 화면에서 건드리지 않는다.
export function canRevoke(organizer: Pick<AdminOrganizer, "permission_level">): boolean {
  return organizer.permission_level === "sub"
}

// 부여 대상 = 가입된 회원의 **로그인 이메일**(2026-09-17). 회원 UUID 입력은 없앴다 — 운영자가 UUID를
// 알 길이 없고, 오타 난 UUID가 그대로 유령 운영자 행이 됐다. 회원 존재 여부는 서버가 판정한다(404).
export type OrganizerGrantError =
  | "email-required"
  | "email-invalid"
  | "level-not-grantable"
  | "duplicate-member"

export const ORGANIZER_ERROR_MESSAGES: Record<OrganizerGrantError, string> = {
  "email-required": "부여할 회원의 로그인 이메일을 입력해 주세요.",
  "email-invalid": "이메일 형식이 올바르지 않습니다.",
  "level-not-grantable": MASTER_GRANT_NOTICE,
  "duplicate-member": "이미 이 행사의 운영자로 등록된 회원입니다.",
}

// 서버 거절 코드(POST .../organizers, app/admin/router.py create_organizer) → 안내 문구.
const GRANT_SERVER_ERROR_MESSAGES: Record<string, string> = {
  MEMBER_NOT_FOUND: "해당 이메일로 가입한 회원이 없습니다. 회원가입을 마친 계정의 로그인 이메일인지 확인해 주세요.",
  ORGANIZER_ALREADY_ASSIGNED: "이미 이 행사의 운영자로 등록된 회원입니다.",
  http_403: "운영자 권한 부여는 슈퍼어드민만 할 수 있습니다.",
  http_422: "입력값을 확인해 주세요. 서브어드민 권한만 부여할 수 있습니다.",
}

export function grantServerErrorMessage(code: string | undefined): string {
  return (code && GRANT_SERVER_ERROR_MESSAGES[code]) || "권한을 부여하지 못했어요. 잠시 후 다시 시도해 주세요."
}

// 부여 성공 안내 — 서브어드민이 실제로 할 수 있는 일(ADR-0012 개정: 관할 한정 편집·대리작성, 거버넌스 불가).
// 예전 문구("콘솔을 조회만 할 수 있습니다")는 2026-09-09 개정 이후 사실과 달랐다.
export const SUB_GRANT_CAPABILITY_NOTICE =
  "서브어드민은 자기가 관리하는 바이어의 등록·신청서 대리작성과 매칭 현황 조회를 할 수 있고, 승인·배정·운영자 관리는 할 수 없습니다."

export type OrganizerGrantValidation =
  | { valid: true; email: string }
  | { valid: false; errors: OrganizerGrantError[] }

// 로그인 이메일 최소 형식(공백 없음 · @ 하나 · 도메인에 점) — 최종 판정은 서버의 회원 조회다.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 부여 입력 검증. level을 함께 받아 sub 이외는 여기서 거른다(타입으로도 막지만, 런타임 유입
// — 예: 폼 문자열·API 응답 — 을 한 번 더 방어). 이메일은 대소문자 무시로 중복을 본다(서버 조회와 같은 규칙).
export function validateOrganizerGrant(
  emailInput: string,
  level: AdminPermissionLevel,
  existing: AdminOrganizer[],
): OrganizerGrantValidation {
  const email = emailInput.trim()
  const errors: OrganizerGrantError[] = []

  if (!email) errors.push("email-required")
  else if (!EMAIL_PATTERN.test(email)) errors.push("email-invalid")
  if (!canGrantLevel(level)) errors.push("level-not-grantable")
  const normalized = email.toLowerCase()
  if (email && existing.some((o) => o.email.trim().toLowerCase() === normalized)) {
    errors.push("duplicate-member")
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, email }
}

// 정렬: 슈퍼어드민을 위로(참조용), 그 다음 서브어드민을 부여 시각 순으로.
export function sortOrganizers(rows: AdminOrganizer[]): AdminOrganizer[] {
  return [...rows].sort(
    (a, b) =>
      (a.permission_level === "master" ? 0 : 1) - (b.permission_level === "master" ? 0 : 1) ||
      a.granted_at.localeCompare(b.granted_at),
  )
}
