import { render, screen } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { ApplyForm } from "./apply-form"

// ApplyForm은 next/navigation useRouter를 쓴다(저장하고 나가기 → /welcome) — 테스트 환경에
// app router가 없으므로 모킹한다(login-flow.test와 동일 패턴).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
import { __resetProfilesForTest, saveStep } from "@/lib/apply/buyer-profile-store"
import { type BuyerProfileDraft } from "@/lib/apply/types"

beforeEach(() => {
  __resetProfilesForTest()
})

// 1~2단계를 모두 충족한 draft(제출 가능 상태). 컴포넌트 테스트는 입력 노동 대신 store에 선적재.
function completeDraft(): Partial<BuyerProfileDraft> {
  return {
    contactNameEn: "Jin Lee",
    contactEmail: "jin@seoulcontent.com",
    organizationNameEn: "Seoul Content Partners",
    country: "Korea",
    tel: "02-1234-5678",
    interestCategories: ["game_production"],
    companyIntroEn: "We buy K-content IP.",
  }
}

describe("ApplyForm — 3단계 폼 외부 동작", () => {
  it("필수 미충족 단계에서 '다음'을 누르면 진행이 막히고 오류를 표시한다", async () => {
    const user = userEvent.setup()
    render(<ApplyForm profileKey="k1" />)

    // 빈 신규 → 1단계로 진입.
    expect(await screen.findByRole("heading", { name: /1\. 기본정보/ })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "다음" }))

    expect(screen.getByText("필수 항목을 모두 채워주세요.")).toBeInTheDocument()
    // 여전히 1단계(전진 안 함).
    expect(screen.getByRole("heading", { name: /1\. 기본정보/ })).toBeInTheDocument()
  })

  it("?step=N으로 진행 가능 범위 밖을 요청하면 진행 가능한 단계로 보정한다", async () => {
    // 빈 프로필(furthest=1)인데 step=3 요청 → 1단계로 클램프.
    render(<ApplyForm profileKey="k2" initialStepParam={3} />)
    expect(await screen.findByRole("heading", { name: /1\. 기본정보/ })).toBeInTheDocument()
  })

  it("완성 프로필의 마지막(검토) 단계에서는 '저장하고 나가기'만 노출한다(제출은 /welcome)", async () => {
    saveStep("k3", 1, completeDraft())

    render(<ApplyForm profileKey="k3" initialStepParam={3} />)

    // 폼은 저장만 — 제출(application_status 전환)은 /welcome에서 일어난다(2026-06-30 결정).
    expect(await screen.findByRole("button", { name: /저장하고 나가기/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /제출하기/ })).not.toBeInTheDocument()
  })

  it("영문 소개가 500자를 넘겨도 붙여넣은 그대로 저장된다(M-02: 네이티브 maxLength 제거)", async () => {
    const user = userEvent.setup()
    saveStep("k4", 1, {
      contactNameEn: "Jin Lee",
      contactEmail: "jin@seoulcontent.com",
      organizationNameEn: "Seoul Content Partners",
      country: "Korea",
      tel: "02-1234-5678",
    })

    render(<ApplyForm profileKey="k4" initialStepParam={2} />)

    // 단어 중간이 아니라 공백 경계에서 500자를 넘기는 문장(참가사 576자 케이스와 동형).
    const longIntro = `${"A".repeat(120)} ${"B".repeat(120)} ${"C".repeat(120)} ${"D".repeat(150)}`
    expect(longIntro.length).toBeGreaterThan(500)

    const textarea = await screen.findByLabelText(/기업 소개 \(영문\)/)
    await user.click(textarea)
    await user.paste(longIntro)

    expect((textarea as HTMLTextAreaElement).value).toBe(longIntro)
  })
})
