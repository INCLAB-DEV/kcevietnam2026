// OP-002 "정보 수정" 다이얼로그(MembersTable.editMember) → 신청서 프로필 patch 본문 변환.
//
// ⚠ 배경(H1, 2026-09-12): editMember()가 인메모리 state(edits)만 바꾸고 서버 호출 자체를 하지
// 않아 새로고침하면 소실되던 버그. admin/organizations의 ProfileEditor(profile-editor.tsx)는
// 같은 백엔드(PATCH .../profile · POST .../proxy-profile, extra="forbid")를 코드 고정 <select>로
// 정확히 겨냥해 이미 정상 저장된다 — 그 계약을 재사용한다.
//
// 이 다이얼로그(MemberFormInput)는 admin ProfileEditor와 달리 **자유 텍스트** 입력이다(사업분야를
// <select>가 아니라 자유 텍스트로 받는 등). backend Literal(enum) 필드에 자유 텍스트를 그대로
// 보내면 422이므로, enum-guard가 없는 안전한 필드만 골라 보낸다 — 나머지(사업분야/HS코드/KST
// 상담시간/부스/바이어유형/체류정보/기업명)는 대응하는 신청서 스키마 필드가 없거나 코드 검증이
// 필요해 이 경로로는 보내지 않는다(로컬 정정으로만 남는다 — 새 스키마 필드가 생기면 여기만 넓히면
// 된다). 참가사 담당자(attendees)는 전체교체 배열이라 보존 리스트 없이 index0만 보내면 나머지
// 담당자가 삭제되므로(profile-editor.tsx mergeExhibitorAttendees 참고) 이 경로에선 손대지 않는다.
import type { MemberTab } from "./members"

export interface OrganizerMemberProfileInput {
  contentCategory?: string | null
  businessRegNo?: string
  website?: string
  primaryContact?: string
  contactEmail?: string
  mainTel?: string
  address?: string
  language?: string // 바이어 전용 — contact_language는 자유텍스트 허용(enum-guard 없음)
}

const n = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

export function toOrganizerProfilePatch(
  input: OrganizerMemberProfileInput,
  tab: MemberTab,
): Record<string, unknown> {
  const bizNo = n(input.businessRegNo)
  const website = n(input.website)
  const address = n(input.address)
  if (tab === "buyer") {
    const patch: Record<string, unknown> = {}
    if (bizNo !== undefined) patch.business_reg_no = bizNo
    if (website !== undefined) patch.website = website
    const tel = n(input.mainTel)
    if (tel !== undefined) patch.tel = tel
    if (address !== undefined) patch.address1 = address
    const contactName = n(input.primaryContact)
    if (contactName !== undefined) patch.contact_name_ko = contactName
    const contactEmail = n(input.contactEmail)
    if (contactEmail !== undefined) patch.contact_email = contactEmail
    const language = n(input.language)
    if (language !== undefined) patch.contact_language = language
    return patch
  }
  // exhibitor
  const patch: Record<string, unknown> = {}
  if (input.contentCategory !== undefined) patch.content_category = input.contentCategory || null
  if (bizNo !== undefined) patch.business_reg_no = bizNo
  if (website !== undefined) patch.website = website
  const mainTel = n(input.mainTel)
  if (mainTel !== undefined) patch.main_tel = mainTel
  if (address !== undefined) patch.address_ko = address
  const companyEmail = n(input.contactEmail)
  if (companyEmail !== undefined) patch.company_email = companyEmail
  return patch
}

// 보낼 필드가 하나도 없으면 빈 PATCH(백엔드가 no-op으로 받아도 되지만) 대신 호출 자체를 생략한다 —
// 호출부(members-table.tsx)가 이 판정으로 불필요한 왕복을 건너뛴다.
export function hasOrganizerProfilePatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0
}
