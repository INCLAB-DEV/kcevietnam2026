import { afterEach, describe, expect, it, vi } from "vitest"
// 공용 Dialog의 닫기 라벨이 next-intl(common.close)에서 오므로 intl provider로 감싸 렌더한다.
import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
import { toast } from "sonner"
import { ProxyWriteDialog } from "./proxy-write-dialog"
import {
  EMPTY_PROFILE_FORM,
  toProxyProfilePatch,
  type ProfileFormState,
} from "./proxy-profile-form"
import type {
  AdminEvent,
  AdminEventSettings,
  AdminExhibitorProfilePatch,
  AdminOrganization,
} from "@/lib/admin/types"
import {
  OperatorRequestError,
  type OperatorApplicationTransport,
  type OperatorOrgDetailApi,
} from "@/lib/operator/application-client"
import { recordingTransport, type RecordingTransport } from "@/lib/test/operator-application"

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
  participant_menu: "meetings_only",
  participant_email_enabled: true,
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

// 서버가 돌려주는 미신청 기업의 상세 — 프로필 행이 아직 없어도 백엔드는 빈 프로필을 돌려준다.
// profile로 "참가자가 써 둔 초안" 값을 얹는다.
function registeredDetail(
  role: AdminOrganization["role"],
  profile: Record<string, unknown> = {},
): OperatorOrgDetailApi {
  const base = {
    org_event_role_id: "role-1",
    application_status: "registered",
    organization_name_ko: "검증기업(주)",
    ...profile,
  }
  return {
    id: "org-1",
    org_event_role_id: "role-1",
    event_id: "event-1",
    name_ko: "검증기업(주)",
    name_en: null,
    is_exhibitor: role === "exhibitor",
    is_buyer: role === "buyer",
    application_status: "registered",
    proxy_written_by_organizer_id: null,
    exhibitor_profile: role === "exhibitor" ? base : null,
    buyer_profile: role === "buyer" ? base : null,
  } as unknown as OperatorOrgDetailApi
}

type OnSave = (form: ProfileFormState, initial: ProfileFormState) => Promise<boolean>

function mountDialog(
  role: AdminOrganization["role"],
  transport: OperatorApplicationTransport,
  opts: { onOpenChange?: (open: boolean) => void; onSave?: OnSave; isMaster?: boolean } = {},
) {
  const isMaster = opts.isMaster ?? true
  return render(
    <ProxyWriteDialog
      open
      onOpenChange={opts.onOpenChange ?? (() => {})}
      org={org(role)}
      createTransport={() => transport}
      event={event}
      settings={settings}
      approveImmediately={isMaster}
      canEditSlots={isMaster}
      onSave={opts.onSave ?? (async () => true)}
    />,
  )
}

// 다이얼로그를 열고, 서버에서 읽기가 끝나 폼이 그려질 때까지 기다린다.
async function renderDialog(
  role: AdminOrganization["role"],
  opts: {
    onOpenChange?: (open: boolean) => void
    onSave?: OnSave
    profile?: Record<string, unknown>
    isMaster?: boolean
  } = {},
): Promise<RecordingTransport> {
  const recorder = recordingTransport(registeredDetail(role, opts.profile), null)
  mountDialog(role, recorder.transport, opts)
  await screen.findByRole("tab", { name: "회사소개" })
  return recorder
}

async function openProductDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "사업분야" }))
  await user.click(screen.getByRole("button", { name: "제품 추가" }))
  await screen.findByLabelText("제품명(국문)")
}

