// F-AU-001 통합 로그인 — FE↔백엔드 인증 경계(seam) 계약 (ADR-0011 folded login transaction).
// 아키텍처 경계 B(ADR-0008): Next.js는 DB/Cognito/DX Korea API에 직접 붙지 않고
// 이 AuthClient(=FastAPI 경유)만 호출한다. mock 구현(mock-auth-client)이 데모를 대신하고,
// 실연동은 HTTP 구현(http-auth-client, Next BFF route handler 경유)으로 스왑한다 — 화면 코드 불변.
//
// 로그인은 "접힌 트랜잭션" 2단계로 정의된다(ADR-0011):
//   startLogin    ← POST /api/auth/login/start    (자격검증 + 명단매핑 + 재방문/최초 분기)
//   completeLogin ← POST /api/auth/login/complete  (최초 진입자 약관 동의 → 세션 발급)
//   checkDeeplinkToken ← POST /api/auth/deeplink   (#20 딥링크 토큰 검증·프리필)
//   (role-branch는 순수 FE — lib/auth/role-branch.ts)
//
// HTTP JSON은 snake_case, 이 seam은 camelCase — 매핑은 http-auth-client 어댑터가 담당.

import type { ApplicationStatus, ParticipantGateInput } from "@/lib/auth/participant-gate"
import type { PermissionLevel } from "@/lib/mock/session"

export type AuthRole = "buyer" | "exhibitor" | "organizer"

// 딥링크 토큰 검증 결과. 만료/위조는 폼을 노출하지 않고 안내 화면으로 보낸다.
// 유효하면 토큰이 특정한 회원의 아이디(username)·이름(name)을 함께 돌려줘 폼에 프리필한다(비번만 입력).
export type DeeplinkCheck =
  | { status: "valid"; username: string; name: string }
  | { status: "expired" }
  | { status: "invalid" }

// 약관 문서(버전 스냅샷). required=필수(미동의 시 진행 불가), optional=선택.
export interface ConsentDocument {
  id: string
  title: string
  summary: string
  version: string
  required: boolean
  // 약관 전문(바텀시트에서 노출). 줄바꿈 포함 평문 — 동의 전 무엇에 동의하는지 읽게 한다(US7).
  content: string
}

// 로그인 직후 도착 분기에 쓰는 프로필(기업정보) 게이트 상태(ADR-0009). ParticipantGateInput와 동일 형상.
export type LoginGate = ParticipantGateInput
export type { ApplicationStatus }

// ── startLogin ────────────────────────────────────────────────────────────────
export interface StartLoginInput {
  username: string
  password: string
  // 딥링크 진입 토큰(있으면 프리필 편의로 전달). 신원의 닻은 토큰이 아니라 아이디/비번(D2).
  deeplinkToken?: string | null
}

// 자격검증 + 명단매핑 결과.
//  - rejected         : DX Korea 검증 실패(자격오류/잠금/업스트림 장애).
//  - not_found        : 검증은 통과했으나 적재 명단에 없음(주최측 문의 안내).
//  - succeeded        : 재방문자 — 약관 스킵, 세션 발급 완료 → 곧바로 도착 분기.
//  - consent_required : 최초 진입자 — loginTicket을 들고 약관 동의 스텝으로.
export type StartLoginResult =
  | { outcome: "rejected"; reason: "invalid_credentials" | "account_locked" | "upstream_unavailable" }
  | { outcome: "not_found" }
  | { outcome: "succeeded"; role: AuthRole; gate: LoginGate; permissionLevel?: PermissionLevel }
  | { outcome: "consent_required"; loginTicket: string; documents: ConsentDocument[] }

// ── completeLogin ───────────────────────────────────────────────────────────────
export interface CompleteLoginInput {
  // startLogin이 발급한 1회용 티켓. 동의 후 세션 발급 트랜잭션을 잇는다.
  loginTicket: string
  acceptedDocIds: string[]
}

// 약관 동의 → 세션 발급 결과.
//  - succeeded          : 동의 충족 + 세션 발급 → 도착 분기.
//  - consent_incomplete : 필수 미동의(FE가 미리 게이트하므로 정상 흐름에선 안 나와야 함).
//  - ticket_invalid     : 만료/소비/위조 티켓 — 처음부터 다시(자격 폼으로 복귀).
export type CompleteLoginResult =
  | { outcome: "succeeded"; role: AuthRole; gate: LoginGate; permissionLevel?: PermissionLevel }
  | { outcome: "consent_incomplete"; missingRequired: string[] }
  | { outcome: "ticket_invalid"; reason: "expired" | "consumed" | "forged" }

// 이미 발급된 NABI 세션(재방문자). 유효 딥링크/진입 시 폼 대신 "1탭 확인 후 진입"에 쓴다.
// 프로덕션은 서버에서 Cognito 세션을 읽어 구성, dev는 ?session= mock으로 시뮬레이션.
export interface ExistingSession {
  role: AuthRole
  name: string // 표시용 — "○○님으로 계속하기"
  gate: ParticipantGateInput // 도착 분기용(프로필 작성 vs 홈)
  permissionLevel?: PermissionLevel // 운영자 계정 선택 시 슈퍼/일반 어드민 구분
}

// 요청별 옵션. signal을 끊으면 진행 중인 요청도 끊긴다(HTTP 구현은 fetch에 그대로 넘긴다) — 화면이 그만둔 로그인
// 시도의 응답이 뒤늦게 도착해 그 계정의 세션 쿠키를 심지 못하게 한다. 끊긴 요청은 결과 없이 예외로 끝난다.
export interface AuthRequestOptions {
  signal?: AbortSignal
}

export interface AuthClient {
  // 딥링크 진입 토큰 검증(만료·위조·일회성). 토큰 없는 진입(운영사/로그아웃 복귀)은 호출하지 않는다.
  checkDeeplinkToken(token: string): Promise<DeeplinkCheck>
  // 1단계: 아이디/비번 검증 + 명단매핑 → 재방문(succeeded) / 최초(consent_required) / 거부 / 미존재.
  startLogin(input: StartLoginInput, options?: AuthRequestOptions): Promise<StartLoginResult>
  // 2단계: 최초 진입자 약관 동의 → 세션 발급. loginTicket으로 1단계 결과를 잇는다.
  completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult>
}
