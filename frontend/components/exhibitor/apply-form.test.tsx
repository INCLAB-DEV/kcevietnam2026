import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ExhibitorApplyForm } from "./apply-form"

// ExhibitorApplyForm은 next/navigation useRouter를 쓴다(저장하고 나가기 → /welcome) —
// 테스트 환경에 app router가 없으므로 모킹한다(apply-form.test와 동일 패턴).
const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}))
import { getExhibitorClient } from "@/lib/bm/exhibitor-client"
import { __resetExhibitorStore } from "@/lib/bm/mock-exhibitor-client"

beforeEach(() => {
  __resetExhibitorStore()
  push.mockClear()
})

// 외부 동작만 고정한다(내부 상태 X) — RHF 전환 등 내부 구현 변경의 안전망.
// 계약: 자유 이동(게이트·필드 에러 없음) · 단계 이동 시 자동 부분저장 · 5단계 안내 문구 ·
// 저장하고 나가기 → /welcome · 제출 후 잠금(읽기 전용).

// 1~3단계 필수를 모두 채운 저장분(제출 가능 상태) — lib/bm/schemas.test.ts 픽스처와 동일 기준.
async function seedCompleteProfile(key: string) {
  const api = getExhibitorClient()
  await api.saveStep(key, 1, {
    organizationNameKo: "가상콘텐츠",
    organizationNameEn: "Virtual Content",
    attendees: [{ lastNameKo: "이", firstNameKo: "진", email: "jin@vd.com" }],
  })
  await api.saveStep(key, 2, { introKo: "국문 소개", introEn: "English intro" })
  await api.saveStep(key, 3, {
    products: [
      { nameKo: "웹툰 시리즈", nameEn: "Webtoon Series", businessField: "webtoon_production", hsCode: "4911.91" },
    ],
    exhibitionCategories: ["webtoon_production"],
  })
}

