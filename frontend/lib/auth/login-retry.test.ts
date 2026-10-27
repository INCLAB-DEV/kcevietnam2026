import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LoginRequestError } from "./login-errors"
import {
  LOGIN_BUSY_MAX_RETRIES,
  LOGIN_BUSY_MAX_WAIT_MS,
  LoginRetryAbortedError,
  isRetryableBusy,
  nextBusyRetryDelayMs,
  retryWhileBusy,
} from "./login-retry"

// 몰림 자동 재시도 규칙 — 무엇을 다시 보내는지(503 + login_busy·server_busy만), 몇 번·얼마 간격으로(최대 4번, 첫
// 1.0~2.5초 → ×1.6 ±30% → 상한 6초), 언제 그만두는지(그 밖의 오류·재시도 소진·abort).

const PATH = "/api/auth/login/start"
const busy = (code: string = "login_busy") => new LoginRequestError(PATH, 503, code)

describe("isRetryableBusy — 몰림 거절만 다시 보낸다", () => {
  it("503 + login_busy·server_busy는 재시도 대상", () => {
    expect(isRetryableBusy(busy("login_busy"))).toBe(true)
    expect(isRetryableBusy(busy("server_busy"))).toBe(true)
  })

  it("코드 없는 503·그 밖의 5xx·4xx·네트워크 오류는 재시도하지 않는다", () => {
    expect(isRetryableBusy(new LoginRequestError(PATH, 503, null))).toBe(false)
    expect(isRetryableBusy(new LoginRequestError(PATH, 500, "login_busy"))).toBe(false)
    expect(isRetryableBusy(new LoginRequestError(PATH, 500, "upstream_error"))).toBe(false)
    expect(isRetryableBusy(new LoginRequestError(PATH, 502, "upstream_unavailable"))).toBe(false)
    expect(isRetryableBusy(new LoginRequestError(PATH, 400, "invalid_body"))).toBe(false)
    expect(isRetryableBusy(new TypeError("Failed to fetch"))).toBe(false)
  })
})

describe("nextBusyRetryDelayMs — 간격 범위", () => {
  it("첫 대기는 1.0~2.5초 사이에서 고른다", () => {
    expect(nextBusyRetryDelayMs(null, () => 0)).toBe(1000)
    expect(nextBusyRetryDelayMs(null, () => 0.5)).toBe(1750)
    expect(nextBusyRetryDelayMs(null, () => 0.999999)).toBe(2500)
  })

  it("다음 대기는 직전 × 1.6 × (0.7~1.3), 상한 6초", () => {
    expect(nextBusyRetryDelayMs(2000, () => 0)).toBe(2240) // 2000 × 1.6 × 0.7
    expect(nextBusyRetryDelayMs(2000, () => 0.5)).toBe(3200) // 2000 × 1.6 × 1.0
    expect(nextBusyRetryDelayMs(2000, () => 0.999999)).toBe(4160) // 2000 × 1.6 × 1.3
    expect(nextBusyRetryDelayMs(5000, () => 0.5)).toBe(LOGIN_BUSY_MAX_WAIT_MS) // 8000 → 상한
  })

  it("무작위 간격 1000벌 — 매번 범위 안이고 어떤 대기도 6초를 넘지 않는다", () => {
    for (let run = 0; run < 1000; run += 1) {
      let previous: number | null = null
      for (let retry = 1; retry <= LOGIN_BUSY_MAX_RETRIES; retry += 1) {
        const delay = nextBusyRetryDelayMs(previous)
        if (previous === null) {
          expect(delay).toBeGreaterThanOrEqual(1000)
          expect(delay).toBeLessThanOrEqual(2500)
        } else {
          expect(delay).toBeGreaterThanOrEqual(Math.min(Math.floor(previous * 1.6 * 0.7), LOGIN_BUSY_MAX_WAIT_MS))
          expect(delay).toBeLessThanOrEqual(Math.min(Math.ceil(previous * 1.6 * 1.3), LOGIN_BUSY_MAX_WAIT_MS))
        }
        expect(delay).toBeLessThanOrEqual(LOGIN_BUSY_MAX_WAIT_MS)
        previous = delay
      }
    }
  })
})

