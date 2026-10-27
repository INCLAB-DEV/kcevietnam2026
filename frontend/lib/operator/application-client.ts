// 운영자 신청서 편집 클라이언트 — 관리자 콘솔(/admin/organizations)과 행사 운영 콘솔
// (/organizer/members)이 함께 쓰는 **유일한** 읽기·쓰기 어댑터다(components/operator/application-panel).
//
// 매핑을 새로 만들지 않는다. 운영자 상세(GET /api/admin/events/{e}/organizations/{o})의
// exhibitor_profile / buyer_profile은 참가자 API와 같은 응답 모델(backend app/bm/schemas.py)이고,
// 운영자 PATCH(.../profile?role=)는 참가자 저장과 같은 서비스 함수를 부른다. 그래서 읽기는 참가자
// 클라이언트의 fromApi / toBuyerProfileDraft, 쓰기는 같은 클라이언트의 toApiBody를 그대로 쓴다 —
// 코드값을 보존하고(라벨 문자열로 바꾼 값을 편집에 쓰지 않는다), 목록(담당자·제품·분야)은 참가자 폼과
// 똑같이 **전체**를 보낸다(백엔드가 전체 교체라 일부만 보내면 나머지가 삭제된다).
//
// 이 어댑터가 참가자 매핑 위에 얹는 것은 셋뿐이다:
//   1. 지움 — 서버에는 값이 있는데 폼에서 비운 스칼라 칸은 null로 보낸다. 참가자 매핑은 빈 칸을
//      "안 건드림"으로 다뤄(바이어는 ""를 빼고, 선택 칸은 undefined라 빠진다) 값을 지울 수 없었다.
//   2. 부스 — master 전용 쓰기다. sub 요청에 부스 키가 하나라도 섞이면 백엔드가 요청 **전체**를 403으로
//      거부하므로(app/admin/service.py check_booth_write), 권한이 없으면 본문에서 부스 키를 뺀다.
//   3. 운영자 전용 항목 — 참가자 폼에 없는 칸(참가사 기업명·부스, 바이어 사업자등록번호·웹사이트·주소)과
//      미팅 불가 시간(전용 엔드포인트, 전체 치환).
//
// 낙관적 갱신을 하지 않는다: 모든 저장은 서버가 돌려준 프로필로 스냅샷을 다시 만든다. 실패는
// OperatorRequestError로 던진다 — 삼키면 "저장한 척"이 된다(호출부가 토스트를 띄우고 입력을 유지한다).
//
// 동시 수정 — 저장 직전에 서버를 다시 읽어, 이 저장이 쓰는 칸이 "다이얼로그를 열 때의 값"과 달라졌으면
// 보내지 않고 OperatorConflictError로 끝낸다(아래 "동시 수정 검사"). 클라이언트 쪽 검사라 한계가 있다.
//
// 전송(어느 BFF 경로로 보내는가)만 콘솔마다 다르다 — OperatorApplicationTransport로 주입한다
// (lib/admin/application-transport.ts · lib/organizer/application-transport.ts).

import type { ApplicationStatus } from "@/lib/application-status"
import { STEP_FIELDS } from "@/lib/apply/form-state"
import type {
  BuyerEditableStep,
  BuyerProfileDraft,
  BuyerStepPatch,
} from "@/lib/apply/types"
import {
  toApiBody as buyerToApiBody,
  toBuyerProfileDraft,
  type ApiBuyerProfile,
} from "@/lib/bm/http-buyer-client"
import {
  fromApi as exhibitorFromApi,
  toApiBody as exhibitorToApiBody,
  type ApiProfile as ApiExhibitorProfile,
} from "@/lib/bm/http-exhibitor-client"
import { STEP1_SAVE_EXCLUDE_KEYS, STEP_META } from "@/lib/bm/profile-form-state"
import type {
  EditableStep,
  ExhibitorAttendee,
  ExhibitorProfile,
  ExhibitorProfileDraft,
  ExhibitorStepPatch,
} from "@/lib/bm/types"

import type { UnavailableSlotGrid } from "./slot-grid"

