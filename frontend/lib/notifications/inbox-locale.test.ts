import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchHomeNotifications } from "@/lib/home/http-notifications-client"
import { fetchNotificationPageHttp } from "./inbox-actions"
import { fetchNotificationInboxPage } from "./http-inbox-client"

// 알림 문구는 화면이 카탈로그로 조립하지만, 그 안에 끼워 넣는 **기업명**은 백엔드 payload에서 온다. payload는
// 통지 당시의 국문명 스냅샷이라, `?locale=en`을 실어 보내야 백엔드가 읽을 때 영문명으로 옮겨 준다
// (backend/app/notifications/service.py localized_payloads). 세 조회 경로 어디서든 이 쿼리가 빠지면
// en 화면의 알림이 "…for 한강게임즈"로 돌아온다 — 그 회귀를 여기서 잡는다.

const { cookiesMock, getLocaleMock } = vi.hoisted(() => ({ cookiesMock: vi.fn(), getLocaleMock: vi.fn() }))

vi.mock("next/headers", () => ({ cookies: cookiesMock }))
vi.mock("next-intl/server", () => ({
  getLocale: getLocaleMock,
  getTranslations: async () => (key: string) => key,
}))

const EMPTY_PAGE = { items: [], unread_count: 0, next_cursor: null }
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const query = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
  new URL(String(fetchMock.mock.calls[index]?.[0]), "http://test.local").searchParams

afterEach(() => {
  vi.unstubAllGlobals()
  cookiesMock.mockReset()
  getLocaleMock.mockReset()
})

describe("알림 조회 — 화면 로케일 전달", () => {
  it("인박스 첫 페이지(서버 조회)는 화면 로케일을 싣는다", async () => {
    getLocaleMock.mockResolvedValue("en")
    cookiesMock.mockResolvedValue({ get: () => ({ value: "token" }) })
    const fetchMock = vi.fn().mockResolvedValue(okJson(EMPTY_PAGE))
    vi.stubGlobal("fetch", fetchMock)

    await fetchNotificationInboxPage("org-1")

    expect(query(fetchMock).get("locale")).toBe("en")
    expect(query(fetchMock).get("limit")).toBe("30")
  })

  it("홈 알림 카드도 같은 로케일로 조회한다", async () => {
    getLocaleMock.mockResolvedValue("en")
    cookiesMock.mockResolvedValue({ get: () => ({ value: "token" }) })
    const fetchMock = vi.fn().mockResolvedValue(okJson(EMPTY_PAGE))
    vi.stubGlobal("fetch", fetchMock)

    await fetchHomeNotifications()

    expect(query(fetchMock).get("locale")).toBe("en")
  })

  it("더보기(클라이언트 조회)는 첫 페이지와 같은 로케일을 싣는다 — 빼면 덧붙는 행만 국문명으로 돌아온다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(EMPTY_PAGE))
    vi.stubGlobal("fetch", fetchMock)

    await fetchNotificationPageHttp("org-1", "cursor-9", "en")

    expect(query(fetchMock).get("locale")).toBe("en")
    expect(query(fetchMock).get("cursor")).toBe("cursor-9")
  })

  it("한국어 화면과 지원하지 않는 로케일 값은 ko로 조회한다(저장된 스냅샷 그대로)", async () => {
    cookiesMock.mockResolvedValue({ get: () => ({ value: "token" }) })
    const fetchMock = vi.fn().mockResolvedValue(okJson(EMPTY_PAGE))
    vi.stubGlobal("fetch", fetchMock)

    getLocaleMock.mockResolvedValue("ko")
    await fetchNotificationInboxPage("org-1")
    getLocaleMock.mockResolvedValue("fr")
    await fetchNotificationInboxPage("org-1")

    expect(query(fetchMock, 0).get("locale")).toBe("ko")
    expect(query(fetchMock, 1).get("locale")).toBe("ko")
  })
})
