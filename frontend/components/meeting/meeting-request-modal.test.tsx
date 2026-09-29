// useTranslations("meeting.toast")를 쓰는 submit() 실 분기(mock 분기는 안 쓰지만 렌더 트리 전체가
// NextIntlClientProvider 컨텍스트를 요구한다) 때문에 렌더 헬퍼를 intl-aware 버전으로 바꾼다.
import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, it, expect, vi } from "vitest"
import { MeetingRequestModal } from "./meeting-request-modal"
import { Toaster } from "@/components/ui/sonner"
import { MOCK_EXHIBITORS } from "@/lib/mock-orgs"
import { buildMeetingAvailability } from "@/lib/meeting/mock-availability"
import type { MeetingAvailability } from "@/lib/meeting/types"
import type { Organization } from "@/lib/types"

const exhibitor = MOCK_EXHIBITORS[0] // 한화시스템 (받는 쪽 = Exhibitor → 수락 대기)

const hostedBuyer: Organization = {
  id: "by-hosted",
  name: "초청바이어테스트",
  role: "buyer",
  buyerType: "hosted",
  keywords: ["통신"],
}

// 다중 장소(매칭존 테이블 포함) 시나리오 전용 fixture. 실제 mock 행사 설정(베트남 전시, 부스만
// — lib/event/event-settings.ts)과 별개로, "장소가 여럿일 때" 기존 선택 UI가 그대로 동작하는지
// 검증한다(행사 설정이 늘어나면 venues도 늘어나므로 — F-MT-001, 정책 하드코딩 금지).
function multiVenueAvailability(org: Organization): MeetingAvailability {
  const base = buildMeetingAvailability(org)
  return {
    ...base,
    venues: [
      ...base.venues,
      {
        kind: "table",
        name: "비즈매칭존 테이블",
        description: "2층 비즈매칭존 · 주최측 지정 테이블",
        badge: { text: "가능", tone: "available" },
        numbers: [
          { id: "T-01", label: "T-01", available: true },
          { id: "T-02", label: "T-02", available: false },
        ],
      },
    ],
  }
}

describe("MeetingRequestModal (F-MT-001 3탭 흐름)", () => {
  // 2단계(장소): mock 행사 설정(베트남 전시, 부스만)에서는 장소가 하나뿐이라 자동 선택 요약이 뜬다.
  async function advanceToConfirm(org: Organization) {
    const user = userEvent.setup()
    render(<MeetingRequestModal org={org} availability={buildMeetingAvailability(org)} viewerRole="buyer" open onOpenChange={() => {}} />)

    // 1단계: 시간 선택 — 슬롯 그리드가 보이고 가용 슬롯을 고른다
    expect(screen.getByText("시간")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "10:00" }))
    await user.click(screen.getByRole("button", { name: "다음" }))

    // 2단계: 장소 — 장소가 하나뿐이라 자동 선택 요약(부스). 바로 다음.
    expect(screen.getByText("상대방 부스")).toBeInTheDocument()
    expect(screen.getByText("자동 선택")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "다음" }))
    return user
  }

  it("3탭을 거쳐 AI 초안 사유가 pre-fill되고 신청을 완료한다(Exhibitor 수신 → 수락 대기)", async () => {
    const user = await advanceToConfirm(exhibitor)

    // 3단계: 요약 + AI 초안 사유
    expect(screen.getByText("미팅 메시지")).toBeInTheDocument()
    expect(screen.getByText("AI 초안")).toBeInTheDocument()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea.value).toContain(exhibitor.name) // 상대 기업명이 들어간 초안

    await user.click(screen.getByRole("button", { name: "미팅 신청하기" }))

    // 완료: 수락 대기 메시지
    expect(screen.getByText("미팅을 신청했습니다!")).toBeInTheDocument()
    expect(screen.getByText("수락 대기 중")).toBeInTheDocument()
  })

  it("초청 바이어가 받으면 완료 화면이 즉시 확정으로 표시된다", async () => {
    const user = await advanceToConfirm(hostedBuyer)
    await user.click(screen.getByRole("button", { name: "미팅 신청하기" }))
    expect(screen.getByText("미팅이 즉시 확정되었습니다!")).toBeInTheDocument()
    expect(screen.getByText("확정됨")).toBeInTheDocument()
  })

  it("슬롯을 고르기 전에는 다음으로 진행할 수 없다", () => {
    render(<MeetingRequestModal org={exhibitor} availability={buildMeetingAvailability(exhibitor)} viewerRole="buyer" open onOpenChange={() => {}} />)
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled()
  })

  it("장소가 하나뿐이면 자동으로 선택돼 요약만 뜨고 바로 다음으로 진행할 수 있다", async () => {
    const user = userEvent.setup()
    render(<MeetingRequestModal org={exhibitor} availability={buildMeetingAvailability(exhibitor)} viewerRole="buyer" open onOpenChange={() => {}} />)
    await user.click(screen.getByRole("button", { name: "10:00" }))
    await user.click(screen.getByRole("button", { name: "다음" }))
    expect(screen.getByText("상대방 부스")).toBeInTheDocument()
    expect(screen.getByText("자동 선택")).toBeInTheDocument()
    // 클릭 가능한 선택 버튼(장소 카드)이 아니라 요약이므로 다음이 곧바로 활성.
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled()
  })

  it("장소가 여럿이면 기존처럼 선택 UI가 뜨고, 매칭존 테이블은 번호를 골라야 다음으로 진행된다", async () => {
    const user = userEvent.setup()
    render(
      <MeetingRequestModal
        org={exhibitor}
        availability={multiVenueAvailability(exhibitor)}
        viewerRole="buyer"
        open
        onOpenChange={() => {}}
      />
    )
    await user.click(screen.getByRole("button", { name: "10:00" }))
    await user.click(screen.getByRole("button", { name: "다음" }))

    // 장소가 여럿이라 자동 선택 요약이 아니라 선택 카드가 뜬다.
    expect(screen.queryByText("자동 선택")).not.toBeInTheDocument()
    await user.click(screen.getByText("비즈매칭존 테이블"))
    // 번호 미선택 → 다음 비활성
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "T-01" }))
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled()
  })

  it("이전 버튼으로 단계를 되돌릴 수 있다", async () => {
    const user = userEvent.setup()
    render(
      <MeetingRequestModal
        org={exhibitor}
        availability={multiVenueAvailability(exhibitor)}
        viewerRole="buyer"
        open
        onOpenChange={() => {}}
      />
    )
    await user.click(screen.getByRole("button", { name: "10:00" }))
    await user.click(screen.getByRole("button", { name: "다음" }))
    expect(screen.getByText("비즈매칭존 테이블")).toBeInTheDocument() // 2단계
    await user.click(screen.getByRole("button", { name: "이전" }))
    expect(screen.queryByText("비즈매칭존 테이블")).not.toBeInTheDocument() // 1단계로 복귀
  })
})

