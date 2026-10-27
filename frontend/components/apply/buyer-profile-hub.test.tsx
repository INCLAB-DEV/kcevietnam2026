import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import { render as rtlRender } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 허브가 저장 후 router.refresh()로 서버 컴포넌트를 갱신한다 — 테스트 환경엔 app router가 없으므로 모킹.
const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}))
// 저장 성공/실패 토스트는 화면에 Toaster를 띄우지 않고 호출로 검증한다.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: toastSuccess,
    error: toastError,
    info: vi.fn(),
  }),
}))

import { BuyerProfileHub } from "./buyer-profile-hub"
import { __resetProfilesForTest } from "@/lib/apply/buyer-profile-store"
import enMessages from "@/messages/en.json"

describe("BuyerProfileHub — BM-004 조회 허브", () => {
  beforeEach(() => {
    __resetProfilesForTest()
  })

  it("프로필 제목과 섹션을 작성 폼 구획대로 렌더한다", async () => {
    render(<BuyerProfileHub profileKey="buyer-1" />)
    expect(await screen.findByText("내 비즈매칭 프로필")).toBeInTheDocument()
    // 작성 폼(StepReview readOnly) 섹션이 그대로 노출(기본정보).
    expect(screen.getByText("1. 기본정보")).toBeInTheDocument()
    // 단계 이동 버튼("수정")은 조회 화면에 없다 — 여기선 구획 편집 다이얼로그로 고친다.
    expect(screen.queryByRole("button", { name: "수정" })).not.toBeInTheDocument()
    // 헤더에 비밀번호 변경 진입점이 신청서 상태와 무관하게 항상 렌더된다.
    expect(screen.getByRole("button", { name: "비밀번호 변경" })).toBeInTheDocument()
  })

  it("완성된 실 프로필이 없으면 데모 예시 데이터를 채워 보여준다", async () => {
    render(<BuyerProfileHub profileKey="buyer-1" />)
    // 데모 fallback의 이메일(독립 행 값)이 렌더된다.
    expect(await screen.findByText("buyer01@seoulcontent.com")).toBeInTheDocument()
  })
})

// 실 세션 경로(orgEventRoleId 있음) — FastAPI(BFF 경유) 조회/저장으로 배선되고, 조회 실패는 데모
// 폴백 없이 에러 UI로 정직하게 떨어진다(silent 데모 폴백 제거 원칙).
type ApiProfile = Record<string, unknown>

function apiProfile(over: ApiProfile = {}): ApiProfile {
  return {
    org_event_role_id: "role-1",
    application_status: "approved",
    organization_name_ko: "실 프로필 기업",
    organization_name_en: "Real Buyer Corp",
    contact_name_en: "Jane Park",
    contact_email: "jane@example.com",
    tel: "+84-90-1234-5678",
    country: "Vietnam",
    interest_categories: ["webtoon_production"],
    company_intro_en: "We distribute Korean content.",
    ...over,
  }
}

function stubFetch(get: ApiProfile, patched?: ApiProfile, patchOk = true) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (!patchOk) {
        return { ok: false, status: 422, text: async () => "rejected" }
      }
      return { ok: true, json: async () => patched ?? get }
    }
    return { ok: true, json: async () => get }
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

function patchCall(spy: ReturnType<typeof stubFetch>) {
  return spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH")
}