export type { ApiBuyerProfile, ApiExhibitorProfile }

export type OperatorApplicationRole = "exhibitor" | "buyer"

// ── 전송 계약 ─────────────────────────────────────────────────────────────────
// 운영자 상세 응답(backend app/admin/schemas.py OrganizationDetail) 중 편집기가 읽는 부분.
export interface OperatorOrgDetailApi {
  id: string // organization_id
  org_event_role_id: string
  event_id: string
  name_ko?: string | null
  name_en?: string | null
  is_exhibitor: boolean
  is_buyer: boolean
  application_status: ApplicationStatus
  proxy_written_by_organizer_id?: string | null
  buyer_profile?: ApiBuyerProfile | null
  exhibitor_profile?: ApiExhibitorProfile | null
}

export interface OperatorApplicationTransport {
  // 상세 조회 + 미팅 불가 시간 격자의 축(만들 수 없으면 null).
  getDetail(): Promise<{ detail: OperatorOrgDetailApi; slotGrid: UnavailableSlotGrid | null }>
  // 프로필 PATCH — 본문은 백엔드 patch(snake_case). 응답은 **저장된** 프로필(참가자 응답 모델)이어야 한다.
  patchProfile(
    role: OperatorApplicationRole,
    body: Record<string, unknown>,
  ): Promise<ApiExhibitorProfile | ApiBuyerProfile>
  // 미팅 불가 시간 — 전체 치환(참가사만, master 전용). 응답은 저장된 참가사 프로필.
  patchUnavailableSlots(slots: string[]): Promise<ApiExhibitorProfile>
}

// 실패 — status는 HTTP 상태(네트워크 단절은 0), code는 백엔드·BFF가 준 코드나 사유 문장.
export class OperatorRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`operator request failed: ${status} ${code}`)
    this.name = "OperatorRequestError"
    this.status = status
    this.code = code
  }
}

export function isOperatorForbidden(error: unknown): boolean {
  return error instanceof OperatorRequestError && error.status === 403
}

// 충돌 — 저장 직전에 다시 읽어 보니, 이 저장이 쓰려던 칸이 그 사이 다른 곳(다른 운영자·참가자)에서
// 바뀌어 있었다. **아무것도 보내지 않았다.** latest는 방금 읽은 최신 값(패널 클라이언트면 스냅샷 전체,
// 미팅 불가 시간 단독 저장이면 슬롯 목록) — 호출부가 화면을 이 값으로 바꾸고, 입력은 남긴 채 안내한다.
export class OperatorConflictError<T = unknown> extends OperatorRequestError {
  readonly latest: T

  constructor(latest: T) {
    super(409, "edit_conflict")
    this.name = "OperatorConflictError"
    this.latest = latest
  }
}

export function isOperatorConflict(error: unknown): error is OperatorConflictError {
  return error instanceof OperatorConflictError
}

// 같은 출처 BFF 호출 — 두 콘솔의 전송 구현이 함께 쓴다. 토큰은 만지지 않는다(BFF가 세션 쿠키에서 붙인다).
// 에러 본문은 FastAPI 통과형({detail})과 BFF 봉투형({error}) 둘 다 읽는다.
export async function operatorJson<T>(
  method: "GET" | "PATCH" | "POST",
  url: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new OperatorRequestError(0, "network")
  }
  if (!res.ok) throw new OperatorRequestError(res.status, await errorCodeOf(res))
  return (await res.json()) as T
}

async function errorCodeOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as
    | { detail?: unknown; error?: unknown }
    | null
  if (typeof data?.error === "string" && data.error) return data.error
  const detail = data?.detail
  if (typeof detail === "string" && detail) return detail
  if (typeof detail === "object" && detail !== null) {
    const code = (detail as { code?: unknown }).code
    if (typeof code === "string" && code) return code
  }
  return `http_${res.status}`
}

// ── 스냅샷(서버가 확인해 준 현재 상태) ────────────────────────────────────────
interface OperatorApplicationBase {
  organizationId: string
  orgEventRoleId: string
  status: ApplicationStatus
  proxyWritten: boolean
  slotGrid: UnavailableSlotGrid | null
}

