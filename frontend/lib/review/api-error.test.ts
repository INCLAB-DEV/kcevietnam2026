// 리뷰 API 실패 분류 — 화면이 "AI 바쁨·파일 초과·그 밖"을 상태 코드와 detail.code로 가른다.
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  LoveCallMailApiError,
  PARTICIPANT_EMAIL_DISABLED,
  ReviewApiError,
  detailCode,
  isParticipantEmailDisabled,
  reviewFailureKind,
} from "./api-error"
import { createHttpReviewClient } from "./http-review-client"
import { MAX_RECORDING_BYTES, isRecordingTooLarge } from "./recording-limit"

describe("detailCode", () => {
  it("{detail: {code}} 형태에서 코드를 꺼낸다", () => {
    expect(detailCode(JSON.stringify({ detail: { code: "ai_busy", message: "…" } }))).toBe("ai_busy")
  })

  it("문자열 detail·JSON 아님은 코드 없음", () => {
    expect(detailCode(JSON.stringify({ detail: "미팅 없음" }))).toBeNull()
    expect(detailCode("Service Unavailable")).toBeNull()
  })
})

describe("reviewFailureKind", () => {
  it("코드를 우선 보고, 코드가 없으면 상태로 판단한다", () => {
    expect(reviewFailureKind(new ReviewApiError(503, "ai_busy", ""))).toBe("aiBusy")
    expect(reviewFailureKind(new ReviewApiError(503, null, ""))).toBe("aiBusy")
    expect(reviewFailureKind(new ReviewApiError(413, "audio_too_large", ""))).toBe("audioTooLarge")
    expect(reviewFailureKind(new ReviewApiError(413, null, ""))).toBe("audioTooLarge")
    expect(reviewFailureKind(new ReviewApiError(502, "ai_failed", ""))).toBe("other")
    expect(reviewFailureKind(new Error("network"))).toBe("other")
  })

  it("메시지 형식은 예전과 같다(API {status}: {body})", () => {
    expect(new ReviewApiError(502, "ai_failed", "body").message).toBe("API 502: body")
  })
})

describe("isParticipantEmailDisabled", () => {
  it("러브콜 거절 중 행사 메일 꺼짐 코드만 참이다", () => {
    expect(isParticipantEmailDisabled(new LoveCallMailApiError(409, PARTICIPANT_EMAIL_DISABLED, "꺼짐"))).toBe(true)
    expect(isParticipantEmailDisabled(new LoveCallMailApiError(409, null, "이미 보냄"))).toBe(false)
    // 같은 코드라도 다른 오류 타입(리뷰 API 등)·일반 Error는 아니다.
    expect(isParticipantEmailDisabled(new ReviewApiError(409, PARTICIPANT_EMAIL_DISABLED, ""))).toBe(false)
    expect(isParticipantEmailDisabled(new Error(PARTICIPANT_EMAIL_DISABLED))).toBe(false)
  })

  it("러브콜 오류의 메시지는 화면 문구 그대로다(API {status}: 로 감싸지 않는다)", () => {
    expect(new LoveCallMailApiError(409, PARTICIPANT_EMAIL_DISABLED, "꺼짐").message).toBe("꺼짐")
  })
})

describe("http 리뷰 클라이언트 — 실패를 ReviewApiError로 던진다", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("텍스트 정리 503이 상태·코드를 실은 오류가 된다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ detail: { code: "ai_busy", message: "AI 요청이 많아요." } }, { status: 503 }),
      ),
    )
    const error = await createHttpReviewClient()
      .structureText("m-1", "메모")
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ReviewApiError)
    expect((error as ReviewApiError).status).toBe(503)
    expect((error as ReviewApiError).code).toBe("ai_busy")
  })
})

describe("녹음 크기 상한", () => {
  it("200MB까지는 허용, 넘으면 거절", () => {
    expect(MAX_RECORDING_BYTES).toBe(200 * 1024 * 1024)
    expect(isRecordingTooLarge({ size: MAX_RECORDING_BYTES })).toBe(false)
    expect(isRecordingTooLarge({ size: MAX_RECORDING_BYTES + 1 })).toBe(true)
  })
})
