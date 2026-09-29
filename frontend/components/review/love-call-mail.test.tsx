// 러브콜 메일(#13) 화면 회귀 잠금 — "껍데기 버튼"이 다시 되지 않게 하는 테스트.
//
// 잠그는 것:
// - 버튼 한 번에 바로 발송되지 않는다: 초안이 편집기에 뜨고, 사용자가 고친 **그 텍스트**가 나간다.
// - AI 실패가 화면에 보이고, 그래도 직접 써서 보낼 수 있다(빈 편집기).
// - 발송 실패가 화면에 보이고, 작성한 내용이 사라지지 않으며 완료로 넘어가지 않는다(낙관적 UI 금지).
// - 이미 보낸 미팅은 발송본을 보여주고 다시 보낼 수 없다.
// - 수신 이메일이 없으면 작성 자체를 막고 이유를 보여준다.
import { render, screen, waitFor } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"

import { LoveCallMailCard } from "./love-call-mail"
import type { LoveCallMailDraft, LoveCallMailState, ReviewClient } from "@/lib/review/types"

const MEETING = "meeting-love-call"

const UNSENT: LoveCallMailState = {
  recipientOrgName: "VinaContent",
  recipientCount: 2,
  reportReady: true,
  sent: false,
  sentAt: null,
  subject: null,
  body: null,
}

const AI_DRAFT: LoveCallMailDraft = {
  subject: "[NABI] VinaContent 담당자님께 — 미팅 후속 제안 드립니다",
  body: "애니메이션 IP 4편 동남아 배급 조건을 논의했습니다.",
  aiGenerated: true,
  error: null,
  recipientOrgName: "VinaContent",
  recipientCount: 2,
}

// ReviewClient 전체를 채운 스텁 — 이 화면이 쓰지 않는 메서드는 호출되면 테스트가 실패하도록 둔다.
function makeClient(overrides: Partial<ReviewClient>): ReviewClient {
  const unused = () => {
    throw new Error("이 화면이 부르면 안 되는 메서드")
  }
  return {
    getReview: unused,
    saveStep1: unused,
    structureText: unused,
    startTranscription: unused,
    getTranscriptionStatus: unused,
    saveStep2: unused,
    downloadReport: unused,
    getLoveCallMailState: async () => UNSENT,
    draftLoveCallMail: async () => AI_DRAFT,
    sendLoveCallMail: async () => ({ ...UNSENT, sent: true }),
    ...overrides,
  } as ReviewClient
}

async function openEditor(api: ReviewClient) {
  const user = userEvent.setup()
  render(<LoveCallMailCard meetingId={MEETING} api={api} />)
  await user.click(await screen.findByRole("button", { name: /AI로 메일 작성하기/ }))
  return user
}

