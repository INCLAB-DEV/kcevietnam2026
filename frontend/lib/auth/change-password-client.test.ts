import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  httpChangePasswordClient,
  mockChangePasswordClient,
  MOCK_CURRENT_PASSWORD,
} from "./change-password-client"

// 테스트용 평문 — 응답에 노출되면 안 되는 값.
const NEW_PASSWORD = "NewPassw0rd1"

describe("mockChangePasswordClient", () => {
  it("MOCK_CURRENT_PASSWORD와 일치하면 succeeded", async () => {
    const res = await mockChangePasswordClient.changePassword({
      currentPassword: MOCK_CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "succeeded" })
  })

  // 목업에는 서버 문구가 없다(message: null) — 문구는 화면이 로케일 카탈로그에서 채운다.
  it("불일치하면 invalid_current(서버 문구 없음)", async () => {
    const res = await mockChangePasswordClient.changePassword({
      currentPassword: "wrong-password",
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "invalid_current", message: null })
  })
})

describe("httpChangePasswordClient (BFF 계약 매핑)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("요청 본문을 snake_case로 직렬화해 POST /api/me/change-password를 호출한다", async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) })
    await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/change-password",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ current_password: "OldPassw0rd", new_password: NEW_PASSWORD })
  })

  it("200 → succeeded", async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "succeeded" })
  })

  it("401 → unauthenticated", async () => {
    fetchMock.mockResolvedValue({ status: 401, json: async () => ({}) })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "unauthenticated" })
  })

  it("403 INVALID_CREDENTIALS → invalid_current, 서버 message 보존", async () => {
    fetchMock.mockResolvedValue({
      status: 403,
      json: async () => ({
        detail: { code: "INVALID_CREDENTIALS", message: "현재 비밀번호가 일치하지 않습니다" },
      }),
    })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "wrong",
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "invalid_current", message: "현재 비밀번호가 일치하지 않습니다" })
  })

  it("409 NO_LOCAL_PASSWORD → no_local_password", async () => {
    fetchMock.mockResolvedValue({
      status: 409,
      json: async () => ({
        detail: { code: "NO_LOCAL_PASSWORD", message: "로컬 비밀번호 계정이 아닙니다" },
      }),
    })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(res).toEqual({ outcome: "no_local_password", message: "로컬 비밀번호 계정이 아닙니다" })
  })

  it("422 PASSWORD_POLICY → policy_violation, 서버 message 보존", async () => {
    fetchMock.mockResolvedValue({
      status: 422,
      json: async () => ({
        detail: { code: "PASSWORD_POLICY", message: "비밀번호는 최소 8자, 영문+숫자를 포함해야 합니다" },
      }),
    })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: "short",
    })
    expect(res).toEqual({
      outcome: "policy_violation",
      message: "비밀번호는 최소 8자, 영문+숫자를 포함해야 합니다",
    })
  })

  it("422 SAME_PASSWORD → same_password", async () => {
    fetchMock.mockResolvedValue({
      status: 422,
      json: async () => ({ detail: { code: "SAME_PASSWORD", message: "기존 비밀번호와 같아요" } }),
    })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: "OldPassw0rd",
    })
    expect(res).toEqual({ outcome: "same_password", message: "기존 비밀번호와 같아요" })
  })

  it("계약 밖 상태코드는 error 폴백", async () => {
    fetchMock.mockResolvedValue({ status: 500, json: async () => ({}) })
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(res.outcome).toBe("error")
  })

  it("네트워크 오류도 error 폴백(서버가 받았는지 알 수 없으므로 성공으로 넘기지 않는다)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const res = await httpChangePasswordClient.changePassword({
      currentPassword: "OldPassw0rd",
      newPassword: NEW_PASSWORD,
    })
    expect(res.outcome).toBe("error")
  })
})