export interface OperatorExhibitorApplication extends OperatorApplicationBase {
  role: "exhibitor"
  profile: ExhibitorProfile
}

export interface OperatorBuyerApplication extends OperatorApplicationBase {
  role: "buyer"
  draft: BuyerProfileDraft
}

export type OperatorApplication = OperatorExhibitorApplication | OperatorBuyerApplication

// ── 운영자 전용 항목(참가자 폼에 없거나 참가자는 못 고치는 칸) ─────────────────
// null = 값을 지운다, undefined(키 없음) = 건드리지 않는다.
type Clearable<T> = { [K in keyof T]?: T[K] | null }

export const EXHIBITOR_NAME_KEYS = ["organizationNameKo", "organizationNameEn"] as const
export const EXHIBITOR_BOOTH_KEYS = [
  "hall",
  "pavilion",
  "boothLocation",
  "boothType",
  "boothCount",
] as const
export const BUYER_OPERATOR_KEYS = ["businessRegNo", "website", "address1", "address2"] as const

export type ExhibitorOperatorPatch = Clearable<
  Pick<
    ExhibitorProfileDraft,
    (typeof EXHIBITOR_NAME_KEYS)[number] | (typeof EXHIBITOR_BOOTH_KEYS)[number]
  >
>
export type BuyerOperatorPatch = Clearable<
  Pick<BuyerProfileDraft, (typeof BUYER_OPERATOR_KEYS)[number]>
>

// 백엔드의 부스 지정 필드(app/admin/service.py BOOTH_ASSIGNMENT_FIELDS 미러) — master 전용 쓰기.
export const BOOTH_BODY_KEYS = [
  "booth_hall",
  "booth_pavilion",
  "booth_location",
  "booth_type",
  "booth_count",
] as const

function withoutBooth(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body }
  for (const key of BOOTH_BODY_KEYS) delete out[key]
  return out
}

// ── 지움 ──────────────────────────────────────────────────────────────────────
function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "")
}

// 이 구획이 책임지는 스칼라 칸 중, 서버(baseline)에는 값이 있는데 폼(patch)에서는 비운 칸을 null로 바꾼다.
// 목록 칸은 건드리지 않는다 — 참가자 매핑이 이미 전체를 보내고, 빈 배열이 곧 "비움"이다.
function withClears<T extends object>(
  patch: Partial<T>,
  baseline: T,
  keys: readonly (keyof T)[],
): Partial<T> {
  const out: Record<string, unknown> = { ...patch }
  for (const key of keys) {
    const before = baseline[key]
    if (Array.isArray(before) || isBlank(before)) continue
    const after = (patch as Record<string, unknown>)[key as string]
    if (Array.isArray(after)) continue
    if (isBlank(after)) out[key as string] = null
  }
  return out as Partial<T>
}

// ── 동시 수정 검사(클라이언트 쪽 낙관적 동시성) ───────────────────────────────
// 목록 칸(담당자·제품·분야·구분·선호 국가/구분·상담 가능 언어)은 백엔드가 전체 교체하고, 스칼라 칸도
// 보낸 값으로 덮는다. 패널을 연 뒤 다른 운영자나 참가자가 고친 것을 모른 채 "열 때의 값"에서 출발한
// 입력을 저장하면 그 사이의 추가분이 지워지고 옛 값이 되돌아온다. 그래서 저장 직전에 서버를 다시 읽어,
// **이 저장이 쓰는 칸**이 다이얼로그를 열 때의 값(baseline)과 달라져 있으면 PATCH를 보내지 않는다.
// 다른 구획의 칸이 바뀐 것으로는 막지 않는다. 재조회가 실패하면 저장하지 않고 그 실패를 그대로 던진다.
//
// ⚠ 서버 검증이 아니다. 백엔드에 리비전·If-Match가 없어, 재조회와 PATCH 사이(요청 한 번, 밀리초)에
// 끼어든 수정은 여전히 덮인다 — 위험 구간을 "패널을 열어 둔 시간"에서 "요청 한 번 사이"로 줄일 뿐이다.
// 완전히 막으려면 백엔드의 리비전 검사가 필요하다(후속 과제).

