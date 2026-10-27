import { beforeEach, describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"

import { render, screen, waitFor, within } from "@/lib/test/render-with-intl"
import {
  recordingTransport,
  testBuyerDetail,
  testExhibitorDetail,
  type RecordingTransport,
} from "@/lib/test/operator-application"
import {
  BOOTH_BODY_KEYS,
  OperatorRequestError,
  createOperatorApplicationClient,
} from "@/lib/operator/application-client"
import { ADMIN_STATUS_LABELS } from "@/lib/admin/proxy-profile"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))
import { toast } from "sonner"

import { OperatorApplicationPanel } from "./application-panel"

// 운영자 신청서 편집 패널 — 두 콘솔이 함께 쓰는 본체. 여기서 고정하는 것은 고객사가 지금 이 화면으로
// 실제 데이터를 넣고 있다는 전제의 세 가지다:
//   ① 데이터가 사라지지 않는다 — 목록(담당자·제품·분야)은 전체를 보내고, 권한 없는 칸은 본문에서 뺀다.
//   ② 저장된 척하지 않는다 — 실패하면 토스트 + 다이얼로그·입력 유지, 화면 값은 서버의 옛 값 그대로.
//   ③ 옛 값으로 되돌아가지 않는다 — 열 때마다 서버에서 읽고, 저장 뒤에는 서버 응답으로 다시 그린다.

function renderPanel(
  recorder: RecordingTransport,
  role: "exhibitor" | "buyer",
  { canEdit = true, isMaster = true }: { canEdit?: boolean; isMaster?: boolean } = {},
) {
  const onSaved = vi.fn()
  const view = render(
    <OperatorApplicationPanel
      createClient={() =>
        createOperatorApplicationClient(role, recorder.transport, { canAssignBooth: isMaster })
      }
      canEdit={canEdit}
      isMaster={isMaster}
      statusLabels={ADMIN_STATUS_LABELS}
      onSaved={onSaved}
    />,
  )
  return { ...view, onSaved }
}

async function openSection(tab: string | null, trigger: string) {
  if (tab) await userEvent.click(await screen.findByRole("tab", { name: tab }))
  await userEvent.click(await screen.findByRole("button", { name: trigger }))
  return screen.findByRole("dialog")
}

beforeEach(() => vi.clearAllMocks())

