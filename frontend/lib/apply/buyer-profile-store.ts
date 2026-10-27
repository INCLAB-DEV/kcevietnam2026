// 바이어 프로필 저장소 — BM-001 단계별 부분저장(이어쓰기)·조회·원자적 제출을 한곳에 캡슐화.
// 목업 단계: localStorage 백업 + 모듈 메모리 상태(bookmark-store와 동일 패턴). 한 키(프로필)당
// draft + application_status를 보관한다.
//
// backend(#26 /api/bm/buyer/{org_event_role_id}) 계약을 거울처럼 따른다:
//   loadProfile  ↔ GET    /buyer/{id}                 (재개)
//   saveStep     ↔ PATCH  /buyer/{id}/steps/{step}    (부분저장, 그 단계 필드만 변경)
//   submitProfile↔ POST   /buyer/{id}/submit          (최종저장+submitted 원자 전환)
// TODO(슬라이스 2+): 이 메모리 어댑터를 FastAPI fetch로 교체. 키=org_event_role_id(Cognito JWT가
//   소유권 판정), draft↔snake_case payload 매핑은 이 파일에 격리된다(호출처 불변).

import {
  emptyBuyerProfileDraft,
  type ApplicationStatus,
  type BuyerProfileDraft,
} from "./types"
import type { StepNumber } from "./form-state"

export interface StoredProfile {
  draft: BuyerProfileDraft
  status: ApplicationStatus
}

// Registrant prefill(ADR-0009 eager 생성) 시드 — 신규 draft 생성 시 명단/DB가 가진 소속·신청자
// 식별 정보를 미리 채운다(재입력 방지, F-BM-001 US3). 실연동 시 Cognito org/member·registrants에서 채움.
// 영문명·직위·국가 등 그 외 명단 컬럼 매핑은 주관사 명단 구조 확정 후(HITL 블로커, F-BM-001).
export interface ProfileSeed {
  organizationNameKo?: string
  organizationNameEn?: string
  website?: string
  contactNameKo?: string
  contactEmail?: string
  tel?: string
}

const STORAGE_KEY = "nabi:apply:buyer-profiles"

// key(org_event_role_id) → StoredProfile.
let state: Record<string, StoredProfile> = {}
let hydrated = false
const listeners = new Set<() => void>()
// per-key 스냅샷 메모(useSyncExternalStore 안정 참조).
let memo: Record<string, StoredProfile> = {}

function cloneDraft(d: BuyerProfileDraft): BuyerProfileDraft {
  return {
    ...d,
    orgTypes: [...d.orgTypes],
    interestCategories: [...d.interestCategories],
    attendees: d.attendees.map((a) => ({
      ...a,
      languages: [...a.languages],
      interpreterLanguages: [...a.interpreterLanguages],
    })),
    recommendedBuyers: d.recommendedBuyers.map((r) => ({ ...r })),
  }
}

// 저장된 draft를 현재 스키마로 정규화 — 폼 필드가 늘어나도(예: 신규 contact* 필드) 예전에
// 저장된 draft에 기본값을 채워 "undefined.includes" 류 런타임 오류를 막는다(전방호환).
function normalizeProfile(p: StoredProfile): StoredProfile {
  return { status: p.status, draft: { ...emptyBuyerProfileDraft(), ...p.draft } }
}

function readStorage(): Record<string, StoredProfile> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, StoredProfile>
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, StoredProfile> = {}
    for (const [key, value] of Object.entries(parsed)) out[key] = normalizeProfile(value)
    return out
  } catch {
    return {}
  }
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return
  hydrated = true
  state = readStorage()
}

function commit(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 저장 실패(quota/비공개 모드)는 메모리 상태로만 유지.
    }
  }
  listeners.forEach((l) => l())
}

function freshProfile(seed?: ProfileSeed): StoredProfile {
  const draft = emptyBuyerProfileDraft()
  if (seed) {
    if (seed.organizationNameKo) draft.organizationNameKo = seed.organizationNameKo
    if (seed.organizationNameEn) draft.organizationNameEn = seed.organizationNameEn
    if (seed.website) draft.website = seed.website
    if (seed.contactNameKo) draft.contactNameKo = seed.contactNameKo
    if (seed.contactEmail) draft.contactEmail = seed.contactEmail
    if (seed.tel) draft.tel = seed.tel
  }
  return { draft, status: "registered" }
}

