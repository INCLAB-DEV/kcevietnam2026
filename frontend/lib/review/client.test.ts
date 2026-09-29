import { describe, expect, it } from "vitest"
import { getReviewClient } from "./client"
import { mockReviewClient } from "./mock-review-client"

// mock 모드 보존 원칙(#P1) 계약 테스트 — review-flow.tsx가 realSession prop 없이 부르면(기본값)
// 항상 mock이어야 한다. 실 세션(app/meetings/[meetingId]/page.tsx)만 realSession=true를 넘긴다.

describe("getReviewClient", () => {
  it("인자 없이 부르면 mock 클라이언트를 돌려준다", () => {
    expect(getReviewClient()).toBe(mockReviewClient)
  })

  it("realSession=false면 mock 클라이언트를 돌려준다", () => {
    expect(getReviewClient(false)).toBe(mockReviewClient)
  })

  it("realSession=true면 mock이 아닌 별개 클라이언트(BFF 경유 http, X-Org-Id 없음)를 돌려준다", () => {
    const client = getReviewClient(true)
    expect(client).not.toBe(mockReviewClient)
    expect(typeof client.getReview).toBe("function")
    expect(typeof client.saveStep1).toBe("function")
    expect(typeof client.saveStep2).toBe("function")
  })
})
