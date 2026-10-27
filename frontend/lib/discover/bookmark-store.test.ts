import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  toggleBookmark,
  removeBookmark,
  isBookmarked,
  getBookmarks,
  __resetBookmarksForTest,
} from "./bookmark-store"

// bookmark-store deep module (F-DV-001 D12) — 외부 동작만 검증:
// 담기/해제 토글, source 기록(ai/all), 동일 기업 중복 담김 불가, 출처 무관 단일 목록.
describe("bookmark-store", () => {
  beforeEach(() => {
    __resetBookmarksForTest()
  })

  it("담기 토글 후 isBookmarked가 true가 된다", () => {
    expect(isBookmarked("e1")).toBe(false)
    toggleBookmark("e1", "all")
    expect(isBookmarked("e1")).toBe(true)
  })

  it("다시 토글하면 해제된다", () => {
    toggleBookmark("e1", "all")
    toggleBookmark("e1", "all")
    expect(isBookmarked("e1")).toBe(false)
  })

  it("담은 출처(source)를 기록한다", () => {
    toggleBookmark("e1", "ai")
    toggleBookmark("e2", "all")
    const bySource = Object.fromEntries(getBookmarks().map((b) => [b.orgId, b.source]))
    expect(bySource).toEqual({ e1: "ai", e2: "all" })
  })

  it("같은 기업을 두 출처에서 담아도 1건만 남는다(중복 불가, 첫 출처 보존)", () => {
    toggleBookmark("e1", "all") // 전체 기업 탭에서 먼저 담음
    // AI 추천 탭에서 다시 누르면 토글 → 해제, 다시 담으면 1건 유지
    toggleBookmark("e1", "ai") // 토글 → 해제
    toggleBookmark("e1", "ai") // 다시 담음
    const entries = getBookmarks().filter((b) => b.orgId === "e1")
    expect(entries).toHaveLength(1)
  })

  it("출처가 ai/all로 달라도 단일 목록으로 모인다", () => {
    toggleBookmark("e1", "ai")
    toggleBookmark("b1", "all")
    expect(getBookmarks().map((b) => b.orgId).sort()).toEqual(["b1", "e1"])
  })

  it("removeBookmark는 담긴 기업을 해제하고, 없으면 무시한다", () => {
    toggleBookmark("e1", "all")
    removeBookmark("e1")
    expect(isBookmarked("e1")).toBe(false)
    // 없는 기업 제거는 에러 없이 무시
    removeBookmark("nope")
    expect(getBookmarks()).toHaveLength(0)
  })

  it("저장된 값은 localStorage 키에 직렬화된다", () => {
    toggleBookmark("e9", "all")
    const raw = window.localStorage.getItem("nabi:discover:bookmarks")
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toEqual({ e9: "all" })
  })

  it("새로고침(모듈 재로드) 후에도 localStorage에서 복원된다", async () => {
    toggleBookmark("e1", "ai")
    toggleBookmark("b1", "all")
    // 모듈을 다시 로드해 메모리 상태를 버리고, localStorage에서만 복원되는지 확인.
    vi.resetModules()
    const fresh = await import("./bookmark-store")
    expect(fresh.isBookmarked("e1")).toBe(true)
    expect(fresh.getBookmarks().map((b) => b.orgId).sort()).toEqual(["b1", "e1"])
    // 정리: 재로드된 모듈 인스턴스의 상태도 비운다.
    fresh.__resetBookmarksForTest()
  })
})

