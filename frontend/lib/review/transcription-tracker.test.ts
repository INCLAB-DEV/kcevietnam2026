// 전사 작업 폴링 회귀 잠금(동시성 하드닝 1차 후속) — 백엔드 전사 풀(동시 3건)이 밀려 작업이 대기열에서
// 기다리는 동안 화면이 작업을 버리지 않는지 본다. 예전 상한은 5분이라, 서버에선 결국 끝나는 작업을
// "지연"으로 끊었다.
//
// 잠그는 것:
// - 5분을 넘겨도 pending이면 계속 폴링하고, 끝나면 초안을 받는다(전체 상한 30분).
// - 처음 2분 안에는 안내가 없고, 2분이 지나도 pending이면 '조금 더 걸릴 수 있음'을 한 번 알린다(onWaiting).
// - 폴링 간격: 처음 2분은 2.5초, 그 뒤는 5초.
// - 30분 내내 pending일 때만 지연 안내로 끝낸다.
// - (2026-10-02) 연속 실패 시 간격을 두 배씩 늘리고(상한 30초) 성공하면 되돌린다. 폴링 1회는 15초에 끊고
//   (요청 abort) 다음 차례로 넘어간다. 응답이 계속 안 와도 30분 상한은 실제 경과 시간으로 지킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetNotificationStore } from "@/lib/notifications/store"
import {
  MAX_ERROR_BACKOFF_MS,
  POLL_TIMEOUT_MS,
  nextPollDelay,
  takeCompletedDraft,
  trackTranscription,
} from "./transcription-tracker"
import type { ReviewClient, StructureDraft, TranscriptionStatus } from "./types"

const MIN = 60 * 1000
// 추적기는 실패 문구가 아니라 **종류**를 알린다(문구는 화면이 로케일 카탈로그에서 고른다).
const DELAYED = "delayed"

const DRAFT: StructureDraft = {
  report: { discussion: ["사거리 연장 논의"], agreements: [], actions: [] },
  fitSuggestion: "good",
  fitReasonSeed: "",
  fitReasonTags: [],
  transcript: "전사 원문",
  transcriptTurns: [],
}

let seq = 0

// 상태를 테스트가 정한다 — state.next를 바꾸면 다음 폴링부터 그 결과가 나간다.
function startTracking() {
  seq += 1
  const state: { next: TranscriptionStatus } = { next: { status: "pending" } }
  const getTranscriptionStatus = vi.fn(async () => state.next)
  const client = { getTranscriptionStatus } as unknown as ReviewClient
  const handlers = { onDone: vi.fn(), onError: vi.fn(), onWaiting: vi.fn() }
  const meetingId = `tracker-meeting-${seq}`
  const detach = trackTranscription(
    { client, meetingId, jobId: `tracker-job-${seq}`, orgId: "org-exhibitor", counterpartOrg: "풍산" },
    handlers,
  )
  return { state, getTranscriptionStatus, handlers, meetingId, detach }
}

describe("trackTranscription — 대기열을 고려한 폴링", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNotificationStore()
  })

  it("예전 상한(5분)을 넘겨도 pending이면 끊지 않고, 20분 뒤에 끝나도 초안을 받는다", async () => {
    const { state, handlers, meetingId } = startTracking()

    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(handlers.onDone).not.toHaveBeenCalled()

    state.next = { status: "done", draft: DRAFT }
    await vi.advanceTimersByTimeAsync(5000)
    expect(handlers.onDone).toHaveBeenCalledWith(DRAFT)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(takeCompletedDraft(meetingId)).toEqual(DRAFT)
  })

  it("처음 2분 안에는 안내가 없고, 2분이 지나도 pending이면 한 번만 알린다", async () => {
    const { handlers } = startTracking()

    await vi.advanceTimersByTimeAsync(2 * MIN - 1)
    expect(handlers.onWaiting).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(handlers.onWaiting).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(handlers.onWaiting).toHaveBeenCalledTimes(1)
    expect(handlers.onError).not.toHaveBeenCalled() // 대기는 오류가 아니다
  })

  it("2분 안에 끝나면 안내 없이 완료된다", async () => {
    const { state, handlers, getTranscriptionStatus } = startTracking()

    await vi.advanceTimersByTimeAsync(30 * 1000)
    state.next = { status: "done", draft: DRAFT }
    await vi.advanceTimersByTimeAsync(2500)
    expect(handlers.onDone).toHaveBeenCalledTimes(1)

    const polls = getTranscriptionStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(handlers.onWaiting).not.toHaveBeenCalled()
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(polls) // 끝난 작업은 더 폴링하지 않는다
  })

  it("처음 2분은 2.5초, 그 뒤엔 5초 간격으로 폴링한다", async () => {
    const { getTranscriptionStatus } = startTracking()

    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(48) // 120초 / 2.5초

    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(48 + 12) // 이후 60초 / 5초
  })

  it("30분 내내 pending일 때만 지연 안내로 끝내고, 그 뒤로는 폴링하지 않는다", async () => {
    const { handlers, getTranscriptionStatus } = startTracking()

    await vi.advanceTimersByTimeAsync(30 * MIN - 1)
    expect(handlers.onError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(DELAYED)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(48 + 336) // 2분 × 2.5초 + 28분 × 5초

    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(48 + 336)
  })

  it("화면을 떠나(detach) 있으면 안내를 부르지 않지만, 폴링과 완료 캐시는 계속된다", async () => {
    const { state, handlers, meetingId, detach } = startTracking()
    detach()

    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(handlers.onWaiting).not.toHaveBeenCalled()

    state.next = { status: "done", draft: DRAFT }
    await vi.advanceTimersByTimeAsync(5000)
    expect(handlers.onDone).not.toHaveBeenCalled()
    expect(takeCompletedDraft(meetingId)).toEqual(DRAFT) // 다시 들어오면 복원된다
  })
})