describe("운영자 신청서 패널 — 참가사 전체 보기", () => {
  it("서버에서 읽어 신청서의 모든 구획을 보여 준다(선호 바이어 국가·구분, 미팅 불가 시간 포함)", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    // 상태 — 서버가 준 값.
    expect(await screen.findByText("현재 신청 상태")).toBeInTheDocument()
    expect(screen.getByText("승인")).toBeInTheDocument()

    // 기본정보(담당자 2명) — 참가자 화면과 같은 구획.
    expect(screen.getByText("민수")).toBeInTheDocument()
    expect(screen.getByText("서연")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "회사소개" }))
    expect(screen.getByText("영어")).toBeInTheDocument() // 상담 가능 언어

    await userEvent.click(screen.getByRole("tab", { name: "사업분야" }))
    expect(screen.getByText("방송")).toBeInTheDocument() // 카테고리
    // 제품명은 구획과 "그 밖의 신청 정보"(과거 항목) 양쪽에 보일 수 있다.
    expect(screen.getAllByText("나이트브릿지").length).toBeGreaterThan(0)
    expect(screen.getByText("픽셀런")).toBeInTheDocument()

    // 고객이 "안 보인다"고 한 세 항목.
    await userEvent.click(screen.getByRole("tab", { name: "타겟" }))
    expect(screen.getByText("선호 바이어 국가")).toBeInTheDocument()
    expect(screen.getByText("베트남, 태국")).toBeInTheDocument()
    expect(screen.getByText("선호 바이어 구분")).toBeInTheDocument()
    expect(screen.getByText("방송·미디어")).toBeInTheDocument()
    expect(screen.getByText("미팅 불가 시간")).toBeInTheDocument()
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/20 .* 10:00 불가 해제/ })).toBeInTheDocument()

    // 운영자 전용 — 기업명·부스, 참가자 폼에 없는 담당자 칸(성·전화·언어).
    expect(screen.getByText("A-12")).toBeInTheDocument()
    expect(screen.getByText(/성 김 · 해외사업팀 · 전화 02-000-0002 · 언어 한국어, 영어/)).toBeInTheDocument()
    // 폼에 없는 과거 항목도 값이 있으면 보인다.
    expect(screen.getByText(/구 카테고리 웹툰 · HS 품목설명 인쇄물/)).toBeInTheDocument()
  })

  it("참가자용 안내('회사명·부스는 수정할 수 없어요')는 그리지 않는다", async () => {
    renderPanel(recordingTransport(testExhibitorDetail()), "exhibitor")
    await screen.findByText("현재 신청 상태")
    expect(screen.queryByText("회사명·부스 정보는 수정할 수 없어요")).not.toBeInTheDocument()
    expect(screen.queryByText("내 비즈매칭 프로필")).not.toBeInTheDocument()
  })

  it("패널을 열 때마다 서버에서 새로 읽는다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const first = renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")
    expect(recorder.loads()).toBe(1)
    first.unmount()

    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")
    expect(recorder.loads()).toBe(2)
  })

  it("읽기에 실패하면 옛 값을 그리지 않고 안내와 다시 불러오기를 보여 준다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const failing = {
      ...recorder.transport,
      getDetail: vi
        .fn()
        .mockRejectedValueOnce(new OperatorRequestError(403, "이 바이어는 관할 밖입니다"))
        .mockImplementation(() => recorder.transport.getDetail()),
    }
    render(
      <OperatorApplicationPanel
        createClient={() =>
          createOperatorApplicationClient("exhibitor", failing, { canAssignBooth: true })
        }
        canEdit
        isMaster
        statusLabels={ADMIN_STATUS_LABELS}
      />,
    )

    expect(await screen.findByText("신청서를 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.getByText(/이 기업을 열람할 권한이 없습니다/)).toBeInTheDocument()
    expect(screen.queryByText("현재 신청 상태")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "다시 불러오기" }))
    expect(await screen.findByText("현재 신청 상태")).toBeInTheDocument()
  })
})

