// F-AU-001 인증 경계의 데모(mock) 구현. 실연동(http-auth-client) 전까지 AuthClient 자리를 대신한다.
// 6/17 컨셉 데모는 목업 — 로그인(접힌 트랜잭션) + 아이디/비번 검증 + 약관 + 역할 분기 흐름만 시연.
// 실연동 시 동일 인터페이스의 HTTP 구현으로 스왑하면 화면 코드는 바뀌지 않는다.
//
// 접힌 트랜잭션(ADR-0011): startLogin(자격검증+분기) → 최초자면 completeLogin(약관→세션).
// 운영사 계정은 별도 내부 경로(D5)지만, 기존 데모/테스트 유지를 위해 mock은 organizer를 함께 지원한다.

import type {
  AuthClient,
  CompleteLoginInput,
  CompleteLoginResult,
  ConsentDocument,
  DeeplinkCheck,
  StartLoginInput,
  StartLoginResult,
  AuthRole,
} from "./auth-types"
import type { ApplicationStatus } from "@/lib/auth/participant-gate"
import { requiredDocIds } from "@/lib/auth/consent"

// 데모 딥링크 토큰 — 만료/위조 안내 화면을 시연하기 위한 센티넬. 그 외 비어있지 않은 토큰은 유효로 본다.
const EXPIRED_TOKEN = "expired"
const INVALID_TOKEN = "invalid"

interface DemoAccount {
  memberId: string
  name: string // 회원 이름 — 딥링크 프리필 폼 안내 문구에 쓴다
  role: AuthRole
  firstTime: boolean // true=최초 진입(약관 스텝), false=재방문(약관 스킵)
  applicationStatus: ApplicationStatus // 기업정보(프로필) 게이트 상태
  hasProfile: boolean // 프로필 작성 완료 여부
  permissionLevel?: "master" | "sub" // 운영자 권한등급
}

// DX Korea 인증 어댑터(#21) 대역. 비번은 데모 공통값으로 검증, 그 외는 실패.
// 도착 분기 시연용 — 기업정보 미입력(registered/false)=프로필 작성으로, 입력완료(submitted/true)=홈으로.
const DEMO_PASSWORD = "demo1234"
const DEMO_ACCOUNTS: Record<string, DemoAccount> = {
  // 최초 진입 + 기업정보 미입력 → 약관 후 프로필 작성(/profile)
  buyer: { memberId: "mbr-buyer-01", name: "김바이어", role: "buyer", firstTime: true, applicationStatus: "registered", hasProfile: false },
  // 재방문 + 프로필 완료 → 약관 스킵, 홈(/)
  "buyer-old": { memberId: "mbr-buyer-02", name: "이재방", role: "buyer", firstTime: false, applicationStatus: "submitted", hasProfile: true },
  // 재방문이지만 기업정보 미입력 → 약관 스킵, 프로필 작성(/profile)
  "buyer-wip": { memberId: "mbr-buyer-03", name: "박미완", role: "buyer", firstTime: false, applicationStatus: "registered", hasProfile: false },
  // 참가사 최초 진입 + 미입력 → 약관 후 참가사 프로필 작성(/exhibitor/profile)
  exhibitor: { memberId: "mbr-exh-01", name: "이참가사", role: "exhibitor", firstTime: true, applicationStatus: "registered", hasProfile: false },
  // 운영사 → 프로필 게이트 무관, /organizer
  organizer: { memberId: "mbr-org-01", name: "정세훈", role: "organizer", firstTime: true, applicationStatus: "submitted", hasProfile: true, permissionLevel: "master" },
  "trade-office": { memberId: "mbr-trade-01", name: "박무역", role: "organizer", firstTime: false, applicationStatus: "submitted", hasProfile: true, permissionLevel: "sub" },
}