describe("신청서 대리작성 다이얼로그 — PPT 슬라이드 6·7·8 사양", () => {
  it("참가사는 4탭, 슬라이드6 피드백(언어 2종·KOTRA 삭제)을 지킨다", async () => {
    await renderDialog("exhibitor")

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
    await renderDialog("exhibitor")
    await userEvent.click(screen.getByRole("tab", { name: "사업분야" }))

    expect(screen.getByRole("button", { name: "게임 제작" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "음악 제작" })).toBeInTheDocument()
    // 구 방산 분류 칩은 남아 있으면 안 된다.
    expect(screen.queryByRole("button", { name: "기동장비" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "화력장비" })).not.toBeInTheDocument()
  })

  it("슬라이드8 — 관심 바이어 탭은 국가 검색과 구분 칩을 유지한다", async () => {
    await renderDialog("exhibitor")
    await userEvent.click(screen.getByRole("tab", { name: "관심 바이어" }))

    expect(screen.getByPlaceholderText("국가 검색 (한글·영문)")).toBeInTheDocument()
    expect(screen.getByText("선호 바이어 구분")).toBeInTheDocument()
  })

  it("바이어는 참가사 전용 탭(관심 바이어·비즈니스 미팅) 없이 2탭이다", async () => {
    await renderDialog("buyer")

    expect(screen.getByRole("tab", { name: "회사소개" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "관심 품목" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "관심 바이어" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "비즈니스 미팅" })).not.toBeInTheDocument()
  })

  it("저장 버튼 문구는 권한에 따라 승인/제출로 갈린다", async () => {
    await renderDialog("exhibitor")
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeInTheDocument()
  })

  it("제품 추가를 누르면 제품 정보 입력 화면이 열린다", async () => {
    const user = userEvent.setup()
    await renderDialog("exhibitor")
    await user.click(screen.getByRole("tab", { name: "사업분야" }))
    await user.click(screen.getByRole("button", { name: "제품 추가" }))

    expect(await screen.findByLabelText("제품명(국문)")).toBeInTheDocument()
    expect(screen.getByLabelText("제품명(영문)")).toBeInTheDocument()
    expect(screen.getByLabelText("HS코드")).toBeInTheDocument()
    expect(screen.getByLabelText("사양(국문)")).toBeInTheDocument()
  })

  it("제품 정보를 저장하면 전시 제품 목록에 추가된다", async () => {
    const user = userEvent.setup()
    await renderDialog("exhibitor")
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
    await renderDialog("exhibitor", { onOpenChange })
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
    await renderDialog("exhibitor", { onOpenChange })
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
    await renderDialog("exhibitor", { onOpenChange })
    await openProductDialog(user)
    await user.click(screen.getByRole("button", { name: "닫기" }))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(parentDialogNode()?.getAttribute("data-state")).toBe("open")
  })

  it("제품 다이얼로그 안에서 Escape는 제품 다이얼로그만 닫는다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    await renderDialog("exhibitor", { onOpenChange })
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
    await renderDialog("exhibitor", {
      onSave: async (form) => {
        savedForm = form
        return true
      },
    })
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

    // BFF로 나가는 실제 patch에도 제품이 필드명 그대로 담기는지(toProxyProfilePatch) 확인 — backend
    // ProductIn(name_ko/name_en/business_field/hs_code/spec/price_range)과 정확히 일치해야 한다.
    const patch = toProxyProfilePatch(
      savedForm!,
      "exhibitor",
      EMPTY_PROFILE_FORM,
    ) as AdminExhibitorProfilePatch
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

// 저장은 서버 확인까지 기다린다 — 예전엔 결과와 무관하게 즉시 닫혀, 실패 토스트가 "입력은 그대로 남아
// 있습니다"라고 말하는 동안 입력이 사라졌다.
describe("대리작성 저장 — 실패하면 닫지 않고 입력을 유지한다", () => {
  it("저장이 실패하면(false) 다이얼로그를 닫지 않고 입력이 그대로 남아 다시 저장할 수 있다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onSave = vi.fn<OnSave>().mockResolvedValue(false)
    await renderDialog("exhibitor", { onOpenChange, onSave })

    await user.type(screen.getByLabelText("기업소개(영문)"), "Our studio")
    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Our studio")
    // 잠금이 풀려 같은 자리에서 다시 저장할 수 있다.
    await waitFor(() => expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1][0].company_intro_en).toBe("Our studio")
  })

  it("응답을 기다리는 동안에는 저장·취소·닫기가 막힌다(두 번째 대리작성 요청은 409다)", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    let finish: (ok: boolean) => void = () => {}
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    await renderDialog("exhibitor", { onOpenChange, onSave })

    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeDisabled())
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(onSave).toHaveBeenCalledTimes(1)

    finish(false)
    await waitFor(() => expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled())
  })

  it("저장이 성공해도 스스로 닫지 않는다 — 콘솔이 신청서 편집 패널로 바꿔 연다", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onSave = vi.fn<OnSave>().mockResolvedValue(true)
    await renderDialog("exhibitor", { onOpenChange, onSave })

    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

// 초깃값은 열 때마다 서버에서 읽는다 — 목록 화면에 실려 온 값을 쓰면 참가자가 그 뒤 써 둔 초안이 보이지
// 않고, 그 옛 값을 기준으로 저장하게 된다. 읽지 못하면 모르는 채로 저장하게 두지 않는다.
describe("대리작성 — 열 때 서버에서 읽는다", () => {
  afterEach(() => vi.clearAllMocks())

  it("서버의 현재 프로필(참가자가 써 둔 초안)로 폼을 채우고, 그 값을 초깃값으로 onSave에 넘긴다", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<OnSave>().mockResolvedValue(true)
    const recorder = await renderDialog("exhibitor", {
      onSave,
      profile: {
        intro_en: "Draft written by the participant",
        website: "https://draft.example",
        exhibition_categories: ["game_production"],
        products: [{ name_ko: "초안 제품", name_en: "Draft product" }],
      },
    })

    expect(recorder.loads()).toBe(1)
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Draft written by the participant")
    expect(screen.getByLabelText("홈페이지")).toHaveValue("https://draft.example")
    await user.click(screen.getByRole("tab", { name: "사업분야" }))
    expect(screen.getByText("초안 제품")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "게임 제작" })).toHaveAttribute("aria-pressed", "true")

    // 한 칸만 고쳐 저장한다.
    await user.click(screen.getByRole("tab", { name: "회사소개" }))
    await user.type(screen.getByLabelText("회사소개(국문)"), "운영자가 채운 소개")
    await user.click(screen.getByRole("button", { name: "대리작성 후 승인" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [form, initial] = onSave.mock.calls[0]
    expect(initial.company_intro_en).toBe("Draft written by the participant")
    expect(initial.products).toEqual([{ name_ko: "초안 제품", name_en: "Draft product" }])
    // 콘솔이 만드는 본문에는 운영자가 바꾼 칸만 있다 — 초안 값은 되보내지 않는다.
    expect(toProxyProfilePatch(form, "exhibitor", initial)).toEqual({ intro_ko: "운영자가 채운 소개" })
  })

  it("읽는 동안에는 폼을 그리지 않고 저장을 막는다", async () => {
    let finish: (value: { detail: OperatorOrgDetailApi; slotGrid: null }) => void = () => {}
    const transport: OperatorApplicationTransport = {
      getDetail: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      patchProfile: vi.fn(),
      patchUnavailableSlots: vi.fn(),
    }
    const onSave = vi.fn<OnSave>().mockResolvedValue(true)
    mountDialog("exhibitor", transport, { onSave })

    expect(screen.getByLabelText("신청서를 불러오는 중")).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "회사소개" })).not.toBeInTheDocument()
    const save = screen.getByRole("button", { name: "대리작성 후 승인" })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()

    finish({ detail: registeredDetail("exhibitor", { intro_en: "Loaded" }), slotGrid: null })
    expect(await screen.findByLabelText("기업소개(영문)")).toHaveValue("Loaded")
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled()
  })

  it("읽기에 실패하면 빈 폼 대신 안내와 다시 불러오기를 보여 주고, 저장할 수 없다", async () => {
    const recorder = recordingTransport(registeredDetail("exhibitor", { intro_en: "Server value" }), null)
    recorder.failNextLoad(new OperatorRequestError(0, "network"))
    const onSave = vi.fn<OnSave>().mockResolvedValue(true)
    mountDialog("exhibitor", recorder.transport, { onSave })

    expect(await screen.findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.getByText(/서버의 현재 값을 확인해야 대리작성할 수/)).toBeInTheDocument()
    expect(screen.queryByLabelText("기업소개(영문)")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()

    // 다시 불러오면 서버 값으로 폼이 열린다.
    await userEvent.click(screen.getByRole("button", { name: "다시 불러오기" }))
    expect(await screen.findByLabelText("기업소개(영문)")).toHaveValue("Server value")
    expect(screen.getByRole("button", { name: "대리작성 후 승인" })).toBeEnabled()
    expect(recorder.loads()).toBe(2)
  })

  it("바이어도 서버의 현재 값으로 채운다", async () => {
    await renderDialog("buyer", {
      profile: { company_intro_en: "Buyer draft", contact_language: "vi" },
    })
    expect(screen.getByLabelText("기업소개(영문)")).toHaveValue("Buyer draft")
    expect(screen.getByLabelText("상담 언어")).toHaveValue("vi")
  })
})

