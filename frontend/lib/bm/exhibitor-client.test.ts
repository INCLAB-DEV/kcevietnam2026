import { describe, expect, it } from "vitest"
import { getExhibitorClient } from "./exhibitor-client"
import { mockExhibitorClient } from "./mock-exhibitor-client"

// mock 모드 보존 원칙(#P1) 계약 테스트 — 세션을 모르는 호출부(신청 폼 등)는 인자 없이 부르고,
// 그 경우 항상 mock이어야 한다. 실 세션 화면(exhibitor-profile-hub 등)만 realSession=true를 넘긴다.

describe("getExhibitorClient", () => {
  it("인자 없이 부르면 mock 클라이언트를 돌려준다(기존 신청 폼 호출부 불변)", () => {
    expect(getExhibitorClient()).toBe(mockExhibitorClient)
  })

  it("realSession=false면 mock 클라이언트를 돌려준다", () => {
    expect(getExhibitorClient(false)).toBe(mockExhibitorClient)
  })

  it("realSession=true면 mock이 아닌 별개 클라이언트(BFF 경유 http)를 돌려준다", () => {
    const client = getExhibitorClient(true)
    expect(client).not.toBe(mockExhibitorClient)
    expect(typeof client.getProfile).toBe("function")
    expect(typeof client.saveStep).toBe("function")
    expect(typeof client.submit).toBe("function")
  })
})
