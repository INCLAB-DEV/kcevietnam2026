// 로그인 요청이 몰림으로 거절됐을 때(503 login_busy·server_busy) 같은 요청을 잠시 뒤 자동으로 다시 보내는 규칙 —
// 클라 안전(순수) 모듈. 화면(components/auth/login-flow)이 /api/auth/login/start에만 쓴다.
//
// 왜(2026-10-03): 백엔드는 비밀번호 대조 대기열이 차면 기다리게 하지 않고 즉시 503을 돌려준다 — 기다리는 요청이
// 서버 스레드를 다 먹어 다른 API까지 멈추지 않게(backend app/auth/credentials.py password_hash_slot). 그 몰림은 보통
// 몇 초면 풀리므로, 사용자에게 실패를 보이고 다시 누르게 하는 대신 화면이 무작위 간격으로 몇 번 더 보낸다. 간격이
// 무작위인 이유: 같은 순간 거절된 사람들이 똑같은 간격으로 다시 몰리면 또 함께 거절된다.
//
// 재시도해도 되는 근거: 거절된 /login/start는 서버에 아무것도 남기지 않는다 — 503은 비밀번호 대조 자리를 얻기 전에
// 나고, 그 앞은 읽기뿐이며 Cognito 호출·로그인 티켓 발급은 그 뒤다(backend app/auth/login_router.py login_start).
// /login/complete는 재시도하지 않는다 — 티켓을 받는 순간 소진하므로(일회성) 같은 요청을 다시 보내면 ticket_invalid가
// 되고, 비밀번호를 해시하지 않아 login_busy를 내지도 않는다.

import { LoginRequestError } from "./login-errors"

// 첫 시도가 거절된 뒤 다시 보내는 횟수 — 요청은 최대 1 + 4 = 5번.
export const LOGIN_BUSY_MAX_RETRIES = 4
// 대기 한 번의 상한(ms).
export const LOGIN_BUSY_MAX_WAIT_MS = 6000

// 첫 대기는 1.0~2.5초에서 고르게, 그다음부터는 직전 대기 × 1.6 × (1 ± 30%) — 상한 6초.
const FIRST_WAIT_MIN_MS = 1000
const FIRST_WAIT_MAX_MS = 2500
const GROWTH = 1.6
const JITTER = 0.3

const RETRYABLE_BUSY_CODES: ReadonlySet<string> = new Set(["login_busy", "server_busy"])

// 자동으로 다시 보낼 실패인가 — 서버가 503과 함께 몰림 코드를 밝혔을 때만. 아이디/비번 거부(200 결과)·그 밖의
// 4xx·5xx(upstream_error·upstream_unavailable)·코드 없는 503·네트워크 단절은 다시 보내지 않는다.
export function isRetryableBusy(error: unknown): boolean {
  return (
    error instanceof LoginRequestError &&
    error.status === 503 &&
    error.code !== null &&
    RETRYABLE_BUSY_CODES.has(error.code)
  )
}

// 다음 대기(ms, 정수). previousMs가 null이면 첫 대기다. random은 [0, 1) 값을 돌려준다(테스트가 바꿔 끼운다).
export function nextBusyRetryDelayMs(previousMs: number | null, random: () => number = Math.random): number {
  const raw =
    previousMs === null
      ? FIRST_WAIT_MIN_MS + random() * (FIRST_WAIT_MAX_MS - FIRST_WAIT_MIN_MS)
      : previousMs * GROWTH * (1 - JITTER + random() * 2 * JITTER)
  return Math.round(Math.min(raw, LOGIN_BUSY_MAX_WAIT_MS))
}

// 입력을 고쳤거나 화면을 떠나 재시도를 그만뒀다 — 화면은 이걸 오류로 보이지 않는다.
export class LoginRetryAbortedError extends Error {
  constructor() {
    super("login retry aborted")
    this.name = "LoginRetryAbortedError"
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LoginRetryAbortedError()
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LoginRetryAbortedError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LoginRetryAbortedError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export interface BusyRetryOptions {
  // 그만두기 — 끊긴 뒤에 도착한 응답은 결과든 오류든 버리고 LoginRetryAbortedError로 끝낸다.
  signal: AbortSignal
  // 대기를 시작할 때마다(몇 번째 재시도인지, 몇 ms 기다리는지) — 화면이 "잠시 기다리는 중" 문구를 띄운다.
  onRetryWait?: (retry: number, delayMs: number) => void
  random?: () => number
}

// attempt를 부르고, 몰림 거절(isRetryableBusy)이면 기다렸다가 같은 attempt를 최대 LOGIN_BUSY_MAX_RETRIES번 더 부른다.
// 그 밖의 오류는 바로 던지고, 재시도를 다 써도 거절이면 마지막 거절을 그대로 던진다.
// attempt는 매번 같은 signal을 받는다 — 요청(fetch)에 그대로 넘겨, 그만두는 순간 진행 중인 네트워크 요청도 끊게 한다
// (결과만 버리면 뒤늦게 도착한 응답의 세션 쿠키는 그대로 심긴다). 끊긴 요청이 던지는 오류(AbortError)도 여기서
// LoginRetryAbortedError로 바뀐다.
export async function retryWhileBusy<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  options: BusyRetryOptions,
): Promise<T> {
  const { signal, onRetryWait, random = Math.random } = options
  let previousDelay: number | null = null
  for (let retriesDone = 0; ; retriesDone += 1) {
    try {
      const result = await attempt(signal)
      throwIfAborted(signal)
      return result
    } catch (error) {
      throwIfAborted(signal)
      if (!isRetryableBusy(error) || retriesDone >= LOGIN_BUSY_MAX_RETRIES) throw error
      const delay = nextBusyRetryDelayMs(previousDelay, random)
      previousDelay = delay
      onRetryWait?.(retriesDone + 1, delay)
      await waitOrAbort(delay, signal)
    }
  }
}