describe("러브콜 메일 — 미리보기 → 수정 → 발송", () => {
  it("버튼을 눌러도 바로 발송되지 않고 AI 초안이 편집기에 뜬다", async () => {
    const sendLoveCallMail = vi.fn()
    const api = makeClient({ sendLoveCallMail })

    await openEditor(api)

    // 초안이 제목·본문 편집기에 채워진다.
    expect(await screen.findByDisplayValue(AI_DRAFT.subject)).toBeInTheDocument()
    expect(screen.getByDisplayValue(AI_DRAFT.body)).toBeInTheDocument()
    // 아직 아무것도 발송되지 않았다 — 검토 단계다.
    expect(sendLoveCallMail).not.toHaveBeenCalled()
  })

  it("사용자가 고친 제목·본문 그대로 발송되고 완료 상태로 바뀐다", async () => {
    const sentState: LoveCallMailState = {
      ...UNSENT,
      sent: true,
      sentAt: "2026-09-15T04:00:00Z",
      subject: "고친 제목",
      body: "고친 본문",
    }
    const sendLoveCallMail = vi.fn(async () => sentState)
    const api = makeClient({ sendLoveCallMail })

    const user = await openEditor(api)
    const subject = await screen.findByDisplayValue(AI_DRAFT.subject)
    const body = screen.getByDisplayValue(AI_DRAFT.body)

    await user.clear(subject)
    await user.type(subject, "고친 제목")
    await user.clear(body)
    await user.type(body, "고친 본문")
    await user.click(screen.getByRole("button", { name: /발송하기/ }))

    // 화면에 보이던 텍스트가 그대로 나간다(미리보기=발송본). 제목·본문 외 필드는 싣지 않는다.
    await waitFor(() => expect(sendLoveCallMail).toHaveBeenCalledTimes(1))
    expect(sendLoveCallMail).toHaveBeenCalledWith(MEETING, {
      subject: "고친 제목",
      body: "고친 본문",
    })

    // 발송 뒤에는 발송본을 보여주고 다시 쓰는 버튼은 사라진다.
    expect(await screen.findByText("러브콜 메일을 보냈어요")).toBeInTheDocument()
    expect(screen.getByText("고친 본문")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /AI로 메일 작성하기/ })).not.toBeInTheDocument()
  })

  it("제목이나 본문이 비면 발송 버튼이 잠긴다", async () => {
    const api = makeClient({})
    const user = await openEditor(api)

    const body = await screen.findByDisplayValue(AI_DRAFT.body)
    await user.clear(body)

    expect(screen.getByRole("button", { name: /발송하기/ })).toBeDisabled()
  })
})

