import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LoveCallMailApiError, isParticipantEmailDisabled } from "./api-error"
import { createHttpReviewClient } from "./http-review-client"

// 이 클라이언트에서 지키는 로케일 계약은 둘이다.
//  ① 백엔드가 문장·이름을 만들어 주는 호출(러브콜 메일·보고서 내보내기)에는 화면 로케일을 `?locale=`로 싣는다.
//     빠지면 백엔드는 ko로 답하고, en 화면에 한국어 기업명·거절 문구가 조용히 돌아온다.
//  ② 전사 실패는 한국어 문구(error)가 아니라 코드(error_code)로 읽는다 — 문구는 화면이 카탈로그에서 고른다.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const MAIL_STATE = {
  recipient_org_name: "VinaContent",
  recipient_count: 2,
  report_ready: true,
  sent: false,
  sent_at: null,
  subject: null,
  body: null,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const calledUrl = (index = 0) => String(fetchMock.mock.calls[index][0])

describe("createHttpReviewClient — 러브콜 메일·내보내기에 화면 로케일을 싣는다", () => {
  it("en 클라이언트는 러브콜 메일 세 호출 모두에 locale=en을 붙인다", async () => {
    const client = createHttpReviewClient("en")
    fetchMock
      .mockResolvedValueOnce(json(MAIL_STATE))
      .mockResolvedValueOnce(
        json({ subject: "s", body: "b", ai_generated: true, error: null, recipient_org_name: "VinaContent", recipient_count: 2 }),
      )
      .mockResolvedValueOnce(json({ ...MAIL_STATE, sent: true }))

    const state = await client.getLoveCallMailState("m1")
    await client.draftLoveCallMail("m1")
    await client.sendLoveCallMail("m1", { subject: "s", body: "b" })

    expect(calledUrl(0)).toBe("/api/reviews/m1/love-call/mail?locale=en")
    expect(calledUrl(1)).toBe("/api/reviews/m1/love-call/mail/draft?locale=en")
    expect(calledUrl(2)).toBe("/api/reviews/m1/love-call/mail/send?locale=en")
    // 기업명은 백엔드가 로케일에 맞춰 준 값을 그대로 쓴다(여기서 다시 고르지 않는다).
    expect(state.recipientOrgName).toBe("VinaContent")
  })

  it("로케일을 주지 않으면 ko다 — 한국어 화면의 요청은 이전과 같은 응답을 받는다", async () => {
    fetchMock.mockResolvedValueOnce(json(MAIL_STATE))
    await createHttpReviewClient().getLoveCallMailState("m1")
    expect(calledUrl()).toBe("/api/reviews/m1/love-call/mail?locale=ko")
  })

  it("러브콜 거절은 백엔드가 준 문구(요청 로케일로 이미 골라진 것)를 그대로 에러 메시지로 올린다", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "A Love Call email has already been sent for this meeting" }, 409))
    await expect(createHttpReviewClient("en").draftLoveCallMail("m1")).rejects.toThrow(
      "A Love Call email has already been sent for this meeting",
    )
  })

  it("보고서 내보내기 주소에 형식과 로케일이 함께 실린다", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }))
    // 내려받기는 임시 <a>를 눌러 일으킨다 — jsdom은 문서 이동을 구현하지 않으므로 클릭만 가로챈다.
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["x"]), { status: 200 }))

    await createHttpReviewClient("en").downloadReport("m1", "docx")

    expect(calledUrl()).toBe("/api/reviews/m1/review/export?fmt=docx&locale=en")
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })
})

