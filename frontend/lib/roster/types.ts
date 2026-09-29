// 명단 업로드 응답 계약 — FastAPI POST /api/admin/import/roster(backend/app/roster/router.py
// import_members)가 row_report=true일 때 돌려주는 모양 그대로다(import_service.ImportResult.as_dict).
// 두 콘솔(/admin/organizations·/organizer/members)이 이 타입 하나를 공유한다.

export type RosterRowResult = "added" | "updated" | "unchanged" | "skipped"
export type RosterAccountOutcome = "created" | "existing" | "none"
export type RosterPasswordOutcome = "set" | "kept" | "missing"

// 행별 사유 코드 — backend import_service/parser와 1:1. 모르는 코드가 와도 화면이 깨지지 않게 string도 허용.
export type RosterRowReason =
  | "missing_member_id"
  | "missing_org_name"
  | "duplicate_id_in_file"
  | "buyer_only"
  | "out_of_jurisdiction"
  | "no_email"
  | "invalid_email"
  | "duplicate_email_in_file"
  | "email_in_use"

export interface RosterImportRow {
  row: number | null // 스프레드시트 행 번호(헤더=1행)
  organizer_member_id: string | null
  org_name: string | null
  email: string | null
  result: RosterRowResult
  account: RosterAccountOutcome
  password: RosterPasswordOutcome | null // 평문이 아니라 처리 상태만 온다
  reason: RosterRowReason | (string & {}) | null
}

export interface RosterAccountSummary {
  created: number
  password_set: number // 이번에 비밀번호가 설정된(미리보기면 설정될) = 새로 로그인 가능해지는 계정
  password_kept: number // 이미 비밀번호가 있어 유지한 계정
  password_missing: number // 계정은 있지만 비밀번호가 없어 로그인 불가
  no_account: number // 이메일 없음·형식 오류·중복 등으로 계정을 만들지 못한 적재 행
}

export interface RosterImportWarning {
  reason: string // 'invalid_category' | 'category_conflict'
  organizer_member_id?: string
  organizer_member_ids?: string[]
  organization_id?: string
}

export interface RosterImportReport {
  added: number
  updated: number
  unchanged: number
  skipped: number
  changes: unknown[]
  warnings?: RosterImportWarning[]
  accounts?: RosterAccountSummary
  rows?: RosterImportRow[]
}
