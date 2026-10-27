import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { OrganizationCard } from "./organization-card"
import type { Organization } from "@/lib/types"

const exhibitor: Organization = {
  id: "org-1",
  name: "한화시스템",
  role: "exhibitor",
  keywords: ["레이더", "전자전", "C4I"],
  booth: { hallNo: "1", hallName: "제1전시관", code: "A-12" },
  strength: "국내 최고의 방산 전자전 솔루션",
  exhibits: ["다기능레이더", "전자전 장비"],
}

const buyer: Organization = {
  id: "org-2",
  name: "방위사업청",
  role: "buyer",
  keywords: ["감시정찰", "통신체계"],
  budgetRange: "50억~100억",
  adoptionTimeline: "1년 내",
}

describe("OrganizationCard — 바이어 시점(참가사 카드 조회)", () => {
  it("회사명, 전시제품, 부스 위치, 강점을 표시한다", () => {
    render(<OrganizationCard org={exhibitor} viewerRole="buyer" />)

    expect(screen.getByText("한화시스템")).toBeInTheDocument()
    expect(screen.getByText("전자전 장비")).toBeInTheDocument()
    expect(screen.getByText(/A-12/)).toBeInTheDocument()
    expect(screen.getByText("국내 최고의 방산 전자전 솔루션")).toBeInTheDocument()
  })

  it("매칭 적합도(score)가 주어지면 매칭률을 표시한다", () => {
    render(<OrganizationCard org={exhibitor} viewerRole="buyer" score={87} />)
    expect(screen.getByText(/적합도 87%/)).toBeInTheDocument()
  })

  it("개인명·직급·연락처를 카드에 노출하지 않는다", () => {
    const orgWithPersonalInfo = {
      ...exhibitor,
      contactName: "홍길동",
      contactTitle: "팀장",
      contactEmail: "hong@hanwha.com",
    }
    render(<OrganizationCard org={orgWithPersonalInfo as Organization} viewerRole="buyer" />)

    expect(screen.queryByText("홍길동")).not.toBeInTheDocument()
    expect(screen.queryByText("팀장")).not.toBeInTheDocument()
    expect(screen.queryByText("hong@hanwha.com")).not.toBeInTheDocument()
  })
})

describe("OrganizationCard — 참가사 시점(바이어 카드 조회)", () => {
  it("기관명, 키워드, 예산 범위, 도입 시기를 표시한다", () => {
    render(<OrganizationCard org={buyer} viewerRole="exhibitor" />)

    expect(screen.getByText("방위사업청")).toBeInTheDocument()
    expect(screen.getByText("감시정찰")).toBeInTheDocument()
    expect(screen.getByText(/50억~100억/)).toBeInTheDocument()
    expect(screen.getByText(/1년 내/)).toBeInTheDocument()
  })

  it("참가사 전용 필드(부스 위치·강점)를 바이어 카드에서 노출하지 않는다", () => {
    render(<OrganizationCard org={buyer} viewerRole="exhibitor" />)

    expect(screen.queryByText("A-12")).not.toBeInTheDocument()
    expect(screen.queryByText("국내 최고의 방산 전자전 솔루션")).not.toBeInTheDocument()
  })
})

describe("OrganizationCard — 접근성", () => {
  it("onClick이 있으면 카드가 키보드 포커스 가능하고 Enter/Space로 활성화된다", async () => {
    const onClick = vi.fn()
    render(<OrganizationCard org={exhibitor} viewerRole="buyer" onClick={onClick} />)

    const card = screen.getByRole("button", { name: /한화시스템/ })
    expect(card).toHaveAttribute("tabindex", "0")

    card.focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard(" ")
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it("onClick이 없으면 button role과 tabindex를 부여하지 않는다", () => {
    render(<OrganizationCard org={exhibitor} viewerRole="buyer" />)
    expect(screen.queryByRole("button", { name: /한화시스템/ })).not.toBeInTheDocument()
  })

  it("북마크 버튼은 저장 상태를 aria-pressed와 라벨로 보조기술에 노출한다", () => {
    const { rerender } = render(
      <OrganizationCard org={exhibitor} viewerRole="buyer" onBookmark={() => {}} bookmarked={false} />
    )
    const addBtn = screen.getByRole("button", { name: "관심기업 추가" })
    expect(addBtn).toHaveAttribute("aria-pressed", "false")

    rerender(
      <OrganizationCard org={exhibitor} viewerRole="buyer" onBookmark={() => {}} bookmarked />
    )
    const removeBtn = screen.getByRole("button", { name: "관심기업 해제" })
    expect(removeBtn).toHaveAttribute("aria-pressed", "true")
  })
})
