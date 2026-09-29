import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect } from "vitest"
import { OrgList } from "./org-list"
import type { Organization } from "@/lib/types"

// 참가사 목록(부스 보유) — 검색·카테고리·정렬 패싯용. 카테고리는 한강게임즈·툰브릿지가
// comics_game_music 로 겹치고 픽셀아츠 스튜디오만 animation_character(kct001tax01 3종).
const exhibitors: Organization[] = [
  { id: "1", name: "픽셀아츠 스튜디오", role: "exhibitor", keywords: ["콘텐츠 제작", "캐릭터 라이센서"], booth: { hallNo: "7", hallName: "7홀", code: "A-1" }, strength: "애니메이션 IP 확장성", contentCategory: "animation_character" },
  { id: "2", name: "한강게임즈", role: "exhibitor", keywords: ["게임 제작"], booth: { hallNo: "7", hallName: "7홀", code: "A-2" }, strength: "실감형 게임 개발력", contentCategory: "comics_game_music" },
  { id: "3", name: "툰브릿지", role: "exhibitor", keywords: ["만화웹툰 제작", "콘텐츠 제작"], booth: { hallNo: "8", hallName: "8홀", code: "B-1" }, strength: "웹툰 해외 유통망", contentCategory: "comics_game_music" },
]

// 바이어 목록(도입 시기·예산 보유) — 바이어 전용 패싯용
const buyers: Organization[] = [
  { id: "b1", name: "Seoul Content Partners", role: "buyer", keywords: ["게임 제작"], adoptionTimeline: "1년 내", budgetRange: "50억~100억" },
  { id: "b2", name: "Asia Webtoon Distribution", role: "buyer", keywords: ["만화웹툰 제작"], adoptionTimeline: "2년 내", budgetRange: "100억~500억" },
  { id: "b3", name: "Global Music Ventures", role: "buyer", keywords: ["음악 제작"], adoptionTimeline: "6개월 내", budgetRange: "500억 이상" },
]

describe("OrgList — 검색", () => {
  it("기본적으로 모든 기업을 표시한다", () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
    expect(screen.getByText("한강게임즈")).toBeInTheDocument()
    expect(screen.getByText("툰브릿지")).toBeInTheDocument()
  })

  it("회사명으로 검색하면 일치하는 기업만 남는다 (debounce 후)", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.type(screen.getByRole("searchbox"), "픽셀아츠")
    await waitFor(() => {
      expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
      expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument()
    })
  })

  it("키워드 텍스트로도 검색된다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.type(screen.getByRole("searchbox"), "게임 제작")
    await waitFor(() => {
      expect(screen.getByText("한강게임즈")).toBeInTheDocument()
      expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
    })
  })

  it("강점(strength)으로도 검색된다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.type(screen.getByRole("searchbox"), "유통망")
    await waitFor(() => {
      expect(screen.getByText("툰브릿지")).toBeInTheDocument()
      expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
    })
  })

  it("검색어를 지우면 전체 목록으로 돌아온다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    const box = screen.getByRole("searchbox")
    await userEvent.type(box, "픽셀아츠")
    await waitFor(() => expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument())
    await userEvent.clear(box)
    await waitFor(() => {
      expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
      expect(screen.getByText("한강게임즈")).toBeInTheDocument()
      expect(screen.getByText("툰브릿지")).toBeInTheDocument()
    })
  })
})

describe("OrgList — 카테고리 패싯 (참가사, kct001tax01 — 옛 전시장/Hall 패싯을 대체)", () => {
  it("카테고리를 고르면 해당 분야의 기업만 남는다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "만화,웹툰/게임/음악" }))
    expect(screen.getByText("한강게임즈")).toBeInTheDocument()
    expect(screen.getByText("툰브릿지")).toBeInTheDocument()
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
  })

  it("여러 카테고리를 고르면 OR로 합쳐진다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "만화,웹툰/게임/음악" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "애니메이션/캐릭터" }))
    expect(screen.getByText("한강게임즈")).toBeInTheDocument()
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
  })

  it("바이어 목록(카테고리 없음)에서는 카테고리 패싯을 숨긴다", () => {
    render(<OrgList orgs={buyers} viewerRole="exhibitor" />)
    expect(screen.queryByRole("button", { name: "카테고리" })).not.toBeInTheDocument()
  })
})

describe("OrgList — 도입 시기 / 예산 패싯 (바이어)", () => {
  it("도입 시기를 고르면 해당 바이어만 남는다", async () => {
    render(<OrgList orgs={buyers} viewerRole="exhibitor" />)
    await userEvent.click(screen.getByRole("button", { name: "도입 시기" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "6개월 내" }))
    expect(screen.getByText("Global Music Ventures")).toBeInTheDocument()
    expect(screen.queryByText("Seoul Content Partners")).not.toBeInTheDocument()
  })

  it("예산 범위를 고르면 해당 바이어만 남는다", async () => {
    render(<OrgList orgs={buyers} viewerRole="exhibitor" />)
    await userEvent.click(screen.getByRole("button", { name: "예산 범위" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "100억~500억" }))
    expect(screen.getByText("Asia Webtoon Distribution")).toBeInTheDocument()
    expect(screen.queryByText("Seoul Content Partners")).not.toBeInTheDocument()
  })

  it("참가사 목록에서는 도입 시기·예산 패싯을 숨긴다", () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    expect(screen.queryByRole("button", { name: "도입 시기" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "예산 범위" })).not.toBeInTheDocument()
  })
})

