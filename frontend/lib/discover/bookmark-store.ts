// 관심기업(북마크) 스토어 — F-DV-001 D12의 deep module `bookmark-store`.
// 담기/해제 토글, 담은 출처(source: ai=AI 추천 탭 / all=전체 기업 탭) 기록, 중복 방지,
// 출처 무관 단일 목록 집계를 한곳에 캡슐화한다.
//
// **실연동(H-01)**: `NEXT_PUBLIC_AUTH_CLIENT==="http"`(실 세션 모드)에서는 FastAPI
// `interested_organizations`(BFF 경유 app/api/discover/bookmarks)가 진실원천이다 — 초기 목록을
// 서버에서 읽고, 토글은 서버에 반영한 뒤 성공해야 상태가 확정된다. 실패하면 낙관적 변경을
// 되돌리고 에러를 사용자에게 보인다(이 코드베이스의 고질병 — 낙관적 UI가 실패를 은폐하는
// 패턴을 반복하지 않는다).
// 그 외(mock/dev ?as= 모드)는 기존 localStorage 백업 + 모듈 내 메모리 상태를 그대로 유지한다
// (lib/meeting/meeting-actions.ts의 isMeetingHttpMode()와 같은 분기 관례).
//
// 전체 기업 탭·AI 추천 탭·관심기업 탭·기업 상세(DV-002, 별도 라우트)가 같은 스토어를 구독해
// 어디서 담거나 빼도 즉시 동기화된다.

import { useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

// 담은 출처. AI 추천 탭에서 담으면 "ai", 전체 기업 탭(및 그 경로의 상세)에서 담으면 "all".
// 운영팀이 "AI 추천에서 담은 경우 vs 전체 기업에서 담은 경우"의 미팅 전환율을 비교하기 위한
// 데이터 자산화 목적(F-DV-001 D12, ADR-0004 provenance 보존).
export type BookmarkSource = "ai" | "all"

export interface BookmarkEntry {
  orgId: string
  source: BookmarkSource
}

interface Snapshot {
  ids: Set<string>
  entries: BookmarkEntry[]
}

const STORAGE_KEY = "nabi:discover:bookmarks"

function httpMode(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_CLIENT === "http"
}

// orgId → 담은 출처. 키 존재 = 담김(중복 불가). 같은 기업을 두 탭에서 담아도 1건만 남는다.
let state: Record<string, BookmarkSource> = {}
let hydrated = false
// useSyncExternalStore는 변경이 없으면 동일 참조를 돌려받아야 한다 → 스냅샷을 메모이즈.
let memo: Snapshot | null = null
const listeners = new Set<() => void>()

// 서버 렌더/하이드레이션용 안정 빈 스냅샷(localStorage/서버 응답은 클라이언트에만 존재).
const EMPTY: Snapshot = { ids: new Set(), entries: [] }

// 서버 반영 실패의 종류 — messages의 discover.bookmarkToast.{loadFailed,addFailed,removeFailed} 키와 1:1.
// 이 스토어는 모듈 전역이라 훅(next-intl)을 쓸 수 없어 문구를 직접 만들지 못한다. 그래서 "무엇이
// 실패했는가"만 알리고, 화면 로케일에 맞는 문구는 구독 중인 화면(useBookmarks)이 등록해 둔 알림
// 함수가 만든다 — 예전엔 여기서 한국어 문장을 직접 띄워 EN 화면에도 한국어 토스트가 떴다.
export type BookmarkFailure = "loadFailed" | "addFailed" | "removeFailed"
let notifyFailure: (failure: BookmarkFailure) => void = () => {}

// ── mock 모드 백업(localStorage) ───────────────────────────────────────────
function readStorage(): Record<string, BookmarkSource> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, BookmarkSource>
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

// ── 실연동(H-01): FastAPI interested_organizations, BFF 경유 ──────────────
interface BookmarkOutSnake {
  target_org_id: string
  source: BookmarkSource | null
}

async function fetchServerBookmarks(): Promise<Record<string, BookmarkSource>> {
  const res = await fetch("/api/discover/bookmarks", { cache: "no-store" })
  if (!res.ok) throw new Error(`bookmark list failed (${res.status})`)
  const data = (await res.json()) as { items: BookmarkOutSnake[] }
  const next: Record<string, BookmarkSource> = {}
  for (const item of data.items) next[item.target_org_id] = item.source ?? "all"
  return next
}

// 등록은 멱등 — 이미 담겨 있으면 백엔드가 **원래 출처**를 그대로 돌려준다(app/discover/service.py
// add_bookmark). 로컬이 낙관적으로 쓴 source와 다를 수 있어 응답값으로 되맞춘다.
async function postServerBookmark(orgId: string, source: BookmarkSource): Promise<BookmarkSource> {
  const res = await fetch("/api/discover/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_org_id: orgId, source }),
  })
  if (!res.ok) throw new Error(`bookmark add failed (${res.status})`)
  const data = (await res.json()) as BookmarkOutSnake
  return data.source ?? source
}

