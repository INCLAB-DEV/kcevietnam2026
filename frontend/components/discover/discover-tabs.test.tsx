import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { DiscoverTabs } from "./discover-tabs"
import { Toaster } from "@/components/ui/sonner"
import { __resetBookmarksForTest } from "@/lib/discover/bookmark-store"
import { computeRecommendations } from "@/lib/api-client/recommendations"
import { counterpartOrgs } from "@/lib/discover/visibility"
import { koTranslator } from "@/lib/i18n/ko-translator"
import type { Organization, ViewerRole } from "@/lib/types"

// 점수계산은 seam 뒤로 옮겨졌으므로(#88) 테스트는 동일 알고리즘으로 랭킹을 만들어 prop으로 주입한다.
// 추천 사유 번역기는 필수 인자 — 화면(render-with-intl)과 같은 한국어 카탈로그를 넘긴다.
function recommendationsFor(viewer: Organization, viewerRole: ViewerRole, orgs: Organization[]) {
  return computeRecommendations(viewer, counterpartOrgs(viewerRole, orgs), koTranslator("discover"))
}

// Next.js useSearchParams / useRouter mock
const mockPush = vi.fn()
let mockTab = "ai"

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => (key === "tab" ? mockTab : null) }),
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/discover",
}))

// 관심기업 스토어는 모듈 전역이라 테스트 간 누수 방지를 위해 매번 초기화.
beforeEach(() => {
  __resetBookmarksForTest()
})

describe("DiscoverTabs", () => {
  it("기본 진입 시 AI 추천 탭이 선택된다", () => {
    mockTab = "ai"
    render(<DiscoverTabs viewerRole="buyer" orgs={[]} />)
    const aiTab = screen.getByRole("tab", { name: "AI 추천기업" })
    expect(aiTab).toHaveAttribute("aria-selected", "true")
  })

  it("전체 기업 탭 클릭 시 ?tab=all 로 라우팅된다", async () => {
    mockTab = "ai"
    mockPush.mockClear()
    render(<DiscoverTabs viewerRole="buyer" orgs={[]} />)
    await userEvent.click(screen.getByRole("tab", { name: "전체 기업" }))
    expect(mockPush).toHaveBeenCalledWith("/discover?tab=all")
  })

  it("?tab=all 이면 전체 기업 탭이 선택된다", () => {
    mockTab = "all"
    render(<DiscoverTabs viewerRole="buyer" orgs={[]} />)
    expect(screen.getByRole("tab", { name: "전체 기업" })).toHaveAttribute("aria-selected", "true")
  })

  it("?tab=invalid 같은 허용값 외 값은 AI 추천 탭으로 정규화된다", () => {
    mockTab = "invalid"
    render(<DiscoverTabs viewerRole="buyer" orgs={[]} />)
    expect(screen.getByRole("tab", { name: "AI 추천기업" })).toHaveAttribute("aria-selected", "true")
  })

  it("관심기업 탭 클릭 시 ?tab=bookmarks 로 라우팅된다", async () => {
    mockTab = "ai"
    mockPush.mockClear()
    render(<DiscoverTabs viewerRole="buyer" orgs={[]} />)
    await userEvent.click(screen.getByRole("tab", { name: "관심기업" }))
    expect(mockPush).toHaveBeenCalledWith("/discover?tab=bookmarks")
  })

  it("'아니오→사유' 선택 시 추천에서 제외하고 토스트로 실행 취소를 제공한다", async () => {
    mockTab = "ai"
    const buyer: Organization = { id: "b1", name: "방위사업청", role: "buyer", keywords: ["레이더"] }
    const orgs: Organization[] = [
      buyer,
      { id: "e1", name: "한화시스템", role: "exhibitor", keywords: ["레이더"], booth: { hallNo: "1", hallName: "제1전시관", code: "A-1" } },
      { id: "e2", name: "풍산", role: "exhibitor", keywords: ["탄약"] },
    ]
    render(
      <>
        <DiscoverTabs
          viewerRole="buyer"
          orgs={orgs}
          viewerOrg={buyer}
          recommendations={recommendationsFor(buyer, "buyer", orgs)}
        />
        <Toaster />
      </>
    )

    // 점수가 높은 한화시스템이 먼저 노출
    expect(screen.getByRole("heading", { name: "한화시스템" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "아니오" }))
    await userEvent.click(screen.getByRole("button", { name: "기타" }))

    // 추천에서 제외 → 다음 카드(풍산) 노출 + 제외 토스트
    expect(await screen.findByText(/제외/)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "풍산" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "한화시스템" })).not.toBeInTheDocument()

    // 실행 취소 → 복원
    await userEvent.click(screen.getByRole("button", { name: "실행 취소" }))
    expect(await screen.findByRole("heading", { name: "한화시스템" })).toBeInTheDocument()
  })

  it("'예' 평가 시에도 토스트로 안내하고 평가 영역을 숨긴다", async () => {
    mockTab = "ai"
    const buyer: Organization = { id: "b1", name: "방위사업청", role: "buyer", keywords: ["레이더"] }
    const orgs: Organization[] = [
      buyer,
      { id: "e1", name: "한화시스템", role: "exhibitor", keywords: ["레이더"], booth: { hallNo: "1", hallName: "제1전시관", code: "A-1" } },
    ]
    render(
      <>
        <DiscoverTabs
          viewerRole="buyer"
          orgs={orgs}
          viewerOrg={buyer}
          recommendations={recommendationsFor(buyer, "buyer", orgs)}
        />
        <Toaster />
      </>
    )

    await userEvent.click(screen.getByRole("button", { name: "예" }))
    expect(await screen.findByText(/적절한 추천으로 평가/)).toBeInTheDocument()
    // 평가 영역(추천이 적절했나요?)은 사라지고 카드는 유지
    expect(screen.queryByText("추천이 적절했나요?")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "한화시스템" })).toBeInTheDocument()
  })
})