// 비교용 정규형 — 같은 변환(fromApi 등)을 거친 값끼리 견준다. 빈 값(null·undefined·""·빈 목록)은 서로
// 같고, 코드 목록(문자열 배열)은 순서를 보지 않는다(서버가 돌려주는 순서에 뜻이 없다). 객체 목록(담당자·
// 제품)은 순서와 내용 전체를 본다.
function canonical(value: unknown): unknown {
  if (value == null || value === "") return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const items = value.map(canonical)
    return items.every((item) => typeof item === "string") ? [...(items as string[])].sort() : items
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const item = canonical((value as Record<string, unknown>)[key])
      if (item !== null) out[key] = item
    }
    return out
  }
  return value
}

export function sameOperatorValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function sameFields<T extends object>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((key) => sameOperatorValue(a[key], b[key]))
}

// 참가사 구획 저장이 실제로 쓰는 칸 — 그 구획의 칸에서 부스(구획 저장으로 보내지 않는다)와 미팅 불가 시간
// (프로필 PATCH가 받지 않는다 — 전용 엔드포인트)을 뺀 것. 지움 판정과 충돌 검사가 같은 목록을 쓴다.
function exhibitorStepKeys(step: EditableStep): (keyof ExhibitorProfileDraft)[] {
  return STEP_META[step - 1].fields.filter(
    (key) => !STEP1_SAVE_EXCLUDE_KEYS.includes(key) && key !== "unavailableMeetingSlots",
  )
}

// 패널 밖(대리작성 다이얼로그)의 미팅 불가 시간 저장 — 패널과 같은 검사를 한다: 화면이 보여 주던 목록
// (shown)이 서버의 지금 값과 다르면 저장하지 않고, 최신 목록을 실은 충돌로 던진다. 돌려주는 값은 서버가
// 저장했다고 확인해 준 목록이다.
export async function saveUnavailableSlotsChecked(
  transport: OperatorApplicationTransport,
  next: string[],
  shown: string[],
): Promise<string[]> {
  const { detail } = await transport.getDetail()
  const current = detail.exhibitor_profile?.unavailable_meeting_slots ?? []
  if (!sameOperatorValue(current, shown)) throw new OperatorConflictError([...current].sort())
  const saved = await transport.patchUnavailableSlots([...next].sort())
  return [...(saved.unavailable_meeting_slots ?? [])].sort()
}

// 기업명 지킴 — 국문·영문 중 하나만 지우는 것은 된다(영문명만 남기기 등). 그러나 있던 이름을 **둘 다**
// 지워 이름 없는 기업으로 만드는 저장은 보내지 않는다: 목록·검색·매칭 어디서도 그 기업을 알아볼 수 없게
// 된다. 원래부터 이름이 없던 기업은 막지 않는다(운영자 모드는 필수 누락으로 저장을 막지 않는다).
interface OrganizationNames {
  organizationNameKo?: string | null
  organizationNameEn?: string | null
}

function assertKeepsName(patch: OrganizationNames, baseline: OrganizationNames): void {
  if (isBlank(baseline.organizationNameKo) && isBlank(baseline.organizationNameEn)) return
  const ko = "organizationNameKo" in patch ? patch.organizationNameKo : baseline.organizationNameKo
  const en = "organizationNameEn" in patch ? patch.organizationNameEn : baseline.organizationNameEn
  if (isBlank(ko) && isBlank(en)) throw new OperatorRequestError(422, "name_required")
}

// 운영자 전용 항목의 본문 정리 — 공백만 남은 문자열은 지움(null), 그 밖의 문자열은 앞뒤 공백을 뗀다.
function normalizeOperatorPatch<T extends object>(patch: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value
  }
  return out as T
}

