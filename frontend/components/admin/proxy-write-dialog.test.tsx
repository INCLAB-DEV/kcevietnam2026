import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProxyWriteDialog } from "./proxy-write-dialog"
import { toProfilePatch, type ProfileFormState } from "./profile-editor"
import type {
  AdminEvent,
  AdminEventSettings,
  AdminExhibitorProfilePatch,
  AdminOrganization,
} from "@/lib/admin/types"

// 고객사 PPT(260904 PSA 시스템 수정 요청) 슬라이드 6·7·8 사양 회귀 테스트.
// 레이아웃(4탭)은 슬라이드를 따르고, 빨간 표시+파란 피드백 세 건만 반영됐는지를 지킨다:
//   · 상담 가능 언어 = 영어·베트남 2종 · KOTRA 회원 여부 삭제 · 전시품목 분야 = 사업분야 8종

const event: AdminEvent = {
  id: "event-1",
  name: "2026 베트남 K-콘텐츠 엑스포",
  venue_name: "KINTEX",
  exhibition_start: "2026-09-16",
  exhibition_end: "2026-09-18",
  application_start: "2026-08-26",
  application_end: "2026-09-11",
  timezone: "Asia/Ho_Chi_Minh",
}

const settings: AdminEventSettings = {
  event_id: "event-1",
  slot_minutes: 30,
  enabled_venue_types: ["zone_table"],
  allow_same_role_discovery: false,
  operating_start: "10:00",
  operating_end: "18:10",
  lunch_start: "12:10",
  lunch_end: "13:00",
  min_guaranteed_slots: 10,
  slot_gap_minutes: 0,
  max_meeting_minutes: 90,
}

function org(role: AdminOrganization["role"]): AdminOrganization {
  return {
    id: "org-1",
    event_id: "event-1",
    role,
    name_ko: "검증기업(주)",
    name_en: null,
    country: null,
    application_status: "registered",
    proxy_written: false,
    proxy_written_by: null,
    proxy_written_at: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    category: null,
    business_field_codes: [],
    content_category: null,
    booth_label: null,
    registered_by: null,
    meeting_count: 0,
    unavailable_slots: [],
    updated_at: "2026-09-16T00:00:00Z",
  }
}

function renderDialog(
  role: AdminOrganization["role"],
  opts: {
    onOpenChange?: (open: boolean) => void
    onSave?: (form: ProfileFormState) => void
  } = {},
) {
  return render(
    <ProxyWriteDialog
      open
      onOpenChange={opts.onOpenChange ?? (() => {})}
      org={org(role)}
      profile={null}
      event={event}
      settings={settings}
      approveImmediately
      onSave={opts.onSave ?? (() => {})}
    />,
  )
}

async function openProductDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "사업분야" }))
  await user.click(screen.getByRole("button", { name: "제품 추가" }))
  await screen.findByLabelText("제품명(국문)")
}

describe("신청서 대리작성 다이얼로그 — PPT 슬라이드 6·7·8 사양", () => {
  it("참가사는 4탭, 슬라이드6 피드백(언어 2종·KOTRA 삭제)을 지킨다", async () => {
    renderDialog("exhibitor")

    expect(screen.getByRole("tab", { name: "회사소개" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "사업분야" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "관심 바이어" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "비즈니스 미팅" })).toBeInTheDocument()

    // 슬라이드6 피드백 — 상담 가능 언어는 영어·베트남만 남는다.
    expect(screen.getByRole("button", { name: "영어" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "베트남어" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "한국어" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "중국어" })).not.toBeInTheDocument()

    // 슬라이드6 피드백 — KOTRA 회원 여부 체크박스는 삭제됐다.
    expect(screen.queryByText("KOTRA 회원 여부")).not.toBeInTheDocument()
  })

  it("슬라이드7 피드백 — 전시품목 분야는 방산 13종이 아니라 사업분야 8종이다", async () => {
    renderDialog("exhibitor")
    await userEvent.click(screen.getByRole("tab", { name: "사업분야" }))

    expect(screen.getByRole("button", { name: "게임 제작" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "음악 제작" })).toBeInTheDocument()
    // 구 방산 분류 칩은 남아 있으면 안 된다.
    expect(screen.queryByRole("button", { name: "기동장비" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "화력장비" })).not.toBeInTheDocument()
  })

  it("슬라이드8 — 관심 바이어 탭은 국가 검색과 구분 칩을 유지한다", async () => {
    renderDialog("exhibitor")
    await userEvent.click(screen.getByRole("tab", { name: "관심 바이어" }))

    expect(screen.getByPlaceholderText("국가 검색 (한글·영문)")).toBeInTheDocument()
    expect(screen.getByText("선호 바이어 구분")).toBeInTheDocument()
  })

  it("바이어는 참가사 전용 탭(관심 바이어·비즈니스 미팅) 없이 2탭이다", () => {
    renderDialog("buyer")

    expect(screen.getByRole("tab", { name: "회사소개" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "관심 품목" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "관심 바이어" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "비즈니스 미팅" })).not.toBeInTheDocument()
  })

  it("저장 버튼 문구는 권한에 따라 승인/제출로 갈린다", () => {
    renderDialog("exhibitor")
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeInTheDocument()
  })

  it("제품 추가를 누르면 제품 정보 입력 화면이 열린다", async () => {
    const user = userEvent.setup()
    renderDialog("exhibitor")
    await user.click(screen.getByRole("tab", { name: "사업분야" }))
    await user.click(screen.getByRole("button", { name: "제품 추가" }))

    expect(await screen.findByLabelText("제품명(국문)")).toBeInTheDocument()
    expect(screen.getByLabelText("제품명(영문)")).toBeInTheDocument()
    expect(screen.getByLabelText("HS코드")).toBeInTheDocument()
    expect(screen.getByLabelText("사양(국문)")).toBeInTheDocument()
  })

  it("제품 정보를 저장하면 전시 제품 목록에 추가된다", async () => {
    const user = userEvent.setup()
    renderDialog("exhibitor")
    await user.click(screen.getByRole("tab", { name: "사업분야" }))
    await user.click(screen.getByRole("button", { name: "제품 추가" }))
    await user.type(await screen.findByLabelText("제품명(국문)"), "지휘통제 시스템")
    await user.click(screen.getByRole("button", { name: "저장" }))

    expect(screen.getByText("지휘통제 시스템")).toBeInTheDocument()
  })
})

