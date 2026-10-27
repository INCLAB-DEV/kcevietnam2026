// OP-002/003 — 참가기업 CRUD의 클라 → 서버 호출(MembersTable이 부른다).
// 계약은 app/api/organizer/members/** 라우트와 짝. 실패는 던지지 않는다 — 화면은 낙관적으로
// 먼저 바뀌고(목업 인메모리가 원래 소스), 실패 시 토스트만 띄운다(비차단, decide()와 동일 원칙).
// 예외 둘: 삭제는 서버가 확인한 뒤에만 화면을 바꾸고(deleteMember), 삭제 영향 읽기
// (getMemberDeletionImpact)는 실패를 던진다 — 읽지 못한 것을 빈 값으로 바꾸지 않기 위해서다.

import {
  MemberDeletionImpactSchema,
  type MemberDeletionImpact,
} from "@/lib/organizer/member-deletion"

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

// 참가기업 삭제 영향 읽기(OP-002) — 삭제 확인 다이얼로그가 열릴 때 부른다. 무엇이 삭제를 막는지,
// 삭제하면 무엇이 함께 지워지는지를 서버(삭제와 같은 판정)에서 읽는다.
// 읽지 못하면 **던진다** — 다이얼로그가 "확인하지 못했다"를 보여 주고 삭제 버튼을 막는다. 모양이 어긋난
// 응답도 실패다(빠진 칸을 0으로 채우면 "함께 지워지는 것 없음"으로 보인다). 백엔드가 구조화된 404로 "이 행사
// 명단에 그 기업이 없다"고 하면 오류 메시지가 ORG_NOT_FOUND다(isOrgNotFoundError — 다이얼로그가 따로 안내하고
// 명단을 다시 읽게 한다). 그 밖의 404는 http_404로, 다른 실패와 같다.
export const getMemberDeletionImpact = async (memberId: string): Promise<MemberDeletionImpact> => {
  const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}/deletion-impact`)
  const data = (await res.json().catch(() => null)) as { error?: string; impact?: unknown } | null
  if (!res.ok) {
    throw new Error(data?.error ?? `http_${res.status}`)
  }
  const parsed = MemberDeletionImpactSchema.safeParse(data?.impact)
  if (!parsed.success) {
    throw new Error("invalid_response")
  }
  return parsed.data
}

// 삭제 거부(409 ORG_HAS_MEETINGS)에는 서버가 센 상태별 건수가 실린다 — 미리보기를 읽은 뒤 상황이
// 바뀐 경우에도 화면이 "미팅이 있어요"가 아니라 몇 건이 왜 막는지 말할 수 있게 한다.
// status는 HTTP 상태다 — 권한 없음(403)은 error가 서버 문장이라 상태로 가른다. "이 행사 명단에 없음"은 error가
// ORG_NOT_FOUND다(백엔드의 구조화된 404만 — 화면은 실패가 아니라 명단을 다시 읽는다). 그 밖의 404는 http_404다.
export interface MemberDeleteResult extends MemberActionResult {
  status?: number
  message?: string
  scheduledCount?: number
  completedCount?: number
}

// 참가기업 삭제(OP-002) — 삭제 확인 다이얼로그가 부른다. memberId = organization_id(status와 동일 규약).
export const deleteMember = async (memberId: string): Promise<MemberDeleteResult> => {
  try {
    const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}`, {
      method: "DELETE",
    })
    const data = (await res.json().catch(() => null)) as
      | {
          error?: string
          id?: string
          message?: string
          scheduledCount?: unknown
          completedCount?: unknown
        }
      | null
    if (!res.ok) {
      const failure: MemberDeleteResult = {
        success: false,
        error: data?.error ?? `http_${res.status}`,
        status: res.status,
      }
      if (typeof data?.message === "string" && data.message) failure.message = data.message
      if (typeof data?.scheduledCount === "number") failure.scheduledCount = data.scheduledCount
      if (typeof data?.completedCount === "number") failure.completedCount = data.completedCount
      return failure
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

// 미신청(registered) 행의 간이 대리작성 저장(OP-002) — MembersTable.proxyWriteMember가 부른다.
// 같은 BFF(PATCH /api/organizer/members/{id}/profile)의 mode="proxy" 쪽이다(백엔드 POST .../proxy-profile —
// 저장과 함께 상태가 전이한다. 규칙은 관리자 콘솔의 대리작성 다이얼로그 components/admin/proxy-write-dialog와 같다).
// 신청서가 있는 행의 직접 수정(mode="edit")은 이 함수가 아니라 신청서 편집 패널의 전송
// (lib/organizer/application-transport.ts)이 같은 BFF로 보낸다 — 저장된 프로필을 응답에서 읽어야 해서다.
export const patchMemberProfile = async (
  memberId: string,
  role: "exhibitor" | "buyer",
  patch: Record<string, unknown>,
): Promise<MemberActionResult> => {
  try {
    const res = await fetch(`/api/organizer/members/${encodeURIComponent(memberId)}/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, mode: "proxy", patch }),
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