// 저장을 한 줄로 세운다 — 앞선 저장의 응답을 받은 뒤에 다음 저장(의 재조회)을 시작한다. 응답마다
// 프로필 전체가 실려 오므로, 두 저장이 겹치면 늦게 도착한 **옛** 응답이 화면을 덮어 방금 저장한 값이
// 옛 값으로 보인다. 실패한 저장은 뒤따르는 저장을 막지 않는다. 같은 패널 안의 요청만 줄 세운다 —
// 다른 창·다른 사람과의 겹침은 위 "동시 수정 검사"가 본다.
function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

// ── 클라이언트 ────────────────────────────────────────────────────────────────
// 저장 메서드는 모두 baseline을 받는다 — **그 입력을 받기 시작했을 때**(다이얼로그를 열 때, 격자 칸을 누를 때)
// 화면이 들고 있던 스냅샷이다. 저장 직전에 서버를 다시 읽어, 이 저장이 쓰는 칸이 baseline과 달라졌으면
// 보내지 않고 OperatorConflictError(latest = 방금 읽은 스냅샷)로 끝낸다(위 "동시 수정 검사").
// ⚠ baseline에 "패널의 지금 값"을 넘기면 안 된다: 충돌로 패널이 최신이 된 뒤 같은 다이얼로그에서 다시
//   저장하면, 옛 값에서 출발한 입력이 검사를 통과해 최신을 덮는다.
export interface OperatorExhibitorClient {
  readonly role: "exhibitor"
  // 열 때마다 서버에서 새로 읽는다(목록 화면에 실려 온 값을 편집 초깃값으로 쓰지 않는다).
  getProfile(): Promise<OperatorExhibitorApplication>
  // 한 구획(= 참가자 작성 폼의 한 단계) 저장 — 참가자 폼과 같은 페이로드(stepSavePayload)를 받는다.
  // ⚠ patch는 그 구획의 **전체** 페이로드여야 한다: 서버에 값이 있는데 patch에 없는 스칼라 칸은
  //   "폼에서 비웠다"로 보고 지운다. 구획의 일부만 고치는 경로는 이 메서드를 쓰지 않는다(saveAttendees 등).
  saveStep(
    step: EditableStep,
    patch: ExhibitorStepPatch,
    baseline: OperatorExhibitorApplication,
  ): Promise<OperatorExhibitorApplication>
  // 담당자 목록만 교체한다(운영자 전용 "담당자 추가 정보"). 목록은 **전체**를 넘긴다 — 다른 칸은 건드리지 않는다.
  saveAttendees(
    attendees: ExhibitorAttendee[],
    baseline: OperatorExhibitorApplication,
  ): Promise<OperatorExhibitorApplication>
  // 기업명·부스. 부스는 canAssignBooth(master)일 때만 실린다. 충돌은 **실제로 보내는 칸만** 본다 —
  // 다이얼로그는 바뀐 칸만 넘기므로, 같은 묶음의 옆 칸을 다른 사람이 고친 것은 막지 않는다(그 칸은 보내지
  // 않아 덮지도 않는다).
  saveOperatorFields(
    patch: ExhibitorOperatorPatch,
    baseline: OperatorExhibitorApplication,
  ): Promise<OperatorExhibitorApplication>
  // 미팅 불가 시간 전체 치환(master 전용 — 권한은 백엔드가 최종 판정한다).
  saveUnavailableSlots(
    slots: string[],
    baseline: OperatorExhibitorApplication,
  ): Promise<OperatorExhibitorApplication>
}

export interface OperatorBuyerClient {
  readonly role: "buyer"
  getProfile(): Promise<OperatorBuyerApplication>
  // 한 구획 저장 — 참가자 폼과 같은 페이로드(lib/apply/form-state.stepPatch, 구획 **전체**)를 받는다.
  saveStep(
    step: BuyerEditableStep,
    patch: BuyerStepPatch,
    baseline: OperatorBuyerApplication,
  ): Promise<OperatorBuyerApplication>
  // 사업자등록번호·웹사이트·주소(참가자 바이어 폼에 없는 칸). 충돌은 실제로 보내는 칸만 본다.
  saveOperatorFields(
    patch: BuyerOperatorPatch,
    baseline: OperatorBuyerApplication,
  ): Promise<OperatorBuyerApplication>
}