describe("러브콜 메일 — 이미 보낸 미팅(중복 방지)", () => {
  it("발송 이력이 있으면 보낸 내용을 보여주고 다시 작성할 수 없다", async () => {
    const api = makeClient({
      getLoveCallMailState: async () => ({
        recipientOrgName: "VinaContent",
        recipientCount: 2,
        reportReady: true,
        sent: true,
        sentAt: "2026-09-15T04:00:00Z",
        subject: "[NABI] 보낸 제목",
        body: "보낸 본문입니다.",
      }),
    })
    render(<LoveCallMailCard meetingId={MEETING} api={api} />)

    expect(await screen.findByText("러브콜 메일을 보냈어요")).toBeInTheDocument()
    expect(screen.getByText("[NABI] 보낸 제목")).toBeInTheDocument()
    expect(screen.getByText("보낸 본문입니다.")).toBeInTheDocument()
    expect(screen.getByText("같은 미팅에는 한 번만 보낼 수 있어요.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /AI로 메일 작성하기/ })).not.toBeInTheDocument()
  })
})

describe("러브콜 메일 — AI 실패는 숨기지 않고 수동 작성 경로를 연다", () => {
  it("AI가 못 쓰면 사유를 보여주고 빈 편집기를 연다", async () => {
    const api = makeClient({
      draftLoveCallMail: async () => ({
        subject: "[NABI] VinaContent 담당자님께 드리는 미팅 후속 제안",
        body: "",
        aiGenerated: false,
        error: "AI 초안 생성에 실패했어요: insufficient_quota",
        recipientOrgName: "VinaContent",
        recipientCount: 2,
      }),
    })
    await openEditor(api)

    expect(await screen.findByText("AI 초안 생성에 실패했어요")).toBeInTheDocument()
    expect(screen.getByText(/insufficient_quota/)).toBeInTheDocument()
    expect(screen.getByText("아래 편집기에 직접 작성해서 보내실 수 있어요.")).toBeInTheDocument()
    // 빈 편집기가 실제로 열려 있다 — 여기서 막히지 않는다.
    expect(screen.getByLabelText("본문")).toHaveValue("")
  })

  it("AI가 실패해도 직접 쓴 본문으로 발송된다", async () => {
    const sendLoveCallMail = vi.fn(async () => ({
      ...UNSENT,
      sent: true,
      sentAt: "2026-09-15T04:00:00Z",
      subject: "제목",
      body: "직접 쓴 본문",
    }))
    const api = makeClient({
      sendLoveCallMail,
      draftLoveCallMail: async () => ({
        subject: "제목",
        body: "",
        aiGenerated: false,
        error: "크레딧이 소진되었습니다",
        recipientOrgName: "VinaContent",
        recipientCount: 2,
      }),
    })
    const user = await openEditor(api)

    await user.type(await screen.findByLabelText("본문"), "직접 쓴 본문")
    await user.click(screen.getByRole("button", { name: /발송하기/ }))

    await waitFor(() =>
      expect(sendLoveCallMail).toHaveBeenCalledWith(MEETING, {
        subject: "제목",
        body: "직접 쓴 본문",
      }),
    )
  })

  it("초안 요청 자체가 실패하면 사유와 재시도를 보여준다", async () => {
    const api = makeClient({
      draftLoveCallMail: async () => {
        throw new Error("이 미팅의 러브콜 메일은 이미 발송했습니다")
      },
    })
    await openEditor(api)

    expect(await screen.findByText("초안을 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.getByText("이 미팅의 러브콜 메일은 이미 발송했습니다")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /AI로 다시 쓰기/ }).length).toBeGreaterThan(0)
  })
})

describe("러브콜 메일 — 발송 실패는 화면에 남는다", () => {
  it("발송이 실패하면 사유를 보여주고 작성한 내용을 잃지 않는다", async () => {
    const api = makeClient({
      sendLoveCallMail: async () => {
        throw new Error("메일 발송에 실패했어요: SMTPAuthenticationError: 535")
      },
    })
    const user = await openEditor(api)

    await screen.findByDisplayValue(AI_DRAFT.subject)
    await user.click(screen.getByRole("button", { name: /발송하기/ }))

    expect(await screen.findByText("발송에 실패했어요")).toBeInTheDocument()
    expect(screen.getByText(/SMTPAuthenticationError/)).toBeInTheDocument()
    // 완료 화면으로 넘어가지 않고, 편집기 내용도 그대로다 → 그대로 다시 시도할 수 있다.
    expect(screen.queryByText("러브콜 메일을 보냈어요")).not.toBeInTheDocument()
    expect(screen.getByDisplayValue(AI_DRAFT.body)).toBeInTheDocument()
  })

  it("상태 조회가 실패하면 카드 자리에 사유와 재시도를 띄운다", async () => {
    const getLoveCallMailState = vi
      .fn<ReviewClient["getLoveCallMailState"]>()
      .mockRejectedValueOnce(new Error("API 500"))
      .mockResolvedValueOnce(UNSENT)
    const api = makeClient({ getLoveCallMailState })
    const user = userEvent.setup()
    render(<LoveCallMailCard meetingId={MEETING} api={api} />)

    expect(await screen.findByText("러브콜 메일 상태를 불러오지 못했어요")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /AI로 다시 쓰기/ }))
    expect(await screen.findByRole("button", { name: /AI로 메일 작성하기/ })).toBeInTheDocument()
  })
})

describe("러브콜 메일 — 보낼 곳이 없으면 막는다", () => {
  it("상대 기업에 담당자 이메일이 없으면 이유를 보여주고 작성을 막는다", async () => {
    const api = makeClient({
      getLoveCallMailState: async () => ({ ...UNSENT, recipientCount: 0 }),
    })
    render(<LoveCallMailCard meetingId={MEETING} api={api} />)

    expect(
      await screen.findByText("VinaContent에 등록된 담당자 이메일이 없어 발송할 수 없어요."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /AI로 메일 작성하기/ })).toBeDisabled()
  })

  it("회의록이 아직 없으면 먼저 확정하라고 안내한다", async () => {
    const api = makeClient({
      getLoveCallMailState: async () => ({ ...UNSENT, reportReady: false }),
    })
    render(<LoveCallMailCard meetingId={MEETING} api={api} />)

    expect(
      await screen.findByText("회의록을 먼저 확정하면 AI가 그 내용을 바탕으로 메일을 써 드려요."),
    ).toBeInTheDocument()
  })
})