// 미팅 불가 시간은 칸을 누르면 바로 저장한다(전용 엔드포인트, 전체 치환). 실패했는데 칸이 지정된 채 남으면
// 운영자는 저장된 줄 안다. 격자의 초깃값도 서버에서 읽고, 보내기 직전에 서버의 지금 목록과 견준다.
describe("대리작성 — 미팅 불가 시간", () => {
  afterEach(() => vi.clearAllMocks())

  async function openMeetingTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "비즈니스 미팅" }))
  }

  it("격자는 서버에서 읽은 불가 시간으로 시작하고, 칸을 누르면 전체 목록을 보낸다", async () => {
    const user = userEvent.setup()
    const recorder = await renderDialog("exhibitor", {
      profile: { unavailable_meeting_slots: ["2026-09-17T10:00"] },
    })
    await openMeetingTab(user)
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(recorder.slotCalls).toHaveLength(1))
    // 서버에 있던 칸을 포함한 전체 목록.
    expect(recorder.slotCalls[0]).toEqual(["2026-09-16T10:00", "2026-09-17T10:00"])
    expect(await screen.findByText("불가 2칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 해제/ })).toBeInTheDocument()
  })

  it("저장이 실패하면 방금 누른 칸을 되돌리고 알린다", async () => {
    const user = userEvent.setup()
    const recorder = await renderDialog("exhibitor")
    await openMeetingTab(user)

    recorder.failNextSave(new OperatorRequestError(403, "운영자(master) 권한이 필요합니다"))
    await user.click(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("미팅 불가 시간 저장에 실패했어요")
    expect(await screen.findByText("불가 0칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ })).toBeEnabled()
    expect(recorder.slotCalls).toHaveLength(0)
  })

  it("보내기 직전의 재조회가 실패해도(네트워크 단절) 되돌리고 격자 잠금을 푼다", async () => {
    const user = userEvent.setup()
    const recorder = await renderDialog("exhibitor")
    await openMeetingTab(user)

    recorder.failNextLoad(new OperatorRequestError(0, "network"))
    await user.click(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByText("불가 0칸")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ })).toBeEnabled(),
    )
    expect(recorder.slotCalls).toHaveLength(0)
  })

  // 미팅 불가 시간은 master 전용 쓰기다(백엔드가 sub에게 403). 눌리는 격자를 보여 주면 권한 없는 편집 UI가
  // 열리고, 누를 때마다 무의미한 조회·403 요청이 나간다 — 신청서 편집 패널과 같은 기준으로 읽기 전용이다.
  it("sub에게는 격자가 읽기 전용이고 안내가 붙는다 — 눌러도 요청이 나가지 않는다", async () => {
    const user = userEvent.setup()
    const recorder = await renderDialog("exhibitor", {
      isMaster: false,
      profile: { unavailable_meeting_slots: ["2026-09-17T10:00"] },
    })
    await openMeetingTab(user)

    expect(screen.getByText(/미팅 불가 시간은 슈퍼관리자가 지정합니다/)).toBeInTheDocument()
    expect(screen.queryByText(/칸을 누르면 바로 저장됩니다/)).not.toBeInTheDocument()
    // 저장된 값은 보인다.
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()
    const loadsBefore = recorder.loads()
    const cell = screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ })
    expect(cell).toBeDisabled()
    expect(screen.getByRole("button", { name: /9\/17 .* 10:00 불가 해제/ })).toBeDisabled()
    await user.click(cell)

    expect(recorder.slotCalls).toHaveLength(0)
    expect(recorder.loads()).toBe(loadsBefore) // 재조회도 나가지 않았다
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
    // 저장 버튼 문구도 sub의 것이다.
    expect(screen.getByRole("button", { name: "대리작성 후 제출" })).toBeInTheDocument()
  })

  it("다른 곳에서 불가 시간이 바뀌었으면 누른 칸을 저장하지 않고 격자를 최신으로 바꾼다", async () => {
    const user = userEvent.setup()
    const recorder = await renderDialog("exhibitor")
    await openMeetingTab(user)
    expect(screen.getByText("불가 0칸")).toBeInTheDocument()

    // 다이얼로그를 열어 둔 사이 다른 운영자가 두 칸을 지정했다.
    await recorder.elsewhere.patchUnavailableSlots(["2026-09-17T10:00", "2026-09-17T10:30"])
    await user.click(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요")
    // 보내지 않았다 — 보냈다면 "전체 = 방금 누른 한 칸"이 돼 두 칸이 사라진다.
    expect(recorder.slotCalls).toHaveLength(0)
    expect((await recorder.stored()).exhibitor_profile?.unavailable_meeting_slots).toEqual([
      "2026-09-17T10:00",
      "2026-09-17T10:30",
    ])
    expect(await screen.findByText("불가 2칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /9\/17 .* 10:30 불가 해제/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ })).toBeInTheDocument()

    // 최신 격자에서 다시 누르면 저장된다(세 칸 전체).
    await user.click(screen.getByRole("button", { name: /9\/16 .* 10:00 불가 지정/ }))
    await waitFor(() => expect(recorder.slotCalls).toHaveLength(1))
    expect(recorder.slotCalls[0]).toEqual([
      "2026-09-16T10:00",
      "2026-09-17T10:00",
      "2026-09-17T10:30",
    ])
  })
})
