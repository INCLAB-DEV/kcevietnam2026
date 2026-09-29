import { StrictMode } from "react"
// 미팅 신청 모달이 useTranslations("meeting.toast")를 쓰게 되면서(실 제출 분기) 렌더 헬퍼를
// intl-aware 버전으로 바꾼다.
import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { OrganizationDetail } from "./organization-detail"
import { MeetingRequestProvider } from "@/components/meeting/meeting-request-provider"
import { MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { buildMeetingAvailability } from "@/lib/meeting/mock-availability"
import {
  toggleBookmark,
  isBookmarked,
  getBookmarks,
  __resetBookmarksForTest,
} from "@/lib/discover/bookmark-store"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// 토스트 호출 횟수를 검증하기 위해 sonner.toast를 스파이로 대체.
vi.mock("sonner", () => ({ toast: vi.fn() }))
import { toast } from "sonner"

const exhibitor = MOCK_EXHIBITORS[0] // 픽셀아츠 스튜디오 — exhibits/achievements/founded 포함

describe("OrganizationDetail", () => {
  beforeEach(() => {
    __resetBookmarksForTest()
  })

  it("카드에 없던 상세 필드(전시제품·실적·설립연도)를 렌더한다", () => {
    render(<OrganizationDetail org={exhibitor} viewerRole="buyer" backHref="/discover?tab=all" />)
    expect(screen.getByText("오리지널 애니메이션 시리즈 '스타빔레인저'")).toBeInTheDocument() // 전시 제품
    expect(screen.getByText(/오리지널 애니메이션 '스타빔레인저'/)).toBeInTheDocument() // 주요 실적
    expect(screen.getByText("2014년")).toBeInTheDocument() // 설립연도
  })

  it("전체 기업 탭 진입(match 없음)에는 적합도 배너·AI 추천 이유가 없다", () => {
    render(<OrganizationDetail org={exhibitor} viewerRole="buyer" backHref="/discover?tab=all" />)
    expect(screen.queryByText("AI 매칭 적합도")).not.toBeInTheDocument()
    expect(screen.queryByText("AI 추천 이유")).not.toBeInTheDocument()
  })

  it("AI 추천 탭 진입(match 있음)에는 적합도 배너와 추천 이유가 보인다", () => {
    render(
      <OrganizationDetail
        org={exhibitor}
        viewerRole="buyer"
        match={{ score: 82, reasons: ["관심 분야가 일치합니다", "예산 범위에 적합합니다"] }}
        backHref="/discover?tab=ai"
      />
    )
    expect(screen.getByText("82")).toBeInTheDocument()
    expect(screen.getByText("AI 매칭 적합도")).toBeInTheDocument()
    expect(screen.getByText("AI 추천 이유")).toBeInTheDocument()
    expect(screen.getByText("관심 분야가 일치합니다")).toBeInTheDocument()
  })

  it("하단 액션 바에 관심기업 토글과 미팅 신청 버튼이 있다", () => {
    render(<OrganizationDetail org={exhibitor} viewerRole="buyer" backHref="/discover?tab=all" />)
    expect(screen.getByRole("button", { name: "관심기업" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "미팅 신청" })).toBeInTheDocument()
  })

  it("로그인 사용자가 미팅 신청을 누르면 3탭 모달이 열린다(F-MT-001)", async () => {
    const user = userEvent.setup()
    // 미팅 신청은 공유 호스트(MeetingRequestProvider)가 모달을 띄운다 — 그 안에서 렌더.
    render(
      <MeetingRequestProvider>
        <OrganizationDetail
          org={exhibitor}
          viewerRole="buyer"
          backHref="/discover?tab=all"
          availability={buildMeetingAvailability(exhibitor)}
        />
      </MeetingRequestProvider>
    )
    await user.click(screen.getByRole("button", { name: "미팅 신청" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("시간")).toBeInTheDocument() // 1단계
  })

  // 상태 동기화(이슈 #13 AC): 탭에서 이미 담은 기업은 상세에서도 채워진 상태로 보인다.
  it("이미 담은 기업은 상세 진입 시 하트가 채워진 상태(aria-pressed)로 표시된다", () => {
    toggleBookmark(exhibitor.id, "all")
    render(<OrganizationDetail org={exhibitor} viewerRole="buyer" backHref="/discover?tab=all" />)
    // 하단 액션 바 버튼이 "관심기업 담김"으로 눌린 상태
    expect(screen.getByRole("button", { name: "관심기업 담김" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  // 회귀 방지: toast를 setState 업데이터 안에서 부르면 StrictMode가 2번 실행해 토스트가
  // 겹쳐 떴다 → 핸들러에서 1회만 호출되도록 보장한다.
  it("담기 한 번 클릭에 토스트는 정확히 1회만 뜬다(StrictMode에서도)", async () => {
    vi.mocked(toast).mockClear()
    // StrictMode로 감싸 setState 업데이터 이중 호출을 재현 — 토스트가 업데이터 밖에 있어야 1회.
    render(
      <StrictMode>
        <OrganizationDetail org={exhibitor} viewerRole="buyer" backHref="/discover?tab=all" />
      </StrictMode>
    )
    await userEvent.click(screen.getByRole("button", { name: "관심기업" }))
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it("상세에서 담으면 진입 출처(bookmarkSource)가 스토어에 기록된다", async () => {
    render(
      <OrganizationDetail
        org={exhibitor}
        viewerRole="buyer"
        backHref="/discover?tab=ai"
        bookmarkSource="ai"
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "관심기업" }))
    expect(isBookmarked(exhibitor.id)).toBe(true)
    expect(getBookmarks().find((b) => b.orgId === exhibitor.id)?.source).toBe("ai")
  })
})
