// 추천 피드백(적절/부적절) 로컬 영속 — F-DV-001 "추천이 적절했나요?" 위젯의 응답을 기록해
// 재방문(카드 이동/탭 전환/재마운트) 시 이미 답한 기업에는 다시 묻지 않는다.
// 응답은 기업(orgId) 단위 — 화면 전체 1회가 아니라 카드마다 각자 답한다.
//
// 백엔드 저장 엔드포인트는 아직 없다(lib/api-client/session.ts의 recordRecommendationFeedback은
// TODO(#14) 콘솔 스텁) — 엔드포인트가 생기면 bookmark-store.ts처럼 httpMode() 분기로 서버 모드를
// 추가한다. 그 전까지는 localStorage가 유일한 진실원천(최소 구현, 과설계 금지).

import { useSyncExternalStore } from "react"

export type FeedbackAnswer = "appropriate" | "inappropriate"

const STORAGE_KEY = "nabi:discover:recommendation-feedback"

// orgId → 응답. 키 존재 = 이미 답함.
let state: Record<string, FeedbackAnswer> = {}
let hydrated = false
// useSyncExternalStore는 변경이 없으면 동일 참조를 돌려받아야 한다 → 스냅샷을 메모이즈.
let memo: ReadonlySet<string> | null = null
const listeners = new Set<() => void>()

// 서버 렌더/하이드레이션용 안정 빈 스냅샷(localStorage는 클라이언트에만 존재).
const EMPTY: ReadonlySet<string> = new Set()

function readStorage(): Record<string, FeedbackAnswer> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, FeedbackAnswer>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeStorage(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 저장 실패(quota/비공개 모드)는 메모리 상태로만 유지 — 동작은 이어간다.
  }
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return
  hydrated = true
  state = readStorage()
}

function notify(): void {
  memo = null
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void): () => void {
  hydrate()
  listeners.add(onChange)
  // 다른 탭/창에서의 변경 동기화.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    state = readStorage()
    notify()
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

function getSnapshot(): ReadonlySet<string> {
  hydrate()
  if (!memo) memo = new Set(Object.keys(state))
  return memo
}

function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY
}

// 기업 하나에 대한 응답을 기록한다. 같은 기업을 다시 평가하면 최신 응답으로 덮어쓴다.
export function recordFeedback(orgId: string, answer: FeedbackAnswer): void {
  hydrate()
  state[orgId] = answer
  writeStorage()
  notify()
}

export function getFeedbackAnswer(orgId: string): FeedbackAnswer | undefined {
  hydrate()
  return state[orgId]
}

// 응답을 지운다 — "실행 취소"(부적절 → 되돌리기) 시 다음 방문에서 다시 제외되지 않도록.
export function clearFeedback(orgId: string): void {
  hydrate()
  if (!(orgId in state)) return
  delete state[orgId]
  writeStorage()
  notify()
}

// 피드백 응답 상태를 구독하는 훅 — 이미 답한 기업 집합(ratedIds)을 돌려준다.
export function useFeedbackAnswers() {
  const ratedIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return {
    ratedIds,
    isRated: (orgId: string) => ratedIds.has(orgId),
    answerFor: getFeedbackAnswer,
    record: recordFeedback,
  }
}

// 테스트 전용: 메모리 + localStorage 상태를 초기화한다.
export function __resetFeedbackForTest(): void {
  state = {}
  memo = null
  hydrated = false
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}