// 방향별 가시성(F-DV-001, 베트남 전시 정책): orgs prop은 이미 서버(api-client seam)에서
// 상대 역할만 걸러진 채로 내려온다 — DiscoverTabs는 다시 거르지 않고 받은 그대로 그린다
// (표시 계층에 필터를 두지 않는다, 우회 경로 차단). 세그먼트 토글(참가사↔바이어 전환)은 제거됐다.
const VIS_ORGS_EXHIBITOR_VIEWER: Organization[] = [
  // 참가사 뷰어에게 내려오는 목록은 상대(바이어)만 — 참가사가 섞여 있으면 안 된다는 걸
  // "orgs를 그대로 그린다"는 계약으로 보장(같은 역할이 섞여 오면 그것도 그대로 보인다=상위 계층 책임).
  { id: "b1", name: "방위사업청", role: "buyer", keywords: ["레이더"], buyerType: "hosted", description: "방산 전담" },
]

describe("DiscoverTabs — 전체 기업 탭(방향별 가시성은 상위 데이터 계층 책임)", () => {
  it("세그먼트 토글 UI가 없다 — 받은 orgs를 그대로 보여준다(참가사 뷰어)", () => {
    mockTab = "all"
    render(<DiscoverTabs viewerRole="exhibitor" orgs={VIS_ORGS_EXHIBITOR_VIEWER} />)
    expect(screen.queryByRole("button", { name: "바이어" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "참가사" })).not.toBeInTheDocument()
    expect(screen.getByText("방위사업청")).toBeInTheDocument()
  })

  it("세그먼트 토글 UI가 없다 — 받은 orgs를 그대로 보여준다(바이어 뷰어)", () => {
    mockTab = "all"
    const exhibitorOnly: Organization[] = [
      { id: "e1", name: "한화시스템", role: "exhibitor", keywords: ["레이더"] },
    ]
    render(<DiscoverTabs viewerRole="buyer" orgs={exhibitorOnly} />)
    expect(screen.queryByRole("button", { name: "바이어" })).not.toBeInTheDocument()
    expect(screen.getByText("한화시스템")).toBeInTheDocument()
  })
})

// 관심기업 북마크(F-DV-001 D12, 이슈 #13)
describe("DiscoverTabs — 관심기업 북마크", () => {
  const orgs: Organization[] = [
    { id: "e1", name: "한화시스템", role: "exhibitor", keywords: ["레이더"], booth: { hallNo: "1", hallName: "제1전시관", code: "A-1" } },
    { id: "e2", name: "풍산", role: "exhibitor", keywords: ["탄약"] },
  ]

  it("전체 기업 탭 카드의 하트를 누르면 토글(등록→해제)된다", async () => {
    mockTab = "all"
    render(<DiscoverTabs viewerRole="buyer" orgs={orgs} />)
    const heart = screen.getAllByRole("button", { name: "관심기업 추가" })[0]
    await userEvent.click(heart)
    // 등록되면 같은 버튼이 "관심기업 해제" 라벨로 바뀐다
    const added = await screen.findByRole("button", { name: "관심기업 해제" })
    expect(added).toHaveAttribute("aria-pressed", "true")
    // 다시 누르면 해제
    await userEvent.click(added)
    expect(await screen.findAllByRole("button", { name: "관심기업 추가" })).toHaveLength(2)
  })

  it("전체 기업 탭에서 담은 기업이 관심기업 탭에 1번 나타나고, 거기서 해제하면 사라진다", async () => {
    // 전체 기업 탭에서 한화시스템을 담는다
    mockTab = "all"
    const { unmount } = render(<DiscoverTabs viewerRole="buyer" orgs={orgs} />)
    await userEvent.click(screen.getAllByRole("button", { name: "관심기업 추가" })[0])
    unmount()

    // 관심기업 탭으로 전환 → 담은 기업이 정확히 1번 노출
    mockTab = "bookmarks"
    render(<DiscoverTabs viewerRole="buyer" orgs={orgs} />)
    expect(screen.getAllByText("한화시스템")).toHaveLength(1)
    expect(screen.queryByText("풍산")).not.toBeInTheDocument()

    // 관심기업 탭에서 해제 → 즉시 목록에서 사라지고 빈 상태 안내
    await userEvent.click(screen.getByRole("button", { name: "관심기업 해제" }))
    expect(screen.queryByText("한화시스템")).not.toBeInTheDocument()
    expect(screen.getByText("관심기업이 없습니다")).toBeInTheDocument()
  })

  it("관심기업이 0개면 빈 상태 메시지를 보여준다", () => {
    mockTab = "bookmarks"
    render(<DiscoverTabs viewerRole="buyer" orgs={orgs} />)
    expect(screen.getByText("관심기업이 없습니다")).toBeInTheDocument()
  })
})