describe("ExhibitorApplyForm — 5단계 폼 외부 동작", () => {
  it("로딩 후 1단계(기본정보)로 진입하고 로스터 prefill을 읽기 전용으로 보여준다", async () => {
    render(
      <ExhibitorApplyForm
        orgEventRoleId="ex-t1"
        initialStep={1}
        registrant={{ organizationNameKo: "가상콘텐츠", organizationNameEn: "Virtual Content" }}
      />,
    )
    expect(await screen.findByRole("heading", { name: "참가사 프로필 작성" })).toBeInTheDocument()
    // prefill된 회사명이 표시된다(1단계는 읽기 전용 — 입력 필드가 아니라 텍스트).
    expect(await screen.findByText("가상콘텐츠")).toBeInTheDocument()
  })

  // QA #F: "왜 부스 정보 입력 필드가 없는지?" — 실은 있지만 항상 읽기전용(주최측 배정 스냅샷)이라
  // 눈에 안 띄었다. 섹션과 안내문구가 항상 보이는지 고정한다(설계 의도 유지 — 입력 필드 추가 아님).
  it("1단계에 부스 정보 섹션이 읽기전용으로 보이고, 주최측 배정 안내문구가 함께 표시된다", async () => {
    render(
      <ExhibitorApplyForm
        orgEventRoleId="ex-t1"
        initialStep={1}
        registrant={{ organizationNameKo: "가상콘텐츠", organizationNameEn: "Virtual Content" }}
      />,
    )
    expect(await screen.findByText("부스 정보(구분)")).toBeInTheDocument()
    expect(
      screen.getByText("부스는 참가사가 직접 입력하지 않으며, 주최측이 배정한 정보가 표시됩니다.")
    ).toBeInTheDocument()
  })

  it("미완성이어도 단계 레일로 아무 단계나 이동할 수 있다(자유 이동 — 게이트·에러 없음)", async () => {
    const user = userEvent.setup()
    render(<ExhibitorApplyForm orgEventRoleId="ex-t2" initialStep={1} />)
    await screen.findByRole("heading", { name: "참가사 프로필 작성" })

    // 빈 draft인데 4단계(타겟)로 바로 점프 — 막히지 않는다.
    await user.click(screen.getByRole("button", { name: /타겟/ }))
    expect(await screen.findByRole("heading", { level: 2, name: /타겟/ })).toBeInTheDocument()
    // 필수 미충족 에러 문구는 어디에도 없다(이 폼의 계약 — 완성 표시만, 차단 없음).
    expect(screen.queryByText(/필수 항목/)).not.toBeInTheDocument()
  })

  it("[다음]은 현재 단계 필수를 채웠을 때 서버에 부분저장한 뒤 이동한다", async () => {
    const user = userEvent.setup()
    render(<ExhibitorApplyForm orgEventRoleId="ex-t3" initialStep={2} />)
    await screen.findByRole("heading", { name: "참가사 프로필 작성" })

    // 2단계 필수(기업소개 국/영) 입력 → 다음. (textarea DOM 순서: 국문, 영문)
    const [introKo, introEn] = screen.getAllByRole("textbox")
    await user.type(introKo, "국문 소개")
    await user.type(introEn, "English intro")
    await user.click(screen.getByRole("button", { name: /다음/ }))

    // 3단계(전시품목)로 이동 + 입력이 mock 서버 store에 저장됐다.
    expect(await screen.findByRole("heading", { level: 2, name: /사업분야/ })).toBeInTheDocument()
    await waitFor(async () => {
      const saved = await getExhibitorClient().getProfile("ex-t3")
      expect(saved.introKo).toBe("국문 소개")
      expect(saved.introEn).toBe("English intro")
    })
  })

  it("[다음]에서 필수 미충족이면 이동을 막고 에러 표시 + 첫 오류 입력에 포커스한다", async () => {
    const user = userEvent.setup()
    render(<ExhibitorApplyForm orgEventRoleId="ex-t3b" initialStep={2} />)
    await screen.findByRole("heading", { name: "참가사 프로필 작성" })

    await user.click(screen.getByRole("button", { name: /다음/ }))

    // 2단계에 머무르고, 필수 오류가 표시되고, 첫 오류 필드(국문 소개)에 포커스.
    const errorMessages = await screen.findAllByText("필수 항목이에요.")
    expect(errorMessages.length).toBeGreaterThan(0)
    expect(screen.queryByRole("heading", { level: 2, name: /사업분야/ })).not.toBeInTheDocument()
    const [introKo, introEn] = screen.getAllByRole("textbox")
    await waitFor(() => expect(introKo).toHaveFocus())

    // 입력하면 그 필드의 오류가 실시간으로 사라지고, 다 채우면 통과한다.
    await user.type(introKo, "국문 소개")
    await user.type(introEn, "English intro")
    expect(screen.queryByText("필수 항목이에요.")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /다음/ }))
    expect(await screen.findByRole("heading", { level: 2, name: /사업분야/ })).toBeInTheDocument()
  })

  it("단계 레일 점프는 필수 미충족이어도 막지 않는다(자유 이동 계약 유지)", async () => {
    const user = userEvent.setup()
    render(<ExhibitorApplyForm orgEventRoleId="ex-t3c" initialStep={2} />)
    await screen.findByRole("heading", { name: "참가사 프로필 작성" })

    await user.click(screen.getByRole("button", { name: /타겟/ }))
    expect(await screen.findByRole("heading", { level: 2, name: /타겟/ })).toBeInTheDocument()
    expect(screen.queryByText("필수 항목이에요.")).not.toBeInTheDocument()
  })

  it("5단계: 필수 미완이면 '작성 필요' 안내, 완성이면 제출 가능 안내를 보여준다", async () => {
    // 미완 케이스.
    const { unmount } = render(<ExhibitorApplyForm orgEventRoleId="ex-t4a" initialStep={5} />)
    expect(await screen.findByText(/아직 채우지 않은 필수 단계가 있어요/)).toBeInTheDocument()
    unmount()

    // 완성 케이스 — store 선적재 후 재진입.
    await seedCompleteProfile("ex-t4b")
    render(<ExhibitorApplyForm orgEventRoleId="ex-t4b" initialStep={5} />)
    expect(await screen.findByText(/작성이 끝났어요/)).toBeInTheDocument()
  })

  it("[저장하고 나가기]는 현재 단계를 저장하고 /welcome으로 이동한다(제출은 폼이 안 한다)", async () => {
    const user = userEvent.setup()
    await seedCompleteProfile("ex-t5")
    render(<ExhibitorApplyForm orgEventRoleId="ex-t5" initialStep={5} />)
    await screen.findByRole("heading", { name: "참가사 프로필 작성" })

    expect(screen.queryByRole("button", { name: /제출하기/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "저장하고 나가기" }))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/welcome"))
    // 제출(submitted 전환)은 일어나지 않는다 — /welcome(WL-001)의 소관.
    const profile = await getExhibitorClient().getProfile("ex-t5")
    expect(profile.applicationStatus ?? "registered").not.toBe("submitted")
  })

  it("제출 후(submitted)는 편집 폼 대신 읽기 전용 조회로 잠긴다", async () => {
    await seedCompleteProfile("ex-t6")
    render(
      <ExhibitorApplyForm
        orgEventRoleId="ex-t6"
        initialStep={1}
        canEdit={false}
        applicationStatus="submitted"
      />,
    )
    // 편집 폼 헤더·저장 동선이 없다.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "참가사 프로필 작성" }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole("button", { name: /다음/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "저장하고 나가기" })).not.toBeInTheDocument()
    // 저장된 내용은 읽기 전용으로 보인다.
    expect(await screen.findByText("Virtual Content")).toBeInTheDocument()
  })

  it("보완 요청(changes_requested) 메모가 있으면 상단 배너로 보여준다", async () => {
    render(
      <ExhibitorApplyForm
        orgEventRoleId="ex-t7"
        initialStep={1}
        applicationStatus="changes_requested"
        reviewNote="전시품목 HS코드를 확인해 주세요."
      />,
    )
    expect(await screen.findByText("주최 측 보완 요청")).toBeInTheDocument()
    expect(screen.getByText("전시품목 HS코드를 확인해 주세요.")).toBeInTheDocument()
  })

  // 2026-09-10 — 실 추출 백엔드(/extract) 미구현 + prod가 NEXT_PUBLIC_BM_API_BASE를 안 받는 상태에서
  // 배너가 상시 노출되면 mock 데모값(스타빔레인저 등)이 사용자 신청서에 저장되는 사고로 이어졌다.
  describe("Smart Fill 배너 — 실 추출 백엔드가 붙어 있을 때만 노출", () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("NEXT_PUBLIC_BM_API_BASE가 없으면(prod 기본) 2·3단계에서도 배너를 렌더하지 않는다", async () => {
      render(<ExhibitorApplyForm orgEventRoleId="ex-t8" initialStep={2} />)
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })
      expect(
        screen.queryByRole("button", { name: "회사 자료 업로드" }),
      ).not.toBeInTheDocument()
    })

    it("NEXT_PUBLIC_BM_API_BASE가 있으면(실 백엔드 연결) 2단계에서 배너를 렌더한다", async () => {
      vi.stubEnv("NEXT_PUBLIC_BM_API_BASE", "http://localhost:8000")
      render(<ExhibitorApplyForm orgEventRoleId="ex-t9" initialStep={2} />)
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })
      expect(
        await screen.findByRole("button", { name: "회사 자료 업로드" }),
      ).toBeInTheDocument()
    })
  })

  // 2026-09-12 — 참가사 신청서 개선: 담당자 입력란 신설 + 가입정보 프리필, HS코드 선택 입력화.
  describe("담당자 추가/수정/삭제 + 가입정보 프리필", () => {
    it("1단계 기본정보에 담당자 추가 버튼과 입력란이 있다", async () => {
      render(<ExhibitorApplyForm orgEventRoleId="ex-att1" initialStep={1} />)
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })
      expect(screen.getByRole("button", { name: "담당자 추가" })).toBeInTheDocument()
    })

    it("담당자가 0명일 때 로그인 회원의 가입 정보(이름·직책·이메일·전화)로 첫 담당자를 프리필한다", async () => {
      render(
        <ExhibitorApplyForm
          orgEventRoleId="ex-att2"
          initialStep={1}
          // isReal 경로에서 회사·부스 등 가짜값 없이 담당자 연락처만 넘어오는 케이스를 흉내낸다
          // (frontend/app/exhibitor/apply/page.tsx의 realRegistrant 구성과 동일한 모양).
          registrant={{
            contactNameKo: "박담당",
            contactTitle: "해외사업팀 과장",
            contactEmail: "park@example.com",
            contactPhone: "010-1234-5678",
          }}
        />,
      )
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })
      expect(await screen.findByDisplayValue("박담당")).toBeInTheDocument()
      expect(screen.getByDisplayValue("해외사업팀 과장")).toBeInTheDocument()
      expect(screen.getByDisplayValue("park@example.com")).toBeInTheDocument()
      expect(screen.getByDisplayValue("010-1234-5678")).toBeInTheDocument()
      // 사용자가 지우고 다르게 입력할 수 있다(읽기 전용이 아니다).
      expect(screen.getByDisplayValue("박담당")).not.toHaveAttribute("readonly")
    })

    it("담당자를 추가·입력하고 저장하면 PATCH payload(attendees)에 실려 새로고침 후에도 남는다", async () => {
      const user = userEvent.setup()
      // 회사명은 미리 채워둔다(1단계 완료 조건 — 담당자 입력 자체를 좁혀서 검증하기 위한 선적재).
      const api = getExhibitorClient()
      await api.saveStep("ex-att3", 1, {
        organizationNameKo: "가상콘텐츠",
        organizationNameEn: "Virtual Content",
      })
      render(<ExhibitorApplyForm orgEventRoleId="ex-att3" initialStep={1} />)
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })

      await user.click(screen.getByRole("button", { name: "담당자 추가" }))
      const card = screen.getByText("담당자 1").closest(".p-4") as HTMLElement
      const [nameKoInput, , , emailInput] = within(card).getAllByRole("textbox")
      await user.type(nameKoInput, "최담당")
      await user.type(emailInput, "choi@example.com")

      await user.click(screen.getByRole("button", { name: /다음/ }))

      await waitFor(async () => {
        const saved = await getExhibitorClient().getProfile("ex-att3")
        expect(saved.attendees).toEqual([
          expect.objectContaining({ firstNameKo: "최담당", email: "choi@example.com" }),
        ])
      })

      // "새로고침"(재조회)해도 담당자가 남는다 — mock 클라이언트 재조회로 검증.
      const reloaded = await getExhibitorClient().getProfile("ex-att3")
      expect(reloaded.attendees?.[0]?.firstNameKo).toBe("최담당")
    })

    it("담당자를 삭제할 수 있다", async () => {
      const user = userEvent.setup()
      const api = getExhibitorClient()
      await api.saveStep("ex-att4", 1, {
        organizationNameKo: "가상콘텐츠",
        organizationNameEn: "Virtual Content",
        attendees: [{ firstNameKo: "삭제될담당자", email: "del@example.com" }],
      })
      render(<ExhibitorApplyForm orgEventRoleId="ex-att4" initialStep={1} />)
      await screen.findByDisplayValue("삭제될담당자")

      await user.click(screen.getByRole("button", { name: "담당자 1 삭제" }))
      expect(screen.queryByDisplayValue("삭제될담당자")).not.toBeInTheDocument()
    })
  })

  // 2026-09-12 — 전시 제품: HS코드를 선택 입력으로(K-콘텐츠 판권 거래엔 HS코드 개념이 없다).
  describe("전시품목 — HS코드 없이 저장·다음 단계 진행 가능", () => {
    it("HS코드를 비워도 제품명·영문명·사업분야만으로 3단계를 완료하고 다음으로 넘어간다", async () => {
      const user = userEvent.setup()
      render(<ExhibitorApplyForm orgEventRoleId="ex-hs1" initialStep={3} />)
      await screen.findByRole("heading", { name: "참가사 프로필 작성" })

      // 사업분야(exhibitionCategories) 1개 선택.
      await user.click(screen.getByRole("button", { name: "게임 제작" }))
      await user.click(screen.getByRole("button", { name: "제품 추가" }))

      const nameKoInput = screen.getByPlaceholderText("오리지널 애니메이션 시리즈")
      await user.type(nameKoInput, "웹툰 시리즈")
      const nameEnInputs = screen.getAllByRole("textbox")
      const nameEnInput = nameEnInputs[nameEnInputs.indexOf(nameKoInput) + 1]
      await user.type(nameEnInput, "Webtoon Series")

      // combobox #0 = 카테고리(단일선택, 위쪽) · #1 = 이 제품의 사업분야(카테고리).
      const categorySelect = screen.getAllByRole("combobox")[1]
      await user.selectOptions(categorySelect, "webtoon_production")

      // HS코드 입력란은 남아 있지만(선택 입력) 비워둔 채 다음으로 진행한다.
      expect(screen.getByText("HS코드 (실물 상품인 경우)")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: /다음/ }))
      expect(await screen.findByRole("heading", { level: 2, name: /타겟/ })).toBeInTheDocument()

      const saved = await getExhibitorClient().getProfile("ex-hs1")
      expect(saved.products?.[0]?.nameKo).toBe("웹툰 시리즈")
      expect(saved.products?.[0]?.hsCode ?? "").toBe("")
    })
  })
})
