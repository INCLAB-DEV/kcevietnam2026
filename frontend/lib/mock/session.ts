// 데모용 mock 세션. 로그인 계정에 따라 화면이 달라지도록 role/user/orgId를 제공한다.
// TODO(슬라이스 2+): Cognito 세션(JWT)으로 교체. dev에서는 ?as= 쿼리로 계정 전환.
// 실연동 시 ?as 스위처는 제거하고 세션 토큰에서 role을 읽는다.

import type { Session as GuardSession } from "@/lib/auth/route-guard"
import type { ExistingSession } from "@/lib/auth/auth-types"
import type { ParticipantGateInput } from "@/lib/auth/participant-gate"
import type { ApplicationStatus } from "@/lib/bm/types"

export type AccountRole = "buyer" | "exhibitor" | "organizer"

export interface SessionUser {
  name: string
  affiliation: string
  email: string
  phone: string
}

// 운영자 권한등급(ADR-0012) — 계정×행사 단위. master=전역(승인·전체 CRUD), sub=자기 관할 한정.
export type PermissionLevel = "master" | "sub"

export interface MockSession {
  role: AccountRole
  orgId: string
  user: SessionUser
  // 비즈매칭 신청 상태(ADR-0009). 참가자(buyer/exhibitor)만 의미 있고 운영자는 undefined.
  // route-guard·/welcome이 이걸 보고 본 서비스 진입·랜딩 화면을 정한다.
  applicationStatus?: ApplicationStatus
  permissionLevel?: PermissionLevel // organizer 전용 — master/sub. 그 외 역할은 undefined.
  tradeOffice?: string // sub(무역관) 전용 — 관할 경계(이 무역관이 등록한 바이어만).
}

export const MOCK_ACCOUNTS: Record<AccountRole, MockSession> = {
  buyer: {
    role: "buyer",
    orgId: "buyer-1",
    applicationStatus: "registered", // dev 기본: 명단 등록만 된 신규 신청자(?status=로 전환)
    user: {
      name: "김바이어",
      affiliation: "서울콘텐츠파트너스",
      email: "buyer01@demo.nabi.local",
      phone: "010-1234-5678",
    },
  },
  exhibitor: {
    role: "exhibitor",
    orgId: "exh-1",
    applicationStatus: "registered", // dev 기본: 미제출(?status=submitted|approved|… 로 전환)
    user: {
      name: "이참가사",
      affiliation: "픽셀아츠 스튜디오",
      email: "exhibitor01@demo.nabi.local",
      phone: "010-2222-3333",
    },
  },
  organizer: {
    role: "organizer",
    orgId: "org-1",
    permissionLevel: "master", // 주최사 — 전역 권한(승인·전체 CRUD)
    user: {
      name: "정세훈",
      affiliation: "2026 베트남 K-콘텐츠 엑스포 사무국",
      email: "kcevietnam2026@gmail.com",
      phone: "010-9999-0000",
    },
  },
}

// sub(무역관) 운영자 — 자기 관할(소유 바이어)로 한정. 승인·전체 CRUD 불가(ADR-0012).
// dev 진입: ?as=organizer-sub. role은 organizer(권한등급만 다르다).
export const MOCK_ORGANIZER_SUB: MockSession = {
  role: "organizer",
  orgId: "org-sub-frankfurt",
  permissionLevel: "sub",
  tradeOffice: "KOTRA 프랑크푸르트무역관", // 관할 = 이 무역관이 등록한 바이어
  user: {
    name: "박무역",
    affiliation: "KOTRA 프랑크푸르트무역관",
    email: "frankfurt@kotra.or.kr",
    phone: "010-7777-8888",
  },
}

const DEFAULT_ROLE: AccountRole = "buyer"

function isAccountRole(value: unknown): value is AccountRole {
  return value === "buyer" || value === "exhibitor" || value === "organizer"
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    value === "registered" ||
    value === "submitted" ||
    value === "changes_requested" ||
    value === "approved" ||
    value === "rejected"
  )
}