export type OperatorApplicationClient = OperatorExhibitorClient | OperatorBuyerClient

function baseOf(
  detail: OperatorOrgDetailApi,
  slotGrid: UnavailableSlotGrid | null,
): OperatorApplicationBase {
  return {
    organizationId: detail.id,
    orgEventRoleId: detail.org_event_role_id,
    status: detail.application_status,
    proxyWritten: detail.proxy_written_by_organizer_id != null,
    slotGrid,
  }
}

export function createOperatorExhibitorClient(
  transport: OperatorApplicationTransport,
  { canAssignBooth }: { canAssignBooth: boolean },
): OperatorExhibitorClient {
  const serial = createSerialQueue()

  async function load(): Promise<OperatorExhibitorApplication> {
    const { detail, slotGrid } = await transport.getDetail()
    // 역할이 바뀌었거나(역할 전환) 참가사 프로필이 없는 행 — 다른 역할의 값으로 폼을 채우지 않는다.
    if (!detail.is_exhibitor || !detail.exhibitor_profile) {
      throw new OperatorRequestError(409, "role_mismatch")
    }
    return {
      ...baseOf(detail, slotGrid),
      role: "exhibitor",
      profile: exhibitorFromApi(detail.exhibitor_profile),
    }
  }

  // 저장 응답(저장된 프로필 전체)으로 스냅샷을 다시 만든다 — 상태도 서버가 준 값을 쓴다.
  function saved(
    base: OperatorExhibitorApplication,
    api: ApiExhibitorProfile,
  ): OperatorExhibitorApplication {
    return { ...base, status: api.application_status, profile: exhibitorFromApi(api) }
  }

  // 저장 직전 재조회 + 충돌 검사(keys = 이 저장이 쓰는 칸). 통과하면 방금 읽은 스냅샷을 돌려준다 —
  // 지움 판정의 기준값이 된다(검사한 칸은 baseline과 같으므로 본문은 재조회 전과 똑같이 만들어진다).
  async function current(
    baseline: OperatorExhibitorApplication,
    keys: readonly (keyof ExhibitorProfileDraft)[],
  ): Promise<OperatorExhibitorApplication> {
    const fresh = await load()
    if (!sameFields<ExhibitorProfileDraft>(fresh.profile, baseline.profile, keys)) {
      throw new OperatorConflictError(fresh)
    }
    return fresh
  }

  return {
    role: "exhibitor",
    getProfile: load,

    saveStep(step, patch, baseline) {
      return serial(async () => {
        const keys = exhibitorStepKeys(step)
        const base = await current(baseline, keys)
        const cleared = withClears<ExhibitorProfileDraft>(patch, base.profile, keys)
        // 기본정보 구획은 기업명도 함께 보낸다(화면에서는 읽기 전용이라 지금은 비울 수 없다). 그래도
        // 바이어 경로와 같은 규칙으로 지킨다 — 둘 다 비운 본문이 나가면 이름 없는 기업이 된다.
        if (keys.some((key) => (EXHIBITOR_NAME_KEYS as readonly string[]).includes(key))) {
          assertKeepsName(cleared, base.profile)
        }
        // 부스는 이 경로로 보내지 않는다(stepSavePayload가 이미 빼지만, 여기서 한 번 더 지킨다 —
        // 스텝 다이얼로그는 부스를 고칠 수 없고, sub 본문에 섞이면 요청 전체가 403이다).
        const body = withoutBooth(exhibitorToApiBody(cleared))
        const api = (await transport.patchProfile("exhibitor", body)) as ApiExhibitorProfile
        return saved(base, api)
      })
    },

    saveAttendees(attendees, baseline) {
      return serial(async () => {
        const base = await current(baseline, ["attendees"])
        const body = exhibitorToApiBody({ attendees })
        const api = (await transport.patchProfile("exhibitor", body)) as ApiExhibitorProfile
        return saved(base, api)
      })
    },

    saveOperatorFields(patch, baseline) {
      return serial(async () => {
        const normalized = normalizeOperatorPatch(patch)
        // 견줄 칸 = 정규화 뒤 **실제 PATCH에 실리는** 칸(권한이 없어 빠지는 부스 칸은 견주지 않는다).
        const sent = [...EXHIBITOR_NAME_KEYS, ...(canAssignBooth ? EXHIBITOR_BOOTH_KEYS : [])].filter(
          (key) => key in normalized,
        )
        const base = await current(baseline, sent)
        // 이름 지킴은 방금 읽은 값으로 본다 — 내가 국문명을 지우는 사이 다른 사람이 영문명을 지웠다면
        // (그 칸은 견주지 않았다) 둘 다 빈 기업이 된다.
        assertKeepsName(normalized, base.profile)
        const full = exhibitorToApiBody(normalized as ExhibitorStepPatch)
        const body = canAssignBooth ? full : withoutBooth(full)
        const api = (await transport.patchProfile("exhibitor", body)) as ApiExhibitorProfile
        return saved(base, api)
      })
    },

    saveUnavailableSlots(slots, baseline) {
      return serial(async () => {
        const base = await current(baseline, ["unavailableMeetingSlots"])
        const api = await transport.patchUnavailableSlots([...slots].sort())
        return saved(base, api)
      })
    },
  }
}

