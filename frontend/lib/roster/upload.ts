// 명단 업로드 클라이언트 — 두 콘솔(/admin/organizations·/organizer/members)이 공유하는 **유일한** 업로드
// 경로다. 같은 출처 BFF(app/api/organizer/members/roster/route.ts) → FastAPI POST /api/admin/import/roster.
// 예전엔 콘솔마다 클라이언트·BFF·템플릿이 따로 있어 서로 어긋났다(어드민 템플릿이 400으로 전부 거부).
//
// 흐름: dryRun=true(미리보기, 아무것도 저장 안 됨) → 확인 → dryRun=false(적용). 둘 다 행별 결과를 받는다.
// 평문 공통 비밀번호는 이 요청 본문(multipart)으로만 흐른다 — 저장·로그하지 않는다.
// 실패를 던지지 않는다: 호출부는 success/error만 보고 화면에 안내한다.

import type { RosterImportReport } from "./types"

export const ROSTER_UPLOAD_PATH = "/api/organizer/members/roster"

export interface RosterUploadRequest {
  file: File
  // 어드민 콘솔은 선택된 행사를 넘긴다. 생략하면 BFF가 운영자의 첫 행사로 정한다(운영자 콘솔).
  eventId?: string
  // 빈 문자열/생략 = 공통 비밀번호 미입력(새 계정은 로그인 불가 상태로 만들어진다).
  password?: string
  dryRun: boolean
}

export type RosterUploadOutcome =
  | { success: true; report: RosterImportReport }
  | { success: false; error: string; status?: number }

export async function uploadRoster(request: RosterUploadRequest): Promise<RosterUploadOutcome> {
  const form = new FormData()
  form.set("file", request.file, request.file.name)
  form.set("dry_run", request.dryRun ? "true" : "false")
  form.set("row_report", "true")
  if (request.password) form.set("password", request.password)

  const url = request.eventId
    ? `${ROSTER_UPLOAD_PATH}?event_id=${encodeURIComponent(request.eventId)}`
    : ROSTER_UPLOAD_PATH
  try {
    const res = await fetch(url, { method: "POST", body: form })
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; error?: string; result?: RosterImportReport }
      | null
    if (!res.ok || !data?.success || !data.result) {
      return { success: false, error: data?.error ?? `http_${res.status}`, status: res.status }
    }
    return { success: true, report: data.result }
  } catch {
    return { success: false, error: "network" }
  }
}
