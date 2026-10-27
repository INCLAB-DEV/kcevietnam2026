import { describe, expect, it } from "vitest"
import { getBuyerClient } from "./buyer-client"
import { mockBuyerClient } from "./mock-buyer-client"

// mock 모드 보존 원칙(#P1) 계약 테스트 — exhibitor-client.test.ts와 동일 패턴. 세션을 모르는
// 호출부는 인자 없이 부르고, 그 경우 항상 mock이어야 한다. 실 세션(apply-form.tsx)만 realSession=true.

describe("getBuyerClient", () => {
  it("인자 없이 부르면 mock 클라이언트를 돌려준다", () => {
    expect(getBuyerClient()).toBe(mockBuyerClient)
  })

  it("realSession=false면 mock 클라이언트를 돌려준다", () => {
    expect(getBuyerClient(false)).toBe(mockBuyerClient)
  })

  it("realSession=true면 mock이 아닌 별개 클라이언트(BFF 경유 http)를 돌려준다", () => {
    const client = getBuyerClient(true)
    expect(client).not.toBe(mockBuyerClient)
    expect(typeof client.getProfile).toBe("function")
    expect(typeof client.saveStep).toBe("function")
    expect(typeof client.submit).toBe("function")
  })
})