export function createOperatorBuyerClient(
  transport: OperatorApplicationTransport,
): OperatorBuyerClient {
  const serial = createSerialQueue()

  async function load(): Promise<OperatorBuyerApplication> {
    const { detail, slotGrid } = await transport.getDetail()
    if (!detail.is_buyer || !detail.buyer_profile) {
      throw new OperatorRequestError(409, "role_mismatch")
    }
    return {
      ...baseOf(detail, slotGrid),
      role: "buyer",
      draft: toBuyerProfileDraft(detail.buyer_profile),
    }
  }

  function saved(base: OperatorBuyerApplication, api: ApiBuyerProfile): OperatorBuyerApplication {
    return { ...base, status: api.application_status, draft: toBuyerProfileDraft(api) }
  }

  // 저장 직전 재조회 + 충돌 검사(참가사 클라이언트의 current와 같다).
  async function current(
    baseline: OperatorBuyerApplication,
    keys: readonly (keyof BuyerProfileDraft)[],
  ): Promise<OperatorBuyerApplication> {
    const fresh = await load()
    if (!sameFields(fresh.draft, baseline.draft, keys)) throw new OperatorConflictError(fresh)
    return fresh
  }

  return {
    role: "buyer",
    getProfile: load,

    saveStep(step, patch, baseline) {
      return serial(async () => {
        const base = await current(baseline, STEP_FIELDS[step])
        const cleared = withClears<BuyerProfileDraft>(patch, base.draft, STEP_FIELDS[step])
        // 바이어는 소속(기업명)이 기본정보 구획 안에 있다 — 둘 다 비워 저장하면 이름 없는 기업이 된다.
        assertKeepsName(cleared, base.draft)
        const body = buyerToApiBody(cleared)
        const api = (await transport.patchProfile("buyer", body)) as ApiBuyerProfile
        return saved(base, api)
      })
    },

    saveOperatorFields(patch, baseline) {
      return serial(async () => {
        const normalized = normalizeOperatorPatch(patch)
        // 견줄 칸 = 정규화 뒤 실제 PATCH에 실리는 칸.
        const base = await current(
          baseline,
          BUYER_OPERATOR_KEYS.filter((key) => key in normalized),
        )
        const body = buyerToApiBody(normalized as BuyerStepPatch)
        const api = (await transport.patchProfile("buyer", body)) as ApiBuyerProfile
        return saved(base, api)
      })
    },
  }
}

// 역할로 고르는 진입점 — 콘솔은 목록 행의 역할을 넘긴다.
export function createOperatorApplicationClient(
  role: OperatorApplicationRole,
  transport: OperatorApplicationTransport,
  options: { canAssignBooth: boolean },
): OperatorApplicationClient {
  return role === "exhibitor"
    ? createOperatorExhibitorClient(transport, options)
    : createOperatorBuyerClient(transport)
}