// 약관 v1 — 방산=민감정보라 처리 근거가 필수(D4). 버전·항목은 BE consent_documents(#19)에서 온다.
// id == type(tos/privacy/sensitive/marketing) — accepted_doc_ids가 곧 동의 타입(계약 NOTE).
// 전문은 데모용 플레이스홀더 — 실연동 시 BE consent_documents(#19)의 전문/버전으로 대체된다.
const CONSENT_DOCUMENTS: ConsentDocument[] = [
  {
    id: "tos",
    title: "Sales AI 서비스 이용약관",
    summary: "비즈매칭 서비스 이용 조건과 책임 범위에 동의합니다.",
    version: "v1.0",
    required: true,
    content: `제1조 (목적)
이 약관은 Sales AI 비즈매칭 서비스(이하 "서비스")의 이용 조건 및 절차, 회사와 이용자의 권리·의무·책임사항을 규정함을 목적으로 합니다.

제2조 (정의)
1. "이용자"란 주관사 명단에 등재되어 본 서비스에 로그인하는 참가사·바이어·운영사를 말합니다.
2. "비즈매칭"이란 참가사와 바이어 간 미팅을 주선·배정하는 기능을 말합니다.

제3조 (서비스의 제공)
회사는 전시회 기간 및 그 전후 기간에 걸쳐 기업 정보 탐색, 미팅 신청·수락, 회의록 작성 등의 기능을 제공합니다.

제4조 (이용자의 의무)
이용자는 타인의 계정을 도용하거나 허위 정보를 등록해서는 안 되며, 서비스를 통해 취득한 상대 기업 정보를 매칭 목적 외로 사용해서는 안 됩니다.

제5조 (책임의 제한)
회사는 천재지변·불가항력 또는 이용자의 귀책사유로 인한 서비스 이용 장애에 대하여 책임을 지지 않습니다.`,
  },
  {
    id: "privacy",
    title: "개인정보 수집·이용 동의",
    summary: "기관·담당자 정보를 매칭 목적으로 수집·이용하는 데 동의합니다.",
    version: "v1.0",
    required: true,
    content: `1. 수집 항목
소속 기관명, 담당자 성명, 직위, 연락처(전화·이메일), 관심 분야 및 취급 품목.

2. 수집·이용 목적
바이어-셀러 매칭, 미팅 배정 및 안내, 상담 결과 기록, 서비스 운영 및 고객 응대.

3. 보유·이용 기간
전시회 종료 후 1년간 보관하며, 기간 경과 또는 동의 철회 시 지체 없이 파기합니다. 단, 관계 법령에 따라 보존이 필요한 경우 해당 기간 동안 보관합니다.

4. 동의 거부 권리
귀하는 본 동의를 거부할 권리가 있으나, 필수 항목 미동의 시 매칭 서비스 이용이 제한됩니다.`,
  },
  {
    id: "sensitive",
    title: "취급 정보 처리 동의",
    summary: "매칭 정확도 제고를 위한 사업·취급 정보의 처리·제공 근거 확보에 동의합니다.",
    version: "v1.0",
    required: true,
    content: `1. 처리하는 정보
취급 콘텐츠 분야, 사업 분야, 수출입 관심 국가 등 매칭 정확도 제고에 필요한 정보.

2. 처리 목적
K-콘텐츠 분야 특성을 반영한 정밀 매칭 및 적합한 상담 상대 추천.

3. 제3자 제공
매칭된 상대 기업에 한하여 미팅 성사에 필요한 범위 내에서만 제공되며, 그 외 제3자에게 제공하지 않습니다.

4. 동의 거부 권리
귀하는 위 정보 처리에 동의하지 않을 권리가 있으나, 미동의 시 매칭의 정확도가 제한될 수 있습니다.`,
  },
  {
    id: "marketing",
    title: "소식·마케팅 수신 동의 (선택)",
    summary: "전시·매칭 관련 소식을 이메일로 받는 데 동의합니다.",
    version: "v1.0",
    required: false,
    content: `1. 수신 내용
전시회 일정 안내, 신규 매칭 추천, 후속 행사 및 프로모션 소식.

2. 수신 방법
이메일 및 문자메시지.

3. 철회
본 동의는 선택 사항이며, 동의하지 않아도 서비스 이용에 제한이 없습니다. 동의 후에도 언제든 수신을 철회할 수 있습니다.`,
  },
]

// 발급한 mock 티켓 → 그 계정(completeLogin이 역할·게이트를 복원하는 데 쓴다).
// 실연동은 BE login_ticket(서명·TTL·1회용) 페이로드가 이 역할을 한다.
function ticketFor(memberId: string): string {
  return `mock-ticket-${memberId}`
}

export const mockAuthClient: AuthClient = {
  async checkDeeplinkToken(token: string): Promise<DeeplinkCheck> {
    if (!token || token === INVALID_TOKEN) return { status: "invalid" }
    if (token === EXPIRED_TOKEN) return { status: "expired" }
    // 토큰이 특정한 회원의 아이디·이름을 프리필용으로 반환. 데모: 토큰값이 데모 계정명이면 그 계정, 아니면 buyer.
    const username = token in DEMO_ACCOUNTS ? token : "buyer"
    return { status: "valid", username, name: DEMO_ACCOUNTS[username].name }
  },

  // 1단계: 자격검증 + 명단매핑 → 재방문(succeeded) / 최초(consent_required) / 거부.
  // deeplinkToken은 프리필 편의일 뿐 신원의 닻이 아니므로 mock에선 무시(pass-through).
  async startLogin({ username, password }: StartLoginInput): Promise<StartLoginResult> {
    const account = DEMO_ACCOUNTS[username.trim()]
    if (!account || password !== DEMO_PASSWORD) {
      return { outcome: "rejected", reason: "invalid_credentials" }
    }
    const gate = { applicationStatus: account.applicationStatus, hasProfile: account.hasProfile }
    if (account.firstTime) {
      // 최초 진입 — 티켓 발급 + 약관 문서 동봉. 세션은 completeLogin에서.
      return { outcome: "consent_required", loginTicket: ticketFor(account.memberId), documents: CONSENT_DOCUMENTS }
    }
    // 재방문 — 약관 스킵, 곧바로 성공(세션 발급 완료로 간주).
    return { outcome: "succeeded", role: account.role, gate, permissionLevel: account.permissionLevel }
  },

  // 2단계: 약관 동의 검증 → 세션 발급. mock 티켓에서 계정을 복원해 역할·게이트를 돌려준다.
  async completeLogin({ loginTicket, acceptedDocIds }: CompleteLoginInput): Promise<CompleteLoginResult> {
    const memberId = loginTicket.replace(/^mock-ticket-/, "")
    const account = Object.values(DEMO_ACCOUNTS).find((a) => a.memberId === memberId)
    if (!loginTicket.startsWith("mock-ticket-") || !account) {
      return { outcome: "ticket_invalid", reason: "forged" }
    }
    const accepted = new Set(acceptedDocIds)
    const missingRequired = requiredDocIds(CONSENT_DOCUMENTS).filter((id) => !accepted.has(id))
    if (missingRequired.length > 0) {
      return { outcome: "consent_incomplete", missingRequired }
    }
    if (process.env.NODE_ENV !== "production") {
      console.info("[consent]", { memberId, acceptedDocIds })
    }
    return {
      outcome: "succeeded",
      role: account.role,
      gate: { applicationStatus: account.applicationStatus, hasProfile: account.hasProfile },
      permissionLevel: account.permissionLevel,
    }
  },
}

export { CONSENT_DOCUMENTS }
