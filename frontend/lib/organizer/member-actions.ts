// OP-002/003 — 참가기업 CRUD의 클라 → 서버 호출(MembersTable이 부른다).
// 계약은 app/api/organizer/members/** 라우트와 짝. 실패는 던지지 않는다 — 화면은 낙관적으로
// 먼저 바뀌고(목업 인메모리가 원래 소스), 실패 시 토스트만 띄운다(비차단, decide()와 동일 원칙).

export type MemberDecision = "approved" | "rejected" | "changes_requested"

export interface MemberStatusResult {
  success: boolean
  error?: string
}

export interface MemberActionResult {
  success: boolean
  error?: string
  id?: string | null
}

export interface CreateMemberInput {
  name: string
  nameEn?: string
  role: "exhibitor" | "buyer"
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  // 담당자 계정 비밀번호(선택). 비우면 계정은 만들어지되 로그인은 안 된다(백엔드 password_hash NULL).
  password?: string
}

// 참가기업 삭제(OP-002) — confirmDelete()가 부른다. memberId = organization_id(status와 동일 규약).
export const deleteMember = async (memberId: string): Promise<MemberActionResult> => {
  try {
    const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}`, {
      method: "DELETE",
    })
    const data = (await res.json().catch(() => null)) as { error?: string; id?: string } | null
    if (!res.ok) {
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true, id: data?.id }
  } catch {
    return { success: false, error: "network" }
  }
}

// 참가기업 단건 등록(OP-002) — registerMember()가 부른다.
export const createMember = async (input: CreateMemberInput): Promise<MemberActionResult> => {
  try {
    const res = await fetch("/api/organizer/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    const data = (await res.json().catch(() => null)) as { error?: string; id?: string } | null
    if (!res.ok) {
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true, id: data?.id }
  } catch {
    return { success: false, error: "network" }
  }
}

// 담당자 계정 비밀번호 설정/재설정(OP-002) — 단건 등록 이후 다시 정해주는 경로.
// ⚠ 평문은 요청 본문으로만 나간다 — 반환값에도, 실패 메시지에도 담기지 않는다. 화면은 성공/실패
// 여부와 에러 코드만 보고 토스트를 띄운다(다른 액션과 같은 비차단 계약).
export interface MemberPasswordResult {
  success: boolean
  error?: string
  contactEmail?: string | null
}

export const setMemberPassword = async (
  memberId: string,
  password: string,
): Promise<MemberPasswordResult> => {
  try {
    const res = await fetch(
      `/api/organizer/members/${encodeURIComponent(memberId)}/contact-password`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      },
    )
    const data = (await res.json().catch(() => null)) as
      | { error?: string; contactEmail?: string | null }
      | null
    if (!res.ok) {
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true, contactEmail: data?.contactEmail ?? null }
  } catch {
    return { success: false, error: "network" }
  }
}

// 명단 Excel 내보내기(OP-002) — handleExportExcel()이 부른다(members-table.tsx). 실 세션이면
// 서버(openpyxl)가 만든 스타일 갖춘 진짜 .xlsx(app/api/organizer/members/export)를 그대로 받는다.
// 실패하면 null — 실세션 호출부는 오류를 알리고 재시도를 제공한다. mock 파일 생성은 별도 경로다.
export interface MembersExportInput {
  tab: "exhibitor" | "buyer"
  query: string
  statuses: string[]
  content_categories: string[]
  business_fields: string[]
  has_matches_only: boolean
  sort: "name" | "matches" | "status"
  ordered_ids: string[]
}
export const exportMembersXlsx = async (filters: MembersExportInput): Promise<Blob | null> => {
  try {
    const res = await fetch("/api/organizer/members/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(filters),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return blob.size > 0 ? blob : null
  } catch {
    return null
  }
}

// 참가기업 "정보 수정" 저장(OP-002/H1) — editMember()가 부른다. mode는 호출부가 row.applicationStatus
// 로 미리 계산해 보낸다(admin ProfileEditor와 동일 규칙 — registered면 대리작성, 아니면 직접 수정).
export const patchMemberProfile = async (
  memberId: string,
  role: "exhibitor" | "buyer",
  mode: "edit" | "proxy",
  patch: Record<string, unknown>,
): Promise<MemberActionResult> => {
  try {
    const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, mode, patch }),
    })
    const data = (await res.json().catch(() => null)) as { error?: string; id?: string } | null
    if (!res.ok) {
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true, id: data?.id }
  } catch {
    return { success: false, error: "network" }
  }
}

export const patchMemberStatus = async (
  memberId: string,
  status: MemberDecision,
  note?: string,
): Promise<MemberStatusResult> => {
  try {
    const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note ? { status, note } : { status }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      return { success: false, error: data?.error ?? `http_${res.status}` }
    }
    return { success: true }
  } catch {
    return { success: false, error: "network" }
  }
}
