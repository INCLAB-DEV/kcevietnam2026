// OP-005 QA B4 — "배정 후 다른 화면이 안 바뀐다"의 회귀 가드.
//
// 배정 화면들은 전부 force-dynamic이라 서버 캐시는 없지만, 브라우저 Client Cache에 프리페치된
// 옛 RSC 페이로드가 남는다. 배정 직후 이 서버 액션이 관련 경로를 전부 무효화해야 "참가기업 관리"로
// 이동했을 때 새 배정이 보인다. 경로가 빠지면 그 화면만 조용히 낡으므로 목록 자체를 잠근다.

import { describe, expect, it, vi } from "vitest"

const revalidatePath = vi.hoisted(() => vi.fn())
vi.mock("next/cache", () => ({ revalidatePath }))

import { refreshAssignmentViews } from "./assignment-refresh"
import { ASSIGNMENT_REFRESH_PATHS } from "./assignment-refresh-paths"

describe("refreshAssignmentViews (배정 후 화면 동기화)", () => {
  it("배정이 흔드는 화면을 전부 무효화한다 — 그리드·참가기업 관리·기업 상세·참가자 화면", () => {
    revalidatePath.mockClear()
    void refreshAssignmentViews()
    const called = revalidatePath.mock.calls.map((c) => c[0])
    expect(called).toEqual([
      "/organizer/forced-matching",
      "/organizer/members",
      "/organizer/members/[organizationId]",
      "/organizer",
      "/meetings",
      "/",
      "/notifications",
    ])
  })

  it("동적 세그먼트 경로는 type을 함께 넘긴다(revalidatePath 계약)", () => {
    revalidatePath.mockClear()
    void refreshAssignmentViews()
    expect(revalidatePath).toHaveBeenCalledWith("/organizer/members/[organizationId]", "page")
    // 정적 경로엔 두 번째 인자를 붙이지 않는다.
    expect(revalidatePath).toHaveBeenCalledWith("/organizer/members")
  })

  it("목록과 실제 호출 수가 어긋나지 않는다", () => {
    revalidatePath.mockClear()
    void refreshAssignmentViews()
    expect(revalidatePath).toHaveBeenCalledTimes(ASSIGNMENT_REFRESH_PATHS.length)
  })
})