// H-01 실연동 — NEXT_PUBLIC_AUTH_CLIENT==="http"에서는 FastAPI interested_organizations
// (BFF app/api/discover/bookmarks)가 진실원천이다. localStorage가 아니라 fetch 호출로 검증한다.
describe("bookmark-store — 실연동(http) 모드", () => {
  beforeEach(() => {
    __resetBookmarksForTest()
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function flush() {
    // hydrate()/toggle의 fetch 후속 .then/.catch 체인(fetch → json 파싱 → 상태 갱신)이 전부
    // 돌 시간을 준다 — 마이크로태스크만으로는 홉 수가 모자라 매크로태스크 경계까지 넘긴다.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("초기 목록을 GET /api/discover/bookmarks로 읽어온다", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ items: [{ target_org_id: "org-1", source: "ai" }] })
    )
    vi.stubGlobal("fetch", fetchSpy)

    isBookmarked("org-1") // hydrate() 트리거
    await flush()

    expect(fetchSpy).toHaveBeenCalledWith("/api/discover/bookmarks", { cache: "no-store" })
    expect(isBookmarked("org-1")).toBe(true)
    expect(getBookmarks()).toEqual([{ orgId: "org-1", source: "ai" }])
  })

  it("담기(POST)는 서버 API를 호출한다 — 등록 즉시 목록에 반영되고, 새 세션에서 재조회해도 남아 있다", async () => {
    // hydrate()의 초기 GET을 먼저 흘려보내(빈 목록) 뒤이은 toggle의 POST 호출과 겹치지 않게 한다.
    const initialFetch = vi.fn(async () => Response.json({ items: [] }))
    vi.stubGlobal("fetch", initialFetch)
    isBookmarked("org-1")
    await flush()

    const postFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST")
      return Response.json({ target_org_id: "org-1", source: "all" }, { status: 201 })
    })
    vi.stubGlobal("fetch", postFetch)

    toggleBookmark("org-1", "all")
    await flush()

    expect(postFetch).toHaveBeenCalledWith(
      "/api/discover/bookmarks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target_org_id: "org-1", source: "all" }),
      })
    )
    expect(isBookmarked("org-1")).toBe(true)

    // 새 세션(모듈 재하이드레이트)에서 목록을 다시 조회해도 반영돼 있다 — 서버 영속화 검증.
    vi.resetModules()
    const listFetch = vi.fn(async () =>
      Response.json({ items: [{ target_org_id: "org-1", source: "all" }] })
    )
    vi.stubGlobal("fetch", listFetch)
    const fresh = await import("./bookmark-store")
    fresh.isBookmarked("org-1")
    await flush()
    expect(fresh.getBookmarks()).toEqual([{ orgId: "org-1", source: "all" }])
    fresh.__resetBookmarksForTest()
  })

  it("등록은 멱등이다 — 이미 담겨 있으면 서버가 돌려준 원래 출처로 되맞춘다", async () => {
    const initialFetch = vi.fn(async () => Response.json({ items: [] }))
    vi.stubGlobal("fetch", initialFetch)
    isBookmarked("org-1")
    await flush()

    // 다른 기기가 먼저 "ai"로 담아둔 상태 — 이 기기가 "all"로 다시 담아도 서버는 원래 출처를 지킨다.
    const postFetch = vi.fn(async () =>
      Response.json({ target_org_id: "org-1", source: "ai" }, { status: 201 })
    )
    vi.stubGlobal("fetch", postFetch)

    toggleBookmark("org-1", "all")
    await flush()

    expect(getBookmarks()).toEqual([{ orgId: "org-1", source: "ai" }])
  })

  it("해제(DELETE)는 서버 API를 호출하고 목록에서 사라진다", async () => {
    const initialFetch = vi.fn(async () => Response.json({ items: [] }))
    vi.stubGlobal("fetch", initialFetch)
    isBookmarked("org-1")
    await flush()

    const postFetch = vi.fn(async () =>
      Response.json({ target_org_id: "org-1", source: "all" }, { status: 201 })
    )
    vi.stubGlobal("fetch", postFetch)
    toggleBookmark("org-1", "all")
    await flush()

    const deleteFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", deleteFetch)

    removeBookmark("org-1")
    await flush()

    expect(deleteFetch).toHaveBeenCalledWith("/api/discover/bookmarks/org-1", { method: "DELETE" })
    expect(isBookmarked("org-1")).toBe(false)
  })

  it("서버 등록 실패 시 낙관적 변경을 되돌린다(실패를 숨기지 않는다)", async () => {
    const initialFetch = vi.fn(async () => Response.json({ items: [] }))
    vi.stubGlobal("fetch", initialFetch)
    isBookmarked("org-1")
    await flush()

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))

    toggleBookmark("org-1", "all")
    expect(isBookmarked("org-1")).toBe(true) // 낙관적으로는 즉시 담김
    await flush()

    expect(isBookmarked("org-1")).toBe(false) // 실패 후 되돌아간다
  })

  it("서버 해제 실패 시 낙관적 변경을 되돌린다", async () => {
    const initialFetch = vi.fn(async () => Response.json({ items: [] }))
    vi.stubGlobal("fetch", initialFetch)
    isBookmarked("org-1")
    await flush()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ target_org_id: "org-1", source: "all" }, { status: 201 }))
    )
    toggleBookmark("org-1", "all")
    await flush()
    expect(isBookmarked("org-1")).toBe(true)

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))
    removeBookmark("org-1")
    expect(isBookmarked("org-1")).toBe(false) // 낙관적으로는 즉시 해제
    await flush()

    expect(isBookmarked("org-1")).toBe(true) // 실패 후 되돌아간다
  })
})