// dev 전환 쿠키. proxy(미들웨어)가 ?as=/?status= 값을 여기로 미러링하고, 서버 컴포넌트는
// 이 쿠키들만 읽어 세션을 해석한다(페이지/셸이 같은 소스를 봐 divergence 방지).
// 실연동(Cognito) 시 이 dev 상태 쿠키 + 미러 분기만 제거하면 된다 — Cognito 세션 쿠키와 다른 이름.
export const DEV_AS_COOKIE = "nabi_dev_as"
export const DEV_STATUS_COOKIE = "nabi_dev_status" // 비즈매칭 application_status 오버라이드(dev)
export const DEV_PERIOD_COOKIE = "nabi_dev_period" // 신청기간 개폐 오버라이드(open|closed, dev)
// 참가자 메뉴 오버라이드(full|meetings_only, dev) — 목업 세션에는 행사 설정이 없어 기본값(미팅만)으로
// 보인다. 전체 메뉴(5개)의 화면을 목업으로 보려면 이 쿠키를 full로 명시한다. 위 셋과 달리 proxy가
// 쿼리에서 미러링하지 않는다(게이트 판정과 무관한 값이라 proxy를 건드리지 않았다) — 브라우저 콘솔에서
// `document.cookie = "nabi_dev_menu=full; path=/"` 로 심거나, 스캔 도구(ops/i18n-residue-scan,
// --menu full)가 직접 심는다. 지우면 기본값으로 돌아간다.
// 실 세션에는 적용하지 않는다(실 세션은 행사 설정이 권위 — lib/auth/participant-menu-server.ts).
export const DEV_MENU_COOKIE = "nabi_dev_menu"

// dev 계정 전환: ?as= 값으로 계정을 고른다. 알 수 없는 값은 기본(바이어)으로 폴백.
// ?as=organizer-sub면 sub 무역관 세션(권한등급만 다른 organizer). ?status= 가 유효 application_status면
// 계정 기본 상태를 덮어쓴다(참가자 한정 — 운영자는 무시).
export function resolveMockSession(as?: string | null, status?: string | null): MockSession {
  if (as === "organizer-sub") return MOCK_ORGANIZER_SUB
  const account = MOCK_ACCOUNTS[isAccountRole(as) ? as : DEFAULT_ROLE]
  if (account.role !== "organizer" && isApplicationStatus(status)) {
    return { ...account, applicationStatus: status }
  }
  return account
}

// 운영자 라우트 진입 세션 — 항상 organizer(role). ?as=organizer-sub면 sub, 그 외(organizer 포함)는 master.
// 운영자 라우트는 ?as=buyer 등으로 강등되지 않는다(역할은 항상 organizer, 권한등급만 가른다).
export function resolveOrganizerSession(as?: string | null): MockSession {
  return as === "organizer-sub" ? MOCK_ORGANIZER_SUB : MOCK_ACCOUNTS.organizer
}

// 라우트 가드용 세션. dev에서 ?as=guest는 미인증, 그 외는 인증된 계정으로 본다.
// 참가자는 application_status를 함께 실어 게이트가 승인 여부를 보게 한다.
// TODO: Cognito 세션(JWT)에서 인증·role·status를 읽도록 교체.
export function toGuardSession(as?: string | null, status?: string | null): GuardSession {
  if (as === "guest") return { authenticated: false }
  const session = resolveMockSession(as, status)
  return { authenticated: true, role: session.role, applicationStatus: session.applicationStatus }
}

// dev용 "이미 발급된 NABI 세션" 시뮬레이션 — 로그인 화면의 1탭 재진입을 시연하기 위해 ?session=로 주입.
// 프로덕션은 서버에서 Cognito 세션을 읽어 구성한다(이 mock 자리). 값이 없으면 세션 없음(null).
const EXISTING_SESSION_GATE: Record<AccountRole, ParticipantGateInput> = {
  buyer: { applicationStatus: "submitted", hasProfile: true },
  exhibitor: { applicationStatus: "submitted", hasProfile: true },
  organizer: { applicationStatus: "submitted", hasProfile: true },
}

function existingSessionFor(role: AccountRole): ExistingSession {
  const account = MOCK_ACCOUNTS[role]
  return {
    role: account.role,
    name: account.user.name,
    gate: EXISTING_SESSION_GATE[account.role],
    permissionLevel: account.permissionLevel,
  }
}

// ?session= 으로 최근 로그인 세션을 시뮬레이션. 쉼표로 여러 계정(공용 기기 등)도 표현 가능.
// 예: ?session=buyer 또는 ?session=buyer,organizer. 알 수 없는 값은 무시(중복 제거).
export function resolveExistingSessions(session?: string | null): ExistingSession[] {
  if (!session) return []
  const roles = session.split(",").map((s) => s.trim()).filter(isAccountRole)
  const unique = [...new Set(roles)]
  return unique.map(existingSessionFor)
}