describe("retryWhileBusy (가짜 타이머)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("busy → busy → 성공: 정해진 간격을 기다린 뒤 다시 보내고 결과를 돌려준다", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy("server_busy"))
      .mockResolvedValueOnce("ok")
    const waits: Array<[number, number]> = []
    const result = retryWhileBusy(attempt, {
      signal: new AbortController().signal,
      onRetryWait: (retry, delayMs) => waits.push([retry, delayMs]),
      random: () => 0, // 1000ms → 1120ms
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(attempt).toHaveBeenCalledTimes(1) // 첫 대기(1000ms)가 끝나기 전엔 다시 보내지 않는다
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1120)
    expect(attempt).toHaveBeenCalledTimes(3)

    await expect(result).resolves.toBe("ok")
    expect(waits).toEqual([
      [1, 1000],
      [2, 1120],
    ])
  })

  it("5번 모두 busy면 재시도 4번을 다 쓴 뒤 마지막 거절을 그대로 던진다", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockImplementation(() => Promise.reject(busy()))
    const waits: number[] = []
    const outcome = retryWhileBusy(attempt, {
      signal: new AbortController().signal,
      onRetryWait: (_retry, delayMs) => waits.push(delayMs),
    }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(4 * LOGIN_BUSY_MAX_WAIT_MS)

    const error = await outcome
    expect(error).toBeInstanceOf(LoginRequestError)
    expect(error).toMatchObject({ status: 503, code: "login_busy" })
    expect(attempt).toHaveBeenCalledTimes(1 + LOGIN_BUSY_MAX_RETRIES)
    expect(waits).toHaveLength(LOGIN_BUSY_MAX_RETRIES)
    expect(waits.every((delay) => delay >= 1000 && delay <= LOGIN_BUSY_MAX_WAIT_MS)).toBe(true)
  })

  it("그 밖의 오류는 기다리지 않고 바로 던진다(1번만 보낸다)", async () => {
    for (const failure of [
      new LoginRequestError(PATH, 500, "upstream_error"),
      new LoginRequestError(PATH, 503, null),
      new TypeError("Failed to fetch"),
    ]) {
      const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(failure)
      const outcome = retryWhileBusy(attempt, { signal: new AbortController().signal }).catch(
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(4 * LOGIN_BUSY_MAX_WAIT_MS)
      expect(await outcome).toBe(failure)
      expect(attempt).toHaveBeenCalledTimes(1)
    }
  })

  it("결과(아이디/비번 거부 포함)는 그대로 돌려주고 다시 보내지 않는다", async () => {
    const rejected = { outcome: "rejected", reason: "invalid_credentials" }
    const attempt = vi.fn<() => Promise<typeof rejected>>().mockResolvedValue(rejected)

    await expect(retryWhileBusy(attempt, { signal: new AbortController().signal })).resolves.toBe(rejected)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it("기다리는 중에 abort하면 바로 그만두고 더 보내지 않는다", async () => {
    const controller = new AbortController()
    const attempt = vi.fn<() => Promise<string>>().mockImplementation(() => Promise.reject(busy()))
    const outcome = retryWhileBusy(attempt, { signal: controller.signal, random: () => 0 }).catch(
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(500) // 첫 대기(1000ms) 중
    controller.abort()

    expect(await outcome).toBeInstanceOf(LoginRetryAbortedError)
    await vi.advanceTimersByTimeAsync(4 * LOGIN_BUSY_MAX_WAIT_MS)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it("요청이 진행 중일 때 abort하면 그 응답은 결과든 거절이든 버린다", async () => {
    const controller = new AbortController()
    let resolveAttempt: (value: string) => void = () => {}
    const attempt = vi.fn<() => Promise<string>>().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveAttempt = resolve
        }),
    )
    const outcome = retryWhileBusy(attempt, { signal: controller.signal }).catch((error: unknown) => error)

    controller.abort()
    resolveAttempt("succeeded-but-stale")

    expect(await outcome).toBeInstanceOf(LoginRetryAbortedError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it("attempt는 첫 시도·재시도 모두 같은 signal을 받는다(요청에 넘겨 진행 중인 요청도 끊을 수 있게)", async () => {
    const controller = new AbortController()
    const attempt = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce("ok")
    const result = retryWhileBusy(attempt, { signal: controller.signal, random: () => 0 })

    await vi.advanceTimersByTimeAsync(1000)

    await expect(result).resolves.toBe("ok")
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt.mock.calls[0][0]).toBe(controller.signal)
    expect(attempt.mock.calls[1][0]).toBe(controller.signal)
  })

  it("진행 중인 요청이 끊겨 AbortError를 던져도 오류로 올리지 않고 LoginRetryAbortedError로 끝낸다", async () => {
    const controller = new AbortController()
    // 실제 fetch처럼: 응답 없이 매달려 있다가 signal이 끊기면 그 사유(AbortError)로 거절한다.
    const attempt = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    )
    const outcome = retryWhileBusy(attempt, { signal: controller.signal }).catch((error: unknown) => error)

    controller.abort()

    expect(await outcome).toBeInstanceOf(LoginRetryAbortedError)
    await vi.advanceTimersByTimeAsync(4 * LOGIN_BUSY_MAX_WAIT_MS)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
