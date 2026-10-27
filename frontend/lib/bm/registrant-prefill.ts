// 등록정보(명단/세션) 기반 자동 프리필 — 로그인한 참가사가 이미 준 정보로 빈 칸을 채운다.
// PRD F-BM-002 User Story 3("기본정보가 미리 채워져 있기를"). ADR-0009 eager 생성(로그인 시
// org/member 존재)을 전제로, 실연동 시 registrants.raw → 명단 컬럼 매핑이 이 자리를 대체한다.
//
// 규칙: **빈 칸만** 채운다(이어쓰기 중 저장값을 덮어쓰지 않는다). 채운 키 목록(sources)을 함께
// 돌려줘 UI가 "명단에서 가져옴" 배지를 띄우고, 사용자가 수정하면 배지를 지운다(검토·수정 전제).
//
// ⚠ 확인 필요(HITL — 주최사 명단 컬럼 확정 후 닫힘, PRD Further Notes 선행 블로커):
//   지금은 **데모 세션값**으로 채운다. 실제 "로그인 시 자동 채워지는 필드"는 주최사 명단 원본의
//   컬럼이 확정돼야 정해진다. 아래는 **잠정 매핑** — 주최사와 다음을 확인할 것:
//     1) 명단에 실제 존재하는 컬럼: 회사명(국/영)·대표연락처·주소·담당자(성/이름 분리 여부)·이메일 등
//     2) 국/영 성명 분리 규칙(현재는 성명을 firstNameKo 한 칸에 통째로 넣음 — 분리 신뢰 어려움)
//     3) 담당자 ↔ members 연결(member_id, codex P1) — 폼값은 스냅샷
//     4) 추가 prefill 후보(영문 회사명·홈페이지·기관유형 등)를 명단에서 채울지
//   확정 전까지 명단 원본은 registrants.raw(jsonb)로 무손실 보존(PRD), prefill은 잠정 동작.

import type { ExhibitorProfileDraft } from "./types"

// 행사 등록(명단/로스터)이 아는 기본정보 — 1단계(기본정보)를 그대로 채운다. 데모는 mock 등록정보,
// 실연동은 Cognito+registrants.raw 컬럼 매핑. 키 집합은 로스터 컬럼과 1:1(확정 전 잠정).
export interface RegistrantInfo {
  businessRegNo?: string
  organizationNameKo?: string
  organizationNameEn?: string
  hall?: string
  pavilion?: string
  boothLocation?: string
  boothType?: string
  boothCount?: number
  representativeNameKo?: string
  representativeNameEn?: string
  companyEmail?: string
  mainTel?: string
  fax?: string
  zipCode?: string
  addressKo?: string
  addressDetail?: string
  addressEn?: string
  businessType?: string
  businessItem?: string
  // 담당자 (로스터: 담당자명 국/영·직책·이메일·연락처)
  contactNameKo?: string
  contactNameEn?: string
  contactTitle?: string
  contactEmail?: string
  contactPhone?: string
}

export interface PrefillResult {
  patch: Partial<ExhibitorProfileDraft>
  sources: (keyof ExhibitorProfileDraft)[]
}

// 로스터 → 드래프트가 같은 이름·타입을 쓰는 스칼라 필드(그대로 복사).
const SCALAR_KEYS = [
  "businessRegNo",
  "organizationNameKo",
  "organizationNameEn",
  "hall",
  "pavilion",
  "boothLocation",
  "boothType",
  "boothCount",
  "representativeNameKo",
  "representativeNameEn",
  "companyEmail",
  "mainTel",
  "fax",
  "zipCode",
  "addressKo",
  "addressDetail",
  "addressEn",
  "businessType",
  "businessItem",
] as const

function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
}

export function buildRegistrantPrefill(
  draft: ExhibitorProfileDraft,
  info: RegistrantInfo,
): PrefillResult {
  const patch: Partial<ExhibitorProfileDraft> = {}
  const sources: (keyof ExhibitorProfileDraft)[] = []

  // 스칼라 기본정보 — 드래프트가 비어 있고 등록정보가 있으면 채운다(이어쓰기 저장값은 보존).
  for (const key of SCALAR_KEYS) {
    if (blank(draft[key]) && !blank(info[key])) {
      ;(patch as Record<string, unknown>)[key] = info[key]
      sources.push(key)
    }
  }

  // 담당자 — 아직 한 명도 없을 때만 등록 담당자로 1명 초안. 국문 성/이름 분리는 신뢰하기 어려워
  // 담당자명을 firstName 한 칸에 넣고 사용자가 다듬게 한다(HITL — 명단 성/이름 분리 규칙 확인).
  const hasAttendee = (draft.attendees ?? []).length > 0
  const hasContact = !blank(info.contactNameKo) || !blank(info.contactNameEn) || !blank(info.contactEmail)
  if (!hasAttendee && hasContact) {
    patch.attendees = [
      {
        firstNameKo: info.contactNameKo,
        firstNameEn: info.contactNameEn,
        titleKo: info.contactTitle,
        email: info.contactEmail,
        mobile: info.contactPhone,
      },
    ]
    sources.push("attendees")
  }

  return { patch, sources }
}