describe("BuyerProfileHub — 실 세션(orgEventRoleId)", () => {
  beforeEach(() => {
    refresh.mockClear()
    toastSuccess.mockClear()
    toastError.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("실 프로필을 미완성이어도 데모로 바꾸지 않고 그대로 보여준다", async () => {
    stubFetch({
      org_event_role_id: "role-1",
      application_status: "registered",
      organization_name_ko: "실 프로필 기업",
    })
    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("실 프로필 기업")).toBeInTheDocument()
    // 데모 fallback 이메일은 나오지 않는다(실 세션은 데모로 바꿔치기하지 않는다).
    expect(screen.queryByText("buyer01@seoulcontent.com")).not.toBeInTheDocument()
  })

  it("조회 실패 시 데모로 폴백하지 않고 에러 UI를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") })
    )
    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("프로필을 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.queryByText("buyer01@seoulcontent.com")).not.toBeInTheDocument()
  })

  // ── 구획별 자체 수정(마이페이지 강화) ────────────────────────────────────────
  it("승인(approved) 상태에서 기본정보 구획을 고쳐 저장하면 그 단계 PATCH가 나가고 서버 응답이 조회에 반영된다", async () => {
    const fetchSpy = stubFetch(
      apiProfile(),
      apiProfile({ contact_name_en: "Jane Kim" })
    )

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("Jane Park")).toBeInTheDocument()

    await userEvent.click(
      await screen.findByRole("button", { name: "기본정보 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    const nameEn = within(dialog).getByLabelText(/이름 \(영문\)/)
    await userEvent.clear(nameEn)
    await userEvent.type(nameEn, "Jane Kim")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(patchCall(fetchSpy)).toBeTruthy())
    const [url, init] = patchCall(fetchSpy)!
    expect(url).toBe("/api/bm/buyer/role-1/steps/1")
    expect((init as RequestInit).method).toBe("PATCH")
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.contact_name_en).toBe("Jane Kim")
    // 1단계가 소유한 필드만 — 2단계(관심분야·소개) 필드는 담기지 않는다(부분 저장).
    expect(body).not.toHaveProperty("interest_categories")
    expect(body).not.toHaveProperty("company_intro_en")
    // 운영자 소관 필드는 어떤 경우에도 실리지 않는다.
    expect(body).not.toHaveProperty("application_status")

    // 서버가 확인해 준 값이 조회에 반영된다(낙관적 갱신이 아니라 응답 반영).
    expect(await screen.findByText("Jane Kim")).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("관심분야·소개 구획도 자기 단계(steps/2)로 저장된다", async () => {
    const fetchSpy = stubFetch(apiProfile())

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    await userEvent.click(
      await screen.findByRole("button", { name: "관심분야·소개 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    const introEn = within(dialog).getByLabelText(/기업 소개 \(영문\)/)
    await userEvent.clear(introEn)
    await userEvent.type(introEn, "Updated English intro.")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(patchCall(fetchSpy)).toBeTruthy())
    const [url, init] = patchCall(fetchSpy)!
    expect(url).toBe("/api/bm/buyer/role-1/steps/2")
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.company_intro_en).toBe("Updated English intro.")
    expect(body.interest_categories).toEqual(["webtoon_production"])
    expect(body).not.toHaveProperty("contact_name_en")
  })

  it("필수 항목을 비우면 저장하지 않고 안내만 띄운다(작성 폼과 같은 검증)", async () => {
    const fetchSpy = stubFetch(apiProfile())

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    await userEvent.click(
      await screen.findByRole("button", { name: "기본정보 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.clear(within(dialog).getByLabelText(/이름 \(영문\)/))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    expect(
      await within(dialog).findByText("필수 항목을 모두 채워주세요.")
    ).toBeInTheDocument()
    expect(patchCall(fetchSpy)).toBeUndefined()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("저장이 실패하면 에러 토스트를 띄우고 조회 값은 옛 값 그대로 남는다", async () => {
    stubFetch(apiProfile(), undefined, false)

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("Jane Park")).toBeInTheDocument()

    await userEvent.click(
      await screen.findByRole("button", { name: "기본정보 수정" })
    )
    const dialog = await screen.findByRole("dialog")
    const nameEn = within(dialog).getByLabelText(/이름 \(영문\)/)
    await userEvent.clear(nameEn)
    await userEvent.type(nameEn, "Broken Save")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    // 다이얼로그는 열린 채 입력을 유지하고, 뒤의 조회 값은 서버의 옛 값 그대로 남는다.
    expect(
      within(await screen.findByRole("dialog")).getByDisplayValue("Broken Save")
    ).toBeInTheDocument()
    expect(screen.getByText("Jane Park")).toBeInTheDocument()
  })

  it("검토 대기(submitted)는 조회 전용 — 구획 수정 버튼이 없다", async () => {
    stubFetch(apiProfile({ application_status: "submitted" }))

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("Jane Park")).toBeInTheDocument()

    expect(screen.queryByRole("button", { name: /수정/ })).toBeNull()
    // 잠금 안내(주최 측 문의)가 유지된다.
    expect(screen.getByText(/주최 측에 문의해 주세요/)).toBeInTheDocument()
  })

  it("반려(rejected)도 조회 전용 — 종단 상태라 수정 버튼이 없다", async () => {
    stubFetch(apiProfile({ application_status: "rejected" }))

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(await screen.findByText("Jane Park")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /수정/ })).toBeNull()
  })

  it("보완 요청(changes_requested)도 구획을 직접 고칠 수 있다", async () => {
    stubFetch(apiProfile({ application_status: "changes_requested" }))

    render(<BuyerProfileHub profileKey="buyer-1" orgEventRoleId="role-1" />)
    expect(
      await screen.findByRole("button", { name: "기본정보 수정" })
    ).toBeInTheDocument()
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

  it("헤더·단계 제목·항목 라벨·옵션 값·구획 편집 버튼이 전부 영어로 렌더된다", async () => {
    rtlRender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BuyerProfileHub profileKey="buyer-1" />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("My business matching profile")).toBeInTheDocument()
    expect(screen.getByText("1. Basic info")).toBeInTheDocument()
    expect(screen.getByText("2. Interests & intro")).toBeInTheDocument()
    expect(screen.getByText("Organization")).toBeInTheDocument()
    expect(screen.getByText("Areas of interest")).toBeInTheDocument()
    // 옵션 코드→라벨(lib/apply/options.ts)도 영어로 바뀐다 — DEMO_BUYER_PROFILE의
    // orgTypes=["private_commercial"], annualSalesRange="usd_500k_1m".
    expect(screen.getByText("Private Company (Production/Distribution)")).toBeInTheDocument()
    expect(screen.getByText("USD 500,000 - 1,000,000")).toBeInTheDocument()
    // 새로 생긴 구획 편집 진입점도 en 메시지를 쓴다.
    expect(screen.getByRole("button", { name: "Edit Basic info" })).toBeInTheDocument()

    // 이전엔 하드코딩이던 한국어 UI 라벨은 더 이상 없다.
    expect(screen.queryByText("내 비즈매칭 프로필")).not.toBeInTheDocument()
    expect(screen.queryByText("관심분야")).not.toBeInTheDocument()
    expect(screen.queryByText("소속")).not.toBeInTheDocument()
  })
})