// N1: 실연동 모드에서 POST /api/meetings가 409를 돌려줘도 사용자에게 아무 피드백이 없던 결함
// (재검증 리포트 — .e2e-artifacts/e2e-verify-round.md). DUPLICATE_APPLICATION은 전용 문구, 그 밖의
// 4xx/5xx(예: VENUE_TAKEN)는 백엔드 message를 그대로 토스트로 띄워야 조용히 사라지지 않는다.
describe("MeetingRequestModal — 신청 실패 시 사용자 피드백(N1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function advanceToConfirmAndSubmit(org: Organization) {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const user = userEvent.setup()
    render(
      <>
        <MeetingRequestModal org={org} availability={buildMeetingAvailability(org)} viewerRole="buyer" open onOpenChange={() => {}} />
        <Toaster />
      </>
    )
    await user.click(screen.getByRole("button", { name: "10:00" }))
    await user.click(screen.getByRole("button", { name: "다음" }))
    await user.click(screen.getByRole("button", { name: "다음" }))
    await user.click(screen.getByRole("button", { name: "미팅 신청하기" }))
    return user
  }

  // #11: 쌍 단위 차단은 사라졌다(같은 상대와 다른 시각으로 여러 번 미팅 가능). 이제 409는
  // "같은 상대에게 같은 시각으로 두 번 신청"일 때만 온다 — 문구도 그 의미여야 한다.
  it("409 DUPLICATE_APPLICATION은 같은 시간 중복 신청 안내 토스트로 드러난다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: {
                code: "DUPLICATE_APPLICATION",
                message: "같은 시간으로 이미 신청한 미팅이 있습니다.",
                existing_meeting_id: "mtg-existing",
              },
            }),
            { status: 409 }
          )
      )
    )

    await advanceToConfirmAndSubmit(exhibitor)

    await waitFor(() => {
      expect(
        screen.getByText("이 기업에 같은 시간으로 이미 신청했습니다. 다른 시간을 선택해주세요")
      ).toBeInTheDocument()
    })
    // 무반응이 아니라 조용히 실패한 것도 아니다 — 다이얼로그는 열린 채로 재시도 가능해야 한다.
    expect(screen.getByRole("button", { name: "미팅 신청하기" })).toBeInTheDocument()
  })

  it("VENUE_TAKEN 등 별도 분기가 없는 4xx도 백엔드 메시지를 그대로 토스트로 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ detail: { code: "VENUE_TAKEN", message: "해당 시간에 장소가 이미 사용 중입니다." } }),
            { status: 409 }
          )
      )
    )

    await advanceToConfirmAndSubmit(exhibitor)

    await waitFor(() => {
      expect(screen.getByText("해당 시간에 장소가 이미 사용 중입니다.")).toBeInTheDocument()
    })
  })
})

describe("MeetingRequestModal — 닫기", () => {
  it("X 버튼으로 모달을 닫을 수 있다", async () => {
    const user = userEvent.setup()
    let open = true
    const onOpenChange = (v: boolean) => {
      open = v
    }
    render(<MeetingRequestModal org={exhibitor} availability={buildMeetingAvailability(exhibitor)} viewerRole="buyer" open onOpenChange={onOpenChange} />)
    await user.click(screen.getByRole("button", { name: "닫기" }))
    expect(open).toBe(false)
  })
})