// ── 조회(GET) — 없으면 시드된 신규 draft를 만들어 보관 후 반환(이어쓰기 기준점) ──────────
export function loadProfile(key: string, seed?: ProfileSeed): StoredProfile {
  hydrate()
  if (!state[key]) {
    state[key] = freshProfile(seed)
    commit()
  }
  return state[key]
}

// ── 비-변경 조회(PEEK) — 레코드가 있으면 반환, 없으면 null(드래프트를 만들지 않는다) ──────
// `loadProfile`은 없으면 시드 신규를 만들어 commit한다(이어쓰기 기준점). 그래서 시드 없이 부르면 빈
// 드래프트가 박혀 이후 `loadProfile(key, seed)`의 registrant prefill(소속·담당자)이 무시된다. 완성도
// 판정처럼 "있으면 본다"용 호출은 이 peek을 써 그 부작용(첫 작성 prefill 유실)을 피한다.
export function peekProfile(key: string): StoredProfile | null {
  hydrate()
  return state[key] ?? null
}

// ── 부분저장(PATCH) — 그 단계의 필드만 병합. 다른 단계 값은 보존(이어쓰기). status 불변 ────
export function saveStep(
  key: string,
  _step: StepNumber,
  patch: Partial<BuyerProfileDraft>,
  seed?: ProfileSeed,
): StoredProfile {
  hydrate()
  const current = state[key] ?? freshProfile(seed)
  state[key] = {
    status: current.status,
    draft: { ...cloneDraft(current.draft), ...patch },
  }
  commit()
  return state[key]
}

// message는 로그·디버깅용이다 — 화면은 이 예외의 종류(instanceof)만 보고 번역된 안내
// (welcome.actions.toastRejectedResubmit)를 띄운다(components/welcome/application-actions.tsx).
export class SubmitBlockedError extends Error {
  constructor(public readonly status: ApplicationStatus) {
    super(`submit blocked in application status: ${status}`)
    this.name = "SubmitBlockedError"
  }
}

// ── 제출(POST submit) — 최종 patch 병합 + status 전환을 한 번에(원자, 목업은 동기 1회 갱신) ──
// registered/changes_requested → submitted. approved는 멱등(유지). rejected는 재제출 차단.
// (backend service._promote_to_submitted / _guard_submittable_status 미러)
// 📝 TODO(#1, 별도 세션): "승인/제출 종단 상태 수정 불가" 정책 변경이 진행 중 — 확정되면
//   submitted/approved에서 saveStep·submitProfile를 차단하도록 가드 추가(F-BM-001 §메모, codex P1).
export function submitProfile(
  key: string,
  finalPatch?: Partial<BuyerProfileDraft>,
  seed?: ProfileSeed,
): StoredProfile {
  hydrate()
  const current = state[key] ?? freshProfile(seed)
  if (current.status === "rejected") throw new SubmitBlockedError(current.status)

  const nextStatus: ApplicationStatus =
    current.status === "approved" ? "approved" : "submitted"
  state[key] = {
    status: nextStatus,
    draft: finalPatch
      ? { ...cloneDraft(current.draft), ...finalPatch }
      : cloneDraft(current.draft),
  }
  commit()
  return state[key]
}

// ── 반응형 구독(이어쓰기 화면이 같은 소스를 본다) ──────────────────────────────────
// React 훅(useBuyerProfile)은 use-buyer-profile.ts로 분리 — 이 모듈은 React 무의존이라
// route handler(서버)에서도 import할 수 있다. 아래 3개 export는 그 훅의 재료다.
export function freshProfileSnapshot(seed?: ProfileSeed): StoredProfile {
  return freshProfile(seed)
}

export function getProfileSnapshot(key: string, seed?: ProfileSeed): StoredProfile {
  hydrate()
  const live = state[key] ?? freshProfile(seed)
  // 동일 내용이면 동일 참조를 돌려줘 무한 렌더를 막는다.
  const prev = memo[key]
  if (prev && prev.status === live.status && prev.draft === live.draft) return prev
  memo[key] = live
  return live
}

export function subscribeProfiles(onChange: () => void): () => void {
  hydrate()
  listeners.add(onChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    state = readStorage()
    memo = {}
    listeners.forEach((l) => l())
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

// 테스트 전용: 운영 슬라이스(승인/반려)가 만드는 상태를 주입한다(FE store는 직접 전이 안 함).
export function __setStatusForTest(key: string, status: ApplicationStatus): void {
  hydrate()
  const current = state[key] ?? freshProfile()
  state[key] = { status, draft: current.draft }
  commit()
}

// 테스트 전용 초기화.
export function __resetProfilesForTest(): void {
  state = {}
  memo = {}
  hydrated = false
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}
