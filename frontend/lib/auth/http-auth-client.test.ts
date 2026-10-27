import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { httpAuthClient } from "./http-auth-client"
import { LoginRequestError } from "./login-errors"

// http 어댑터 — 200 비즈니스 결과는 예전 그대로 camelCase로 매핑하고, 비정상 응답(503 login_busy·5xx)은
// 상태·detail.code를 실은 LoginRequestError로 던진다(화면이 종류별로 안내 — components/auth/login-flow).

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("httpAuthClient.startLogin", () => {
  it("consent_required는 예전처럼 camelCase로 매핑한다(계약 불변)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ outcome: "consent_required", login_ticket: "t-1", documents: [] }),
    )

    const res = await httpAuthClient.startLogin({ username: "u", password: "p" })

    expect(res).toEqual({ outcome: "consent_required", loginTicket: "t-1", documents: [] })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ username: "u", password: "p", deeplink_token: null })
  })

  it("503 login_busy → LoginRequestError(503, login_busy)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "login_busy", message: "로그인 요청이 많아요." } }, 503),
    )

    const error = await httpAuthClient.startLogin({ username: "u", password: "p" }).catch((e) => e)

    expect(error).toBeInstanceOf(LoginRequestError)
    expect(error).toMatchObject({ status: 503, code: "login_busy" })
  })

  it("본문이 JSON이 아닌 5xx(BFF 자체 장애 페이지 등)도 던지지 않고 LoginRequestError(코드 없음)로", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Internal Server Error</html>", { status: 500 }))

    const error = await httpAuthClient.startLogin({ username: "u", password: "p" }).catch((e) => e)

    expect(error).toBeInstanceOf(LoginRequestError)
    expect(error).toMatchObject({ status: 500, code: null })
  })
})

// 화면이 로그인 시도를 그만두면(입력 수정·화면 이탈) 요청 자체를 끊는다 — 결과만 버리면 뒤늦게 도착한 응답의
// Set-Cookie(그만둔 계정의 세션)는 브라우저에 그대로 심긴다.
describe("httpAuthClient.startLogin — 요청 끊기(signal)", () => {
  // 실제 fetch처럼: 응답 없이 매달려 있다가 signal이 끊기면 그 사유(AbortError)로 거절한다.
  function hangUntilAborted(_path: string, init: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  }

  it("받은 signal을 fetch에 그대로 넘긴다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: "not_found" }))
    const controller = new AbortController()

    await httpAuthClient.startLogin({ username: "u", password: "p" }, { signal: controller.signal })

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal)
  })

  it("요청이 오가는 중에 signal을 끊으면 결과 없이 AbortError로 끝난다(LoginRequestError가 아니다)", async () => {
    fetchMock.mockImplementationOnce(hangUntilAborted)
    const controller = new AbortController()
    const outcome = httpAuthClient
      .startLogin({ username: "u", password: "p" }, { signal: controller.signal })
      .catch((e) => e)

    controller.abort()

    const error = await outcome
    expect(error).not.toBeInstanceOf(LoginRequestError)
    expect(error).toMatchObject({ name: "AbortError" })
  })

  it("signal 없이 부르면 예전처럼 끊을 수 없는 요청으로 나간다(seam 호환)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: "not_found" }))

    await expect(httpAuthClient.startLogin({ username: "u", password: "p" })).resolves.toEqual({ outcome: "not_found" })

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined()
  })
})

describe("httpAuthClient.completeLogin", () => {
  it("502 upstream_unavailable → LoginRequestError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "upstream_unavailable", message: "…" } }, 502),
    )

    const error = await httpAuthClient
      .completeLogin({ loginTicket: "t-1", acceptedDocIds: ["tos"] })
      .catch((e) => e)

    expect(error).toBeInstanceOf(LoginRequestError)
    expect(error).toMatchObject({ status: 502, code: "upstream_unavailable" })
  })
})
