import { render, screen } from "@/lib/test/render-with-intl"
import { render as rtlRender } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BuyerProfileHub } from "./buyer-profile-hub"
import { __resetProfilesForTest } from "@/lib/apply/buyer-profile-store"
import enMessages from "@/messages/en.json"

describe("BuyerProfileHub — BM-004 조회 허브", () => {
  beforeEach(() => {
    __resetProfilesForTest()
  })

  it("프로필 제목과 섹션을 읽기전용으로 렌더한다", async () => {
    render(<BuyerProfileHub profileKey="buyer-1" />)
    expect(await screen.findByText("내 비즈매칭 프로필")).toBeInTheDocument()
    // 작성 폼(StepReview readOnly) 섹션이 그대로 노출(기본정보).
    expect(screen.getByText("1. 기본정보")).toBeInTheDocument()
    // 읽기전용이라 단계 '수정' 버튼은 없다(조회 전용, 결정 A).
    expect(screen.queryByRole("button", { name: "수정" })).not.toBeInTheDocument()
  })

  it("완성된 실 프로필이 없으면 데모 예시 데이터를 채워 보여준다", async () => {
    render(<BuyerProfileHub profileKey="buyer-1" />)
    // 데모 fallback의 이메일(독립 행 값)이 렌더된다.
    expect(await screen.findByText("buyer01@seoulcontent.com")).toBeInTheDocument()
  })
})

// 실 세션 경로(orgEventRoleId 있음) — FastAPI(BFF 경유) 조회로 배선되고, 실패는 데모 폴백 없이
// 에러 UI로 정직하게 떨어진다(silent 데모 폴백 제거 원칙).
describe("BuyerProfileHub — 실 세션(orgEventRoleId)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("실 프로필을 미완성이어도 데모로 바꾸지 않고 그대로 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            org_event_role_id: "role-1",
            application_status: "registered",
            organization_name_ko: "실 프로필 기업",
          }),
      }),
    )
    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 프로필 기업")).toBeInTheDocument()
    // 데모 fallback 이메일은 나오지 않는다(실 세션은 데모로 바꿔치기하지 않는다).
    expect(screen.queryByText("buyer01@seoulcontent.com")).not.toBeInTheDocument()
  })

  it("조회 실패 시 데모로 폴백하지 않고 에러 UI를 보여준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") }))
    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("프로필을 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.queryByText("buyer01@seoulcontent.com")).not.toBeInTheDocument()
  })
})

// 이슈 #7 — 바이어 프로필 허브가 전부 한국어였던 버그. en 로케일에서 UI 라벨(제목·설명·단계
// 타이틀·필드 라벨·옵션 값)이 영어로 바뀌는지 확인한다. draft 자체의 데이터 콘텐츠(국문 담당자
// 이름·소개 등 병기 필드)는 이 이슈의 대상이 아니다(별도 백로그: i18n-full-bilingual) — 그래서
// "화면에 한글이 전혀 없다"가 아니라 "이전엔 하드코딩이던 UI 라벨이 이제 en로 뜬다"를 검증한다.
describe("BuyerProfileHub — en 로케일", () => {
  beforeEach(() => {
    __resetProfilesForTest()
  })

  it("헤더·단계 제목·항목 라벨·옵션 값이 전부 영어로 렌더된다", async () => {
    rtlRender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BuyerProfileHub profileKey="buyer-1" />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("My Business Matching Profile")).toBeInTheDocument()
    expect(screen.getByText("1. Basic Info")).toBeInTheDocument()
    expect(screen.getByText("2. Interests & Intro")).toBeInTheDocument()
    expect(screen.getByText("Organization")).toBeInTheDocument()
    expect(screen.getByText("Areas of interest")).toBeInTheDocument()
    // 옵션 코드→라벨(lib/apply/options.ts)도 영어로 바뀐다 — DEMO_BUYER_PROFILE의
    // orgTypes=["private_commercial"], annualSalesRange="usd_500k_1m".
    expect(screen.getByText("Private Company (Production/Distribution)")).toBeInTheDocument()
    expect(screen.getByText("USD 500,000 - 1,000,000")).toBeInTheDocument()

    // 이전엔 하드코딩이던 한국어 UI 라벨은 더 이상 없다.
    expect(screen.queryByText("내 비즈매칭 프로필")).not.toBeInTheDocument()
    expect(screen.queryByText("관심분야")).not.toBeInTheDocument()
    expect(screen.queryByText("소속")).not.toBeInTheDocument()
  })
})
