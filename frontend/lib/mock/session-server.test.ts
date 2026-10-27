import { afterEach, describe, expect, it, vi } from "vitest"

import { DEV_MENU_COOKIE } from "./session"

// dev 참가자 메뉴 오버라이드(nabi_dev_menu 쿠키) — 목업 세션에서 전체 메뉴 화면을 보려고 명시하는 값이다.
// 다른 dev 쿠키와 같은 게이트를 탄다: dev에서만 읽고, 운영 빌드에서는 쿠키가 있어도 무시한다(누구나
// 브라우저 콘솔에서 심을 수 있는 쿠키라, 운영에서 읽으면 행사 설정을 우회하는 통로가 된다).

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
  }),
}))

async function loadWithNodeEnv(nodeEnv: string) {
  vi.resetModules()
  vi.stubEnv("NODE_ENV", nodeEnv)
  return import("./session-server")
}

afterEach(() => {
  jar.values.clear()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("requestParticipantMenuOverride", () => {
  it("dev: 쿠키 값을 그대로 돌려준다(해석은 호출부가 한다)", async () => {
    jar.values.set(DEV_MENU_COOKIE, "full")
    const { requestParticipantMenuOverride } = await loadWithNodeEnv("development")

    await expect(requestParticipantMenuOverride()).resolves.toBe("full")
  })

  it("dev: 쿠키가 없으면 undefined — 호출부가 기본값으로 접는다", async () => {
    const { requestParticipantMenuOverride } = await loadWithNodeEnv("development")

    await expect(requestParticipantMenuOverride()).resolves.toBeUndefined()
  })

  it("운영 빌드: 쿠키가 있어도 읽지 않는다", async () => {
    jar.values.set(DEV_MENU_COOKIE, "full")
    const { requestParticipantMenuOverride } = await loadWithNodeEnv("production")

    await expect(requestParticipantMenuOverride()).resolves.toBeUndefined()
  })

  it("쿠키 이름은 다른 dev 쿠키와 같은 접두사를 쓴다", () => {
    expect(DEV_MENU_COOKIE).toBe("nabi_dev_menu")
  })
})
