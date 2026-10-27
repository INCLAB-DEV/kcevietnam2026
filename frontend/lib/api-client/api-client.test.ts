import { afterEach, describe, it, expect, vi } from "vitest"
import { serverApiClient } from "./server"
import { sessionApiClient } from "./session"
import type { UserRole } from "@/components/layout/nav"

afterEach(() => {
  vi.unstubAllGlobals()
})

// 읽기는 server-only 어댑터(serverApiClient), 세션/뮤테이션은 클라 안전 어댑터(sessionApiClient).
// 두 표면이 분리돼도 형상은 보존된다(frontend ADR-0001). vitest는 `server-only`를 noop으로 alias한다.
describe("serverApiClient (read)", () => {
  it("getUser returns a user with a valid role", async () => {
    const user = await serverApiClient.getUser("user-buyer-01")
    const validRoles: UserRole[] = ["buyer", "exhibitor", "organizer"]
    expect(validRoles).toContain(user.role)
    expect(user.id).toBe("user-buyer-01")
    expect(typeof user.name).toBe("string")
  })

  it("getUser returns organizer role for organizer fixture", async () => {
    const user = await serverApiClient.getUser("user-organizer-01")
    expect(user.role).toBe("organizer")
  })

  it("getMeetings returns an array", async () => {
    const meetings = await serverApiClient.getMeetings("user-buyer-01")
    expect(Array.isArray(meetings)).toBe(true)
  })
})

describe("sessionApiClient (session/mutation)", () => {
  it("recordRecommendationFeedback resolves", async () => {
    await expect(
      sessionApiClient.recordRecommendationFeedback({
        targetOrgId: "ex-001",
        appropriate: false,
        reason: "분야가 맞지 않음",
      })
    ).resolves.toBeUndefined()
  })

  it("logout resolves", async () => {
    await expect(sessionApiClient.logout()).resolves.toBeUndefined()
  })

  it("logout은 httpOnly 실 세션 쿠키 삭제를 위해 /api/auth/logout을 POST한다", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await sessionApiClient.logout()

    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" })
  })

  it("logout은 라우트 호출이 실패해도(네트워크 오류) 예외 없이 끝난다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )

    await expect(sessionApiClient.logout()).resolves.toBeUndefined()
  })
})