// 회귀 테스트 — 고객사 버그 리포트: "제품 추가 → 저장/취소/X를 누르면 대리작성 화면 자체가
// 사라진다." ProductDialog가 editingProduct 상태에 따라 부모 JSX에서 통째로 마운트/언마운트되던
// 것이 원인이었다(브라우저에서 포커스가 사라진 요소째 제거되며 body로 튀고, 부모 Dialog의
// DismissableLayer가 이를 "포커스가 바깥으로 나감"으로 잡아 부모까지 닫음). 이제 ProductDialog는
// open prop으로만 제어되고 항상 마운트돼 있어야 한다 — 아래 테스트는 부모가 실제로 열려 있는지를
// (Testing Library의 접근성 트리가 아니라) DOM에서 직접 확인한다.
describe("제품 다이얼로그 개폐가 부모 대리작성 화면을 닫지 않는다 (회귀)", () => {
  function parentDialogNode() {
    return Array.from(document.querySelectorAll('[data-slot="dialog-content"]')).find((el) =>
      el.querySelector("h2")?.textContent?.includes("신청서 대리작성"),
    )
  }

  it("제품 저장 후에도 부모 다이얼로그가 열려 있고 제품이 추가된다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog("exhibitor", { onOpenChange })
    await openProductDialog(user)
    await user.type(screen.getByLabelText("제품명(국문)"), "지휘통제 시스템")
    await user.click(screen.getByRole("button", { name: "저장" }))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(parentDialogNode()).toBeTruthy()
    expect(parentDialogNode()?.getAttribute("data-state")).toBe("open")
    expect(screen.getByText("지휘통제 시스템")).toBeInTheDocument()
  })

  it("제품 취소를 눌러도 부모 다이얼로그는 열려 있고 제품은 추가되지 않는다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog("exhibitor", { onOpenChange })
    await openProductDialog(user)
    await user.type(screen.getByLabelText("제품명(국문)"), "미저장 제품")
    await user.click(screen.getByRole("button", { name: "취소" }))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(parentDialogNode()?.getAttribute("data-state")).toBe("open")
    expect(screen.queryByText("미저장 제품")).not.toBeInTheDocument()
  })

  it("제품 다이얼로그의 X(닫기)를 눌러도 부모 다이얼로그는 열려 있다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog("exhibitor", { onOpenChange })
    await openProductDialog(user)
    await user.click(screen.getByRole("button", { name: "닫기" }))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(parentDialogNode()?.getAttribute("data-state")).toBe("open")
  })

  it("제품 다이얼로그 안에서 Escape는 제품 다이얼로그만 닫는다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog("exhibitor", { onOpenChange })
    await openProductDialog(user)
    await user.keyboard("{Escape}")

    // 부모는 onOpenChange(false)를 받지 않아야 하고, 제품 입력 필드는 사라져야 한다.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(parentDialogNode()?.getAttribute("data-state")).toBe("open")
    expect(screen.queryByLabelText("제품명(국문)")).not.toBeInTheDocument()
  })

  it("대리작성 후 승인 저장 페이로드에 추가한 제품이 담긴다", async () => {
    const user = userEvent.setup()
    let savedForm: ProfileFormState | null = null
    renderDialog("exhibitor", { onSave: (form) => { savedForm = form } })
    await openProductDialog(user)
    await user.type(screen.getByLabelText("제품명(국문)"), "지휘통제 시스템")
    await user.click(screen.getByRole("button", { name: "저장" }))
    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    expect(savedForm).not.toBeNull()
    // 느슨한 objectContaining이 아니라 ProductDialog의 EMPTY_PRODUCT 필드 전체(name_en/
    // business_field/hs_code/price_range/spec)가 정확히 담기는지 확인한다 — 이름만 채웠으니
    // 나머지는 초기값 그대로여야 한다.
    expect(savedForm!.products).toEqual([
      {
        name_ko: "지휘통제 시스템",
        name_en: "",
        business_field: null,
        hs_code: "",
        price_range: null,
        spec: "",
      },
    ])

    // BFF로 나가는 실제 patch에도 제품이 필드명 그대로 담기는지(toProfilePatch) 확인 — backend
    // ProductIn(name_ko/name_en/business_field/hs_code/spec/price_range)과 정확히 일치해야 한다.
    const patch = toProfilePatch(savedForm!, "exhibitor") as AdminExhibitorProfilePatch
    expect(patch.products).toEqual([
      {
        name_ko: "지휘통제 시스템",
        name_en: "",
        business_field: null,
        hs_code: "",
        price_range: null,
        spec: "",
      },
    ])
  })
})