describe("OrgList — 매칭율 패싯 (공통)", () => {
  // 픽셀아츠(90) · 한강게임즈(60) · 툰브릿지(40)
  const scores = new Map([
    ["1", 90],
    ["2", 60],
    ["3", 40],
  ])

  it("매칭율 임계 이상 기업만 남는다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" scores={scores} />)
    await userEvent.click(screen.getByRole("button", { name: "매칭율" }))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "70%+" }))
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument() // 90
    expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument() // 60
    expect(screen.queryByText("툰브릿지")).not.toBeInTheDocument() // 40
  })

  it("점수가 없으면 매칭율 패싯을 숨긴다", () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    expect(screen.queryByRole("button", { name: "매칭율" })).not.toBeInTheDocument()
  })
})

describe("OrgList — 관심기업만 패싯 (공통)", () => {
  it("관심기업만 토글하면 담은 기업만 남는다", async () => {
    render(
      <OrgList
        orgs={exhibitors}
        viewerRole="buyer"
        bookmarkedIds={new Set(["1"])}
        onBookmark={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole("button", { name: "관심기업만" }))
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
    expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument()
  })

  it("북마크 기능이 없으면 관심기업만 패싯을 숨긴다", () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    expect(screen.queryByRole("button", { name: "관심기업만" })).not.toBeInTheDocument()
  })
})

describe("OrgList — 검색 + 패싯 결합 / 초기화", () => {
  it("검색과 패싯을 함께 적용하면 AND로 좁혀진다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "애니메이션/캐릭터" }))
    await userEvent.type(screen.getByRole("searchbox"), "픽셀아츠")
    await waitFor(() => {
      expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
      expect(screen.queryByText("한강게임즈")).not.toBeInTheDocument()
    })
  })

  it("초기화를 누르면 패싯이 모두 해제된다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: "카테고리" }))
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "만화,웹툰/게임/음악" }))
    expect(screen.queryByText("픽셀아츠 스튜디오")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "초기화" }))
    expect(screen.getByText("픽셀아츠 스튜디오")).toBeInTheDocument()
    expect(screen.getByText("툰브릿지")).toBeInTheDocument()
  })
})

describe("OrgList — 정렬", () => {
  const scores = new Map([
    ["1", 80],
    ["2", 70],
    ["3", 90],
  ])

  it("기본은 적합도순(점수 높은 순)으로 정렬한다", () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" scores={scores} />)
    const toonbridge = screen.getByText("툰브릿지")
    const pixelarts = screen.getByText("픽셀아츠 스튜디오")
    expect(toonbridge.compareDocumentPosition(pixelarts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("이름순으로 바꾸면 가나다순으로 정렬한다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" scores={scores} />)
    await userEvent.click(screen.getByRole("button", { name: /적합도순/ }))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "이름순" }))
    // "ko" 로케일 정렬: 툰브릿지 < 픽셀아츠 스튜디오 < 한강게임즈.
    const toonbridge = screen.getByText("툰브릿지")
    const pixelarts = screen.getByText("픽셀아츠 스튜디오")
    expect(toonbridge.compareDocumentPosition(pixelarts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("전시장 위치순으로 정렬한다 (A-1 < A-2 < B-1)", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.click(screen.getByRole("button", { name: /적합도순/ }))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "전시장 위치순" }))
    const pixelarts = screen.getByText("픽셀아츠 스튜디오") // A-1
    const hangang = screen.getByText("한강게임즈") // A-2
    expect(pixelarts.compareDocumentPosition(hangang) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("부스 정보가 없는 목록에서는 전시장 위치순 옵션을 숨긴다", async () => {
    render(<OrgList orgs={buyers} viewerRole="exhibitor" />)
    await userEvent.click(screen.getByRole("button", { name: /적합도순/ }))
    expect(screen.getByRole("menuitemradio", { name: "이름순" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitemradio", { name: "전시장 위치순" })).not.toBeInTheDocument()
  })
})

describe("OrgList — 빈 상태", () => {
  it("결과가 없으면 안내 메시지를 보여준다", async () => {
    render(<OrgList orgs={exhibitors} viewerRole="buyer" />)
    await userEvent.type(screen.getByRole("searchbox"), "존재하지않는기업")
    await waitFor(() => expect(screen.getByText(/검색 결과가 없습니다/)).toBeInTheDocument())
  })

  it("관심기업 모드(빈 목록)에서 전용 안내를 보여준다", () => {
    render(<OrgList orgs={[]} viewerRole="buyer" emptyLabel="관심기업이 없습니다" showFilters={false} />)
    expect(screen.getByText("관심기업이 없습니다")).toBeInTheDocument()
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
  })
})