describe("createHttpReviewClient — 러브콜 메일과 행사 메일 스위치", () => {
  it("상태의 participant_email_enabled를 emailEnabled로 옮긴다", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ...MAIL_STATE, participant_email_enabled: false }))
      .mockResolvedValueOnce(json({ ...MAIL_STATE, participant_email_enabled: true }))
    const client = createHttpReviewClient()

    expect((await client.getLoveCallMailState("m1")).emailEnabled).toBe(false)
    expect((await client.getLoveCallMailState("m1")).emailEnabled).toBe(true)
  })

  it("필드가 없는 응답(이 값을 모르는 구 백엔드)은 켜짐으로 읽는다 — 구 백엔드는 스위치와 무관하게 보낸다", async () => {
    fetchMock.mockResolvedValueOnce(json(MAIL_STATE))
    expect((await createHttpReviewClient().getLoveCallMailState("m1")).emailEnabled).toBe(true)
  })

  it("발송이 409 PARTICIPANT_EMAIL_DISABLED면 코드와 화면 문구를 실은 오류를 던진다(JSON 원문이 아니다)", async () => {
    const message = "이 행사는 메일 발송이 꺼져 있어 러브콜 메일을 보낼 수 없습니다."
    fetchMock.mockResolvedValueOnce(
      json({ detail: { code: "PARTICIPANT_EMAIL_DISABLED", message } }, 409),
    )

    const error = await createHttpReviewClient()
      .sendLoveCallMail("m1", { subject: "s", body: "b" })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LoveCallMailApiError)
    expect(isParticipantEmailDisabled(error)).toBe(true)
    expect((error as LoveCallMailApiError).status).toBe(409)
    expect((error as Error).message).toBe(message)
  })

  it("문자열 detail 거절(이미 보냄·발송 실패)은 코드 없이 백엔드 문구 그대로다 — 메일 꺼짐으로 보지 않는다", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ detail: "이 미팅의 러브콜 메일은 이미 발송했습니다" }, 409))
      .mockResolvedValueOnce(json({ detail: "메일 발송에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502))
    const client = createHttpReviewClient()

    const already = await client.sendLoveCallMail("m1", { subject: "s", body: "b" }).catch((e: unknown) => e)
    expect((already as Error).message).toBe("이 미팅의 러브콜 메일은 이미 발송했습니다")
    expect(isParticipantEmailDisabled(already)).toBe(false)

    const failed = await client.sendLoveCallMail("m1", { subject: "s", body: "b" }).catch((e: unknown) => e)
    expect((failed as Error).message).toBe("메일 발송에 실패했어요. 잠시 후 다시 시도해 주세요.")
    expect(isParticipantEmailDisabled(failed)).toBe(false)
  })
})

describe("createHttpReviewClient — 전사 실패는 코드로 읽는다", () => {
  const status = (body: unknown) => {
    fetchMock.mockResolvedValueOnce(json(body))
    return createHttpReviewClient("en").getTranscriptionStatus("m1", "job-1")
  }

  it("audio_too_long → audioTooLong(나눠 올리라는 안내가 따로 있다)", async () => {
    const result = await status({
      status: "error",
      draft: null,
      error: "녹음이 너무 길어요(최대 45분). 45분 이하로 나눠서 다시 올려 주세요.",
      error_code: "audio_too_long",
    })
    expect(result).toEqual({ status: "error", failure: "audioTooLong" })
  })

  it("그 밖의 코드·코드 없는 응답(배포 순서가 어긋난 구버전 백엔드)·모르는 코드는 일반 실패다", async () => {
    const korean = "녹음 정리에 실패했어요. 잠시 후 다시 시도해 주세요."
    expect(await status({ status: "error", draft: null, error: korean, error_code: "failed" })).toEqual({ status: "error", failure: "failed" })
    expect(await status({ status: "error", draft: null, error: korean })).toEqual({ status: "error", failure: "failed" })
    expect(await status({ status: "error", draft: null, error: korean, error_code: "brand_new" })).toEqual({ status: "error", failure: "failed" })
  })

  it("한국어 문구(error)는 결과에 실리지 않는다 — 화면에 그대로 띄울 길을 남기지 않는다", async () => {
    const result = await status({ status: "error", draft: null, error: "한국어 문구", error_code: "failed" })
    expect(JSON.stringify(result)).not.toMatch(/[가-힣]/)
  })

  it("진행 중이면 pending", async () => {
    expect(await status({ status: "pending", draft: null, error: null, error_code: null })).toEqual({ status: "pending" })
  })
})