async function deleteServerBookmark(orgId: string): Promise<void> {
  const res = await fetch(`/api/discover/bookmarks/${encodeURIComponent(orgId)}`, {
    method: "DELETE",
  })
  // 해제는 멱등이라 404는 없다(백엔드가 항상 204) — 그래도 방어적으로 성공 취급.
  if (!res.ok && res.status !== 404) throw new Error(`bookmark remove failed (${res.status})`)
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return
  hydrated = true

  if (httpMode()) {
    fetchServerBookmarks()
      .then((next) => {
        state = next
        notify()
      })
      .catch((err) => {
        console.error("[bookmark-store] 초기 목록 로드 실패", err)
        notifyFailure("loadFailed")
      })
    return
  }

  state = readStorage()
  memo = null
}

function computeSnapshot(): Snapshot {
  const entries = Object.entries(state).map(([orgId, source]) => ({ orgId, source }))
  return { ids: new Set(entries.map((e) => e.orgId)), entries }
}

function notify(): void {
  memo = null
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void): () => void {
  hydrate()
  listeners.add(onChange)
  // 다른 탭/창에서의 변경 동기화 — mock 모드 전용(서버 모드는 서버가 유일한 진실원천이라
  // localStorage storage 이벤트를 동기화 신호로 쓰지 않는다).
  const onStorage = (e: StorageEvent) => {
    if (httpMode() || e.key !== STORAGE_KEY) return
    state = readStorage()
    notify()
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

function getSnapshot(): Snapshot {
  hydrate()
  if (!memo) memo = computeSnapshot()
  return memo
}

function getServerSnapshot(): Snapshot {
  return EMPTY
}

// 토글: 담겨 있으면 해제, 없으면 source를 기록하며 담는다(첫 등록 출처가 보존된다).
// 서버 모드에서는 먼저 낙관적으로 로컬을 바꾸고 즉시 반영해 보이되(호출부 토스트 타이밍 유지),
// 서버 반영이 실패하면 되돌리고 에러를 보인다 — 실패를 숨기지 않는다.
export function toggleBookmark(orgId: string, source: BookmarkSource): void {
  hydrate()
  const wasBookmarked = orgId in state
  const previousSource = state[orgId]

  if (wasBookmarked) delete state[orgId]
  else state[orgId] = source
  notify()

  if (!httpMode()) {
    writeStorage()
    return
  }

  if (wasBookmarked) {
    deleteServerBookmark(orgId).catch((err) => {
      console.error("[bookmark-store] 해제 실패", err)
      state[orgId] = previousSource
      notify()
      notifyFailure("removeFailed")
    })
    return
  }

  postServerBookmark(orgId, source)
    .then((actualSource) => {
      // 다른 기기/탭에서 먼저 담아둔 출처가 있으면 그 값으로 되맞춘다(멱등 등록의 원래 출처 보존).
      if (orgId in state && state[orgId] !== actualSource) {
        state[orgId] = actualSource
        notify()
      }
    })
    .catch((err) => {
      console.error("[bookmark-store] 등록 실패", err)
      delete state[orgId]
      notify()
      notifyFailure("addFailed")
    })
}

// 해제(관심기업 탭/상세에서 빼기). 담겨 있지 않으면 변화 없음.
export function removeBookmark(orgId: string): void {
  hydrate()
  if (!(orgId in state)) return
  const previousSource = state[orgId]
  delete state[orgId]
  notify()

  if (!httpMode()) {
    writeStorage()
    return
  }

  deleteServerBookmark(orgId).catch((err) => {
    console.error("[bookmark-store] 해제 실패", err)
    state[orgId] = previousSource
    notify()
    notifyFailure("removeFailed")
  })
}

export function isBookmarked(orgId: string): boolean {
  hydrate()
  return orgId in state
}

export function getBookmarks(): BookmarkEntry[] {
  return getSnapshot().entries
}

// 관심기업 상태를 구독하는 훅. 탭·상세 어디서든 동일 스토어를 공유한다.
export function useBookmarks() {
  const t = useTranslations("discover.bookmarkToast")
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  // 실패 토스트 문구는 화면 로케일로 만든다(스토어는 실패 종류만 알린다 — 위 notifyFailure 주석).
  // 여러 화면이 동시에 구독해도 같은 카탈로그를 가리키므로 마지막에 등록된 것 하나면 충분하다.
  // 서버 호출 실패는 비동기로 뒤늦게 도착하므로, 첫 렌더 뒤 effect에서 등록해도 놓치지 않는다.
  useEffect(() => {
    notifyFailure = (failure) => toast.error(t(failure))
  }, [t])
  return {
    bookmarkedIds: snapshot.ids,
    entries: snapshot.entries,
    isBookmarked: (orgId: string) => snapshot.ids.has(orgId),
    toggle: toggleBookmark,
    remove: removeBookmark,
  }
}

// 테스트 전용: 메모리 + localStorage 상태를 초기화한다.
export function __resetBookmarksForTest(): void {
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