describe("운영자 신청서 패널 — 구획 수정(참가자 폼 그대로)", () => {
  it("선호 바이어 국가·구분을 고쳐 저장하면 전체 목록이 나가고 화면이 서버 응답으로 바뀐다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const { onSaved } = renderPanel(recorder, "exhibitor")

    const dialog = await openSection("타겟", "타겟 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "인도네시아" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "태국" })) // 해제
    await userEvent.click(within(dialog).getByRole("button", { name: "전시·에이전시" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({
      preferred_buyer_countries: ["vietnam", "indonesia"],
      preferred_buyer_types: ["media", "exhibition_agent"],
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText("베트남, 인도네시아")).toBeInTheDocument()
    expect(screen.getByText("방송·미디어, 전시·에이전시")).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
    // 콘솔이 목록을 다시 읽게 알린다. 상태는 승인 그대로다.
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved.mock.calls[0][0].status).toBe("approved")
  })

  // 직접 수정은 신청 상태를 바꾸지 않는다 — 승인된 건은 승인 그대로, 제출·보완요청 건도 그대로다.
  // (예전 규칙 함수 applyProfileEdit의 단언이 사라졌으므로 패널에서 직접 고정한다.)
  it.each(["approved", "submitted", "changes_requested"] as const)(
    "구획을 저장해도 신청 상태(%s)는 그대로다 — 본문에 상태가 없고, 저장 뒤 스냅샷·배지·서버 값이 같다",
    async (status) => {
      const recorder = recordingTransport(
        testExhibitorDetail({ application_status: status }, { application_status: status }),
      )
      const { onSaved } = renderPanel(recorder, "exhibitor")
      await screen.findByText("현재 신청 상태")
      const badgeBefore = screen.getByText(ADMIN_STATUS_LABELS[status])

      const dialog = await openSection("타겟", "타겟 수정")
      await userEvent.click(within(dialog).getByRole("button", { name: "인도네시아" }))
      await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

      await waitFor(() => expect(recorder.bodies).toHaveLength(1))
      expect(recorder.bodies[0]).not.toHaveProperty("application_status")
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
      expect(onSaved.mock.calls[0][0].status).toBe(status)
      expect(screen.getByText(ADMIN_STATUS_LABELS[status])).toBe(badgeBefore)
      const stored = await recorder.stored()
      expect(stored.application_status).toBe(status)
      expect(stored.exhibitor_profile?.application_status).toBe(status)
    },
  )

  it("제품을 지우고 저장하면 남은 제품이 숨은 칸까지 그대로 실려 나간다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    const dialog = await openSection("사업분야", "사업분야 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "제품 2 삭제" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].products).toEqual([
      {
        name_ko: "나이트브릿지",
        name_en: "Night Bridge",
        business_field: "webtoon_production",
        category_ko: "웹툰", // 폼에 없는 칸
        hs_code: "4911.91",
        hs_description: "인쇄물", // 폼에 없는 칸
        price_range: "krw_10_30m",
      },
    ])
    expect(recorder.bodies[0].exhibition_categories).toEqual(["content_production", "game_production"])
  })

  it("운영자 모드는 필수 항목이 비어도 저장을 막지 않는다 — 비운 칸은 서버에서도 비워진다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    const dialog = await openSection("회사소개", "회사소개 수정")
    // 기업소개(국문)는 참가자 화면에서는 필수다.
    await userEvent.clear(within(dialog).getByDisplayValue("웹툰·게임을 만드는 스튜디오입니다."))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].intro_ko).toBeNull()
    expect(recorder.bodies[0].intro_en).toBe("A studio making webtoons and games.")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(within(dialog).queryByText("필수 항목을 채워야 저장할 수 있어요.")).not.toBeInTheDocument()
    // 누락은 막지 않고 알리기만 한다.
    expect(screen.getByText(/필수 항목이 비어 있는 구획: 회사소개/)).toBeInTheDocument()
    expect((await recorder.stored()).exhibitor_profile?.intro_ko).toBeNull()
  })

  it("저장이 실패하면(403) 권한 안내 토스트를 띄우고 다이얼로그와 입력을 그대로 둔다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const { onSaved } = renderPanel(recorder, "exhibitor")

    const dialog = await openSection("회사소개", "회사소개 수정")
    const intro = within(dialog).getByDisplayValue("웹툰·게임을 만드는 스튜디오입니다.")
    await userEvent.clear(intro)
    await userEvent.type(intro, "새 소개")
    recorder.failNextSave(new OperatorRequestError(403, "이 바이어는 관할 밖입니다"))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("이 기업을 수정할 권한이 없습니다")
    // 다이얼로그는 열린 채, 입력은 그대로.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue("새 소개")).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect((await recorder.stored()).exhibitor_profile?.intro_ko).toBe(
      "웹툰·게임을 만드는 스튜디오입니다.",
    )

    // 같은 자리에서 다시 저장할 수 있다.
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].intro_ko).toBe("새 소개")
  })

  it("네트워크가 끊겨도 입력이 남는다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    const dialog = await openSection("타겟", "타겟 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "일본" }))
    recorder.failNextSave(new OperatorRequestError(0, "network"))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("서버에 연결하지 못했습니다")
    expect(within(dialog).getByRole("button", { name: "일본" })).toHaveAttribute("aria-pressed", "true")
    expect(recorder.bodies).toHaveLength(0)
  })

  it("조회 전용 권한이면 구획 수정 버튼이 하나도 없다", async () => {
    renderPanel(recordingTransport(testExhibitorDetail()), "exhibitor", { canEdit: false })
    await screen.findByText("현재 신청 상태")
    expect(screen.getByText(/조회 전용입니다/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /수정$/ })).not.toBeInTheDocument()
    for (const tab of ["회사소개", "사업분야", "타겟"]) {
      await userEvent.click(screen.getByRole("tab", { name: tab }))
      expect(screen.queryByRole("button", { name: /수정$/ })).not.toBeInTheDocument()
    }
  })
})