// 응답을 테스트가 한 번씩 정한다 — 큐에 넣은 동작을 차례로 쓰고, 다 쓰면 pending.
type Step = { kind: "status"; value: TranscriptionStatus } | { kind: "fail" } | { kind: "hang" }

function startScriptedTracking(steps: Step[]) {
  seq += 1
  const signals: (AbortSignal | undefined)[] = []
  const getTranscriptionStatus = vi.fn(
    (_meetingId: string, _jobId: string, options?: { signal?: AbortSignal }): Promise<TranscriptionStatus> => {
      signals.push(options?.signal)
      const step = steps.shift()
      if (!step) return Promise.resolve({ status: "pending" })
      if (step.kind === "fail") return Promise.reject(new Error("API 502"))
      if (step.kind === "hang") return new Promise<TranscriptionStatus>(() => {}) // 응답이 오지 않는 요청
      return Promise.resolve(step.value)
    },
  )
  const client = { getTranscriptionStatus } as unknown as ReviewClient
  const handlers = { onDone: vi.fn(), onError: vi.fn(), onWaiting: vi.fn() }
  trackTranscription(
    { client, meetingId: `tracker-meeting-${seq}`, jobId: `tracker-job-${seq}`, orgId: "org-exhibitor", counterpartOrg: "풍산" },
    handlers,
  )
  return { getTranscriptionStatus, handlers, signals }
}

describe("nextPollDelay — 연속 실패 지수 백오프", () => {
  it("평소엔 단계별 간격, 연속 실패 n회면 간격 × 2^n, 상한 30초", () => {
    expect(nextPollDelay(0, 0)).toBe(2500)
    expect(nextPollDelay(0, 1)).toBe(5000)
    expect(nextPollDelay(0, 2)).toBe(10000)
    expect(nextPollDelay(0, 3)).toBe(20000)
    expect(nextPollDelay(0, 4)).toBe(MAX_ERROR_BACKOFF_MS)
    expect(nextPollDelay(0, 50)).toBe(MAX_ERROR_BACKOFF_MS)
    expect(nextPollDelay(3 * MIN, 0)).toBe(5000)
    expect(nextPollDelay(3 * MIN, 1)).toBe(10000)
    expect(nextPollDelay(3 * MIN, 3)).toBe(MAX_ERROR_BACKOFF_MS)
  })
})

describe("trackTranscription — 실패 백오프·폴링 시간 초과", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNotificationStore()
  })

  it("연속 실패하면 간격을 2.5→5→10→20→30초로 늘리고, 한 번 응답을 받으면 2.5초로 돌아간다", async () => {
    const fails: Step[] = Array.from({ length: 5 }, () => ({ kind: "fail" as const }))
    const { getTranscriptionStatus, handlers } = startScriptedTracking(fails)

    // 실패 시각: 2.5초, +5 = 7.5초, +10 = 17.5초, +20 = 37.5초, +30 = 67.5초(상한) → 다음(성공)은 +30 = 97.5초.
    await vi.advanceTimersByTimeAsync(2500)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(1) // 실패 직후엔 2.5초가 아니라 5초를 기다린다
    await vi.advanceTimersByTimeAsync(1)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(20000)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(29999)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(4) // 40초가 아니라 상한 30초
    await vi.advanceTimersByTimeAsync(1)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(30000)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(6) // 97.5초 — 이번엔 pending 응답(성공)

    await vi.advanceTimersByTimeAsync(2500)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(7) // 응답을 받았으니 원래 간격(처음 2분은 2.5초)
    expect(handlers.onError).not.toHaveBeenCalled() // 일시적 실패는 오류 안내가 아니다
  })

  it("응답이 없는 폴링은 15초에 끊고(요청 abort) 다음 차례에 다시 묻는다", async () => {
    const { getTranscriptionStatus, handlers, signals } = startScriptedTracking([
      { kind: "hang" },
      { kind: "status", value: { status: "done", draft: DRAFT } },
    ])

    await vi.advanceTimersByTimeAsync(2500)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(1)
    expect(signals[0]?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS)
    expect(signals[0]?.aborted).toBe(true) // 매달린 요청은 취소된다

    await vi.advanceTimersByTimeAsync(5000) // 실패 1회 → 5초 뒤 다음 폴링
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(2)
    expect(handlers.onDone).toHaveBeenCalledWith(DRAFT)
  })

  it("응답이 계속 안 와도 30분(실제 경과)에서 지연 안내로 끝내고 더 묻지 않는다", async () => {
    const hangs: Step[] = Array.from({ length: 200 }, () => ({ kind: "hang" as const }))
    const { getTranscriptionStatus, handlers } = startScriptedTracking(hangs)

    await vi.advanceTimersByTimeAsync(29 * MIN)
    expect(handlers.onError).not.toHaveBeenCalled()

    // 마지막 폴링은 30분 직전에 시작해 최대 백오프(30초) + 시간 초과(15초) 안에 끝난다.
    await vi.advanceTimersByTimeAsync(MIN + MAX_ERROR_BACKOFF_MS + POLL_TIMEOUT_MS)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(DELAYED)

    const polls = getTranscriptionStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(getTranscriptionStatus).toHaveBeenCalledTimes(polls)
  })
})