describe("운영자 신청서 패널 — 운영자 전용 항목", () => {
  it("master는 부스를 고치고, 바뀐 칸만 나간다(비운 칸은 지움)", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    await userEvent.click(await screen.findByRole("button", { name: "부스 수정" }))
    const dialog = await screen.findByRole("dialog")
    const location = within(dialog).getByLabelText("부스위치")
    await userEvent.clear(location)
    await userEvent.type(location, "01")
    await userEvent.clear(within(dialog).getByLabelText("부스개수"))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({ booth_location: "01", booth_count: null })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getAllByText("01").length).toBeGreaterThan(0)
  })

  it("부스개수에 숫자가 아닌 값을 넣으면 보내지 않고 알린다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    await userEvent.click(await screen.findByRole("button", { name: "부스 수정" }))
    const dialog = await screen.findByRole("dialog")
    const count = within(dialog).getByLabelText("부스개수")
    await userEvent.clear(count)
    await userEvent.type(count, "두 개")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("숫자만")
    expect(recorder.bodies).toHaveLength(0)
  })

  it("sub는 부스·미팅 불가 시간을 볼 수만 있고, 기업명 저장 본문에는 부스 키가 없다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor", { isMaster: false })

    await screen.findByText("현재 신청 상태")
    // 값은 보인다(기본정보 구획과 운영자 전용 '부스' 양쪽에).
    expect(screen.getAllByText("A-12")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: "부스 수정" })).not.toBeInTheDocument()
    expect(screen.getByText(/부스는 슈퍼관리자가 지정합니다/)).toBeInTheDocument()
    // 격자는 보이되 눌리지 않는다.
    const cell = screen.getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ })
    expect(cell).toBeDisabled()
    await userEvent.click(cell)
    expect(recorder.slotCalls).toHaveLength(0)

    await userEvent.click(screen.getByRole("button", { name: "기업명 수정" }))
    const dialog = await screen.findByRole("dialog")
    const nameEn = within(dialog).getByLabelText("기업명(영문)")
    await userEvent.clear(nameEn)
    await userEvent.type(nameEn, "PixelArts")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({ organization_name_en: "PixelArts" })
    for (const key of BOOTH_BODY_KEYS) expect(recorder.bodies[0]).not.toHaveProperty(key)
  })

  it("sub가 기본정보 구획을 저장해도 본문에 부스 키가 없다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor", { isMaster: false })

    const dialog = await openSection(null, "기본정보 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    for (const key of BOOTH_BODY_KEYS) expect(recorder.bodies[0]).not.toHaveProperty(key)
    // 담당자 두 명이 그대로 실린다.
    expect(recorder.bodies[0].attendees).toHaveLength(2)
  })

  it("담당자 추가 정보(전화·상담 언어)를 고치면 담당자 전체 목록이 나간다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    await userEvent.click(await screen.findByRole("button", { name: "담당자 추가 정보 수정" }))
    const dialog = await screen.findByRole("dialog")
    const second = within(dialog).getByRole("group", { name: /담당자 2/ })
    await userEvent.type(within(second).getByLabelText("전화"), "02-111-2222")
    await userEvent.click(within(second).getByRole("button", { name: "베트남어" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    const sent = recorder.bodies[0].attendees as Record<string, unknown>[]
    expect(Object.keys(recorder.bodies[0])).toEqual(["attendees"])
    expect(sent).toHaveLength(2)
    // 첫 번째 담당자는 손대지 않았다 — 성·부서·전화·언어가 그대로.
    expect(sent[0]).toMatchObject({ last_name_ko: "김", tel: "02-000-0002", languages: ["ko", "en"] })
    expect(sent[1]).toMatchObject({
      first_name_ko: "서연",
      email: "seoyeon@pixelarts.example",
      tel: "02-111-2222",
      languages: ["vi"],
    })
  })
})

describe("운영자 신청서 패널 — 미팅 불가 시간", () => {
  it("칸을 누르면 전체 목록을 저장하고 서버 응답으로 표시한다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const { onSaved } = renderPanel(recorder, "exhibitor")

    await userEvent.click(await screen.findByRole("button", { name: /10\/21 .* 11:00 불가 지정/ }))

    await waitFor(() => expect(recorder.slotCalls).toHaveLength(1))
    // 원래 있던 칸을 포함한 전체 목록.
    expect(recorder.slotCalls[0]).toEqual(["2026-10-20T10:00", "2026-10-21T11:00"])
    expect(await screen.findByText("불가 2칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 11:00 불가 해제/ })).toBeEnabled()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it("저장이 실패하면 방금 누른 칸을 되돌리고 알린다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const { onSaved } = renderPanel(recorder, "exhibitor")

    const cell = await screen.findByRole("button", { name: /10\/21 .* 11:00 불가 지정/ })
    recorder.failNextSave(new OperatorRequestError(0, "network"))
    await userEvent.click(cell)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("미팅 불가 시간 저장에 실패했어요")
    // 되돌아갔다 — 다시 "불가 지정" 상태이고 개수도 그대로.
    expect(await screen.findByRole("button", { name: /10\/21 .* 11:00 불가 지정/ })).toBeEnabled()
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect((await recorder.stored()).exhibitor_profile?.unavailable_meeting_slots).toEqual([
      "2026-10-20T10:00",
    ])
  })

  it("격자를 만들 수 없으면 지어낸 격자 대신 안내하고, 저장된 칸 수는 그대로 보여 준다", async () => {
    renderPanel(recordingTransport(testExhibitorDetail(), null), "exhibitor")
    expect(await screen.findByText(/슬롯 격자를 만들 수 없습니다/)).toBeInTheDocument()
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()
  })
})

describe("운영자 신청서 패널 — 바이어", () => {
  it("신청서 요약과 운영자 전용 항목·과거 항목을 보여 준다", async () => {
    renderPanel(recordingTransport(testBuyerDetail()), "buyer")

    expect(await screen.findByText("현재 신청 상태")).toBeInTheDocument()
    // 구분 3개가 그대로 보인다.
    expect(screen.getByText("방송·미디어, 민간기업(제작·유통), 전시·에이전시")).toBeInTheDocument()
    expect(screen.getByText("VN-0001")).toBeInTheDocument()
    expect(screen.getByText("1 Trang Tien")).toBeInTheDocument()
    // 폼에 없는 과거 항목(참가 경로·KST 상담시간·참석자).
    expect(screen.getByText("10:00-17:00")).toBeInTheDocument()
    expect(screen.getByText(/Linh Tran · Manager/)).toBeInTheDocument()
    // 바이어에는 부스·미팅 불가 시간이 없다.
    expect(screen.queryByText("미팅 불가 시간")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "부스 수정" })).not.toBeInTheDocument()
  })

  it("기본정보를 저장해도 구분 3개가 유지된다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")

    await userEvent.click(await screen.findByRole("button", { name: "기본정보 수정" }))
    const dialog = await screen.findByRole("dialog")
    const title = within(dialog).getByLabelText("직위 (국문)")
    await userEvent.type(title, "이사")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].org_types).toEqual(["media", "private_commercial", "exhibition_agent"])
    expect(recorder.bodies[0].contact_title_ko).toBe("이사")
    expect((await recorder.stored()).buyer_profile?.org_types).toEqual([
      "media",
      "private_commercial",
      "exhibition_agent",
    ])
  })

  it("필수 항목(이메일)을 비워도 저장되고 서버에서 비워진다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")

    await userEvent.click(await screen.findByRole("button", { name: "기본정보 수정" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.clear(within(dialog).getByLabelText(/이메일/))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].contact_email).toBeNull()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText(/필수 항목이 비어 있는 구획: 기본정보/)).toBeInTheDocument()
  })

  it("운영자 전용 항목(사업자등록번호·웹사이트·주소)을 고친다 — 바뀐 칸만 보낸다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")

    await userEvent.click(await screen.findByRole("button", { name: "운영자 전용 항목 수정" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.clear(within(dialog).getByLabelText("웹사이트"))
    await userEvent.type(within(dialog).getByLabelText("상세 주소"), "Floor 3")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({ website: null, address2: "Floor 3" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText("Floor 3")).toBeInTheDocument()
  })

  it("바뀐 내용이 없으면 요청을 보내지 않는다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")

    await userEvent.click(await screen.findByRole("button", { name: "운영자 전용 항목 수정" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(recorder.bodies).toHaveLength(0)
  })
})

// 동시 수정 — 패널을 열어 둔 사이 다른 운영자·참가자가 바꾼 값을, 열 때의 값에서 출발한 저장이 지우지 못한다.
// recorder.elsewhere = 같은 서버에 다른 곳에서 쓰는 통로.
describe("운영자 신청서 패널 — 열어 둔 사이 다른 곳에서 바뀜(충돌)", () => {
  const ADDED_PRODUCT = { name_ko: "다른 곳에서 추가한 제품", name_en: "Added elsewhere" }

  async function addProductElsewhere(recorder: RecordingTransport) {
    const current = (await recorder.stored()).exhibitor_profile?.products ?? []
    await recorder.elsewhere.patchProfile("exhibitor", { products: [...current, ADDED_PRODUCT] })
  }

  it("제품이 다른 곳에서 추가됐으면 사업분야 저장을 보내지 않고, 패널을 최신으로 바꾸고, 입력은 남긴다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    const { onSaved } = renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")

    await addProductElsewhere(recorder)

    // 패널은 아직 옛 목록(2개)을 보여 준다 — 그 값으로 다이얼로그를 연다.
    const dialog = await openSection("사업분야", "사업분야 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "제품 2 삭제" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 일반 실패와 다른 문구.
    const message = vi.mocked(toast.error).mock.calls[0][0] as string
    expect(message).toContain("다른 곳에서 이 구획이 먼저 수정됐어요")
    expect(message).toContain("창을 닫고 다시 열어")
    expect(message).not.toContain("저장하지 못했습니다")
    // 아무것도 보내지 않았고, 다른 곳에서 추가한 제품이 서버에 남아 있다.
    expect(recorder.bodies).toHaveLength(0)
    expect((await recorder.stored()).exhibitor_profile?.products).toHaveLength(3)
    expect(toast.success).not.toHaveBeenCalled()
    // 다이얼로그는 열린 채, 운영자의 입력(제품 1개만 남긴 상태)이 그대로다.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "제품 2 삭제" })).not.toBeInTheDocument()
    // 패널은 방금 읽은 최신 목록을 보여 준다(콘솔의 목록도 맞추라고 알린다).
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved.mock.calls[0][0].profile.products).toHaveLength(3)

    // 같은 창에서 다시 눌러도 보내지 않는다 — 옛 목록에서 출발한 입력이 최신을 덮으면 안 된다.
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(recorder.bodies).toHaveLength(0)
    expect((await recorder.stored()).exhibitor_profile?.products).toHaveLength(3)

    // 닫았다 다시 열면 최신 목록(3개)에서 출발하고, 이제 저장된다.
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText("다른 곳에서 추가한 제품")).toBeInTheDocument()
    const reopened = await openSection(null, "사업분야 수정")
    expect(within(reopened).getByRole("button", { name: "제품 3 삭제" })).toBeInTheDocument()
    await userEvent.click(within(reopened).getByRole("button", { name: "제품 2 삭제" }))
    await userEvent.click(within(reopened).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    const sent = recorder.bodies[0].products as { name_ko: string }[]
    expect(sent.map((p) => p.name_ko)).toEqual(["나이트브릿지", "다른 곳에서 추가한 제품"])
  })

  it("다른 구획만 바뀌었으면 막지 않는다 — 회사소개는 저장되고 추가된 제품도 그대로다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")

    await addProductElsewhere(recorder)

    const dialog = await openSection("회사소개", "회사소개 수정")
    const intro = within(dialog).getByDisplayValue("웹툰·게임을 만드는 스튜디오입니다.")
    await userEvent.clear(intro)
    await userEvent.type(intro, "새 소개")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].intro_ko).toBe("새 소개")
    expect(recorder.bodies[0]).not.toHaveProperty("products")
    expect(toast.error).not.toHaveBeenCalled()
    const stored = (await recorder.stored()).exhibitor_profile
    expect(stored?.intro_ko).toBe("새 소개")
    expect(stored?.products).toHaveLength(3)
  })

  it("담당자가 다른 곳에서 추가됐으면 '담당자 추가 정보' 저장을 보내지 않는다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")

    const attendees = (await recorder.stored()).exhibitor_profile?.attendees ?? []
    await recorder.elsewhere.patchProfile("exhibitor", {
      attendees: [...attendees, { first_name_ko: "지훈", email: "jihoon@pixelarts.example" }],
    })

    await userEvent.click(screen.getByRole("button", { name: "담당자 추가 정보 수정" }))
    const dialog = await screen.findByRole("dialog")
    const tel = within(dialog).getAllByLabelText("전화")[1]
    await userEvent.type(tel, "02-000-0003")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(recorder.bodies).toHaveLength(0)
    expect((await recorder.stored()).exhibitor_profile?.attendees).toHaveLength(3)
    // 다이얼로그와 입력은 그대로, 패널은 세 번째 담당자를 보여 준다.
    expect(within(dialog).getAllByLabelText("전화")[1]).toHaveValue("02-000-0003")
    expect(screen.getAllByText(/지훈/).length).toBeGreaterThan(0)
  })

  it("운영자 전용 항목은 고친 칸만 견준다 — 같은 칸이 다른 곳에서 바뀌었으면 보내지 않는다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")

    // 패널을 열어 둔 사이 다른 곳에서 영문 기업명이 바뀌었다.
    await recorder.elsewhere.patchProfile("exhibitor", { organization_name_en: "PixelArts Global" })

    await userEvent.click(screen.getByRole("button", { name: "기업명 수정" }))
    const dialog = await screen.findByRole("dialog")
    const nameEn = within(dialog).getByLabelText("기업명(영문)")
    await userEvent.clear(nameEn)
    await userEvent.type(nameEn, "PixelArts Inc.")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(recorder.bodies).toHaveLength(0)
    expect(within(dialog).getByLabelText("기업명(영문)")).toHaveValue("PixelArts Inc.")
    expect((await recorder.stored()).exhibitor_profile?.organization_name_en).toBe("PixelArts Global")
  })

  it("옆 칸만 다른 곳에서 바뀌었으면 막지 않는다 — 고친 칸만 보내고, 옆 칸의 새 값은 그대로 남는다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")

    // 다른 곳에서 국문 기업명과 부스위치가 바뀌었다 — 이쪽은 영문 기업명과 부스타입을 고친다.
    await recorder.elsewhere.patchProfile("exhibitor", {
      organization_name_ko: "픽셀아츠(주)",
      booth_location: "B-99",
    })

    await userEvent.click(screen.getByRole("button", { name: "기업명 수정" }))
    let dialog = await screen.findByRole("dialog")
    const nameEn = within(dialog).getByLabelText("기업명(영문)")
    await userEvent.clear(nameEn)
    await userEvent.type(nameEn, "PixelArts Inc.")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({ organization_name_en: "PixelArts Inc." })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole("button", { name: "부스 수정" }))
    dialog = await screen.findByRole("dialog")
    // 방금 저장의 응답으로 패널이 최신이 됐다 — 부스위치 칸이 다른 곳에서 바꾼 값을 보여 준다.
    expect(within(dialog).getByLabelText("부스위치")).toHaveValue("B-99")
    const type = within(dialog).getByLabelText("부스타입")
    await userEvent.clear(type)
    await userEvent.type(type, "조립부스")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(recorder.bodies).toHaveLength(2))
    expect(recorder.bodies[1]).toEqual({ booth_type: "조립부스" })

    expect(toast.error).not.toHaveBeenCalled()
    const stored = (await recorder.stored()).exhibitor_profile
    expect(stored?.organization_name_ko).toBe("픽셀아츠(주)")
    expect(stored?.organization_name_en).toBe("PixelArts Inc.")
    expect(stored?.booth_location).toBe("B-99")
    expect(stored?.booth_type).toBe("조립부스")
  })

  it("바이어 운영자 전용 항목: 웹사이트만 고칠 때 주소가 다른 곳에서 바뀐 것은 막지 않고, 같은 칸이면 충돌이다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")
    await screen.findByText("현재 신청 상태")

    await recorder.elsewhere.patchProfile("buyer", { address1: "다른 곳에서 고친 주소" })

    // 웹사이트만 고친다 — 저장된다.
    await userEvent.click(screen.getByRole("button", { name: "운영자 전용 항목 수정" }))
    let dialog = await screen.findByRole("dialog")
    const website = within(dialog).getByLabelText("웹사이트")
    await userEvent.clear(website)
    await userEvent.type(website, "https://operator.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0]).toEqual({ website: "https://operator.example" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect((await recorder.stored()).buyer_profile?.address1).toBe("다른 곳에서 고친 주소")

    // 이번엔 창을 연 뒤 같은 칸(웹사이트)이 다른 곳에서 바뀐다 — 그 칸을 고쳐 저장하면 충돌이다.
    await userEvent.click(screen.getByRole("button", { name: "운영자 전용 항목 수정" }))
    dialog = await screen.findByRole("dialog")
    await recorder.elsewhere.patchProfile("buyer", { website: "https://elsewhere.example" })
    const again = within(dialog).getByLabelText("웹사이트")
    await userEvent.clear(again)
    await userEvent.type(again, "https://operator-2.example")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 먼저 수정됐어요")
    expect(recorder.bodies).toHaveLength(1)
    expect((await recorder.stored()).buyer_profile?.website).toBe("https://elsewhere.example")
    expect(within(dialog).getByLabelText("웹사이트")).toHaveValue("https://operator-2.example")
  })

  it("미팅 불가 시간이 다른 곳에서 바뀌었으면 누른 칸을 저장하지 않고 격자를 최신으로 바꾼다", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")
    await screen.findByText("현재 신청 상태")
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()

    await recorder.elsewhere.patchUnavailableSlots(["2026-10-20T10:00", "2026-10-20T11:00", "2026-10-21T10:00"])

    // 화면 기준은 1칸 — 한 칸을 눌러 "전체 = 2칸"을 보내면 다른 곳에서 지정한 두 칸이 사라진다.
    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요")
    expect(recorder.slotCalls).toHaveLength(0)
    expect((await recorder.stored()).exhibitor_profile?.unavailable_meeting_slots).toEqual([
      "2026-10-20T10:00",
      "2026-10-20T11:00",
      "2026-10-21T10:00",
    ])
    // 격자가 최신(3칸)으로 바뀌었고, 누른 칸은 지정되지 않았다.
    expect(await screen.findByText("불가 3칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 해제/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ })).toBeInTheDocument()

    // 최신 격자에서 다시 누르면 저장된다(4칸 전체).
    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 11:00 불가 지정/ }))
    await waitFor(() => expect(recorder.slotCalls).toHaveLength(1))
    expect(recorder.slotCalls[0]).toEqual([
      "2026-10-20T10:00",
      "2026-10-20T11:00",
      "2026-10-21T10:00",
      "2026-10-21T11:00",
    ])
  })

  it("바이어: 구분이 다른 곳에서 바뀌었으면 기본정보 저장을 보내지 않는다", async () => {
    const recorder = recordingTransport(testBuyerDetail())
    renderPanel(recorder, "buyer")
    await screen.findByText("현재 신청 상태")

    await recorder.elsewhere.patchProfile("buyer", {
      org_types: ["media", "private_commercial", "exhibition_agent", "association"],
    })

    await userEvent.click(screen.getByRole("button", { name: "기본정보 수정" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("직위 (국문)"), "이사")
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("다른 곳에서 이 구획이 먼저 수정됐어요")
    expect(recorder.bodies).toHaveLength(0)
    expect((await recorder.stored()).buyer_profile?.org_types).toHaveLength(4)
    expect(within(dialog).getByLabelText("직위 (국문)")).toHaveValue("이사")
    // 패널은 네 번째 구분을 보여 준다.
    expect(
      screen.getByText("방송·미디어, 민간기업(제작·유통), 전시·에이전시, 협회 및 단체"),
    ).toBeInTheDocument()
  })

  it("저장 직전 재조회가 실패하면 보내지 않고 일반 실패로 알린다(입력 유지)", async () => {
    const recorder = recordingTransport(testExhibitorDetail())
    renderPanel(recorder, "exhibitor")

    const dialog = await openSection("타겟", "타겟 수정")
    await userEvent.click(within(dialog).getByRole("button", { name: "일본" }))
    recorder.failNextLoad(new OperatorRequestError(0, "network"))
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("서버에 연결하지 못했습니다")
    expect(recorder.bodies).toHaveLength(0)
    expect(within(dialog).getByRole("button", { name: "일본" })).toHaveAttribute("aria-pressed", "true")

    // 다시 누르면(재조회 성공) 저장된다.
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }))
    await waitFor(() => expect(recorder.bodies).toHaveLength(1))
    expect(recorder.bodies[0].preferred_buyer_countries).toEqual(["vietnam", "thailand", "japan"])
  })
})
