import { render, screen } from "@/lib/test/render-with-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExhibitorProfileHub } from "./exhibitor-profile-hub"

// mock 경로(orgEventRoleId 없음)는 lib/bm/mock-exhibitor-client.test.ts·apply-form.test.tsx가 이미
// 다룬다. 이 파일은 실 세션 경로(orgEventRoleId 있음) — FastAPI(BFF 경유) 조회로 배선되고, 실패는
// 데모 폴백 없이 에러 UI로 정직하게 떨어진다(silent 데모 폴백 제거 원칙).
describe("ExhibitorProfileHub — 실 세션(orgEventRoleId)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("BFF(/api/bm/exhibitor/{id})를 호출하고, 미완성이어도 데모로 바꾸지 않고 실 프로필을 그대로 보여준다", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          org_event_role_id: "role-1",
          application_status: "registered",
          organization_name_ko: "실 참가사",
        }),
    })
    vi.stubGlobal("fetch", fetchSpy)

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)

    expect(await screen.findByText("실 참가사")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledWith("/api/bm/exhibitor/role-1", undefined)
    // 데모 fallback 이메일은 나오지 않는다(실 세션은 데모로 바꿔치기하지 않는다).
    expect(screen.queryByText("manager@hanwhasystems.com")).not.toBeInTheDocument()
  })

  it("조회 실패 시 데모로 폴백하지 않고 에러 UI를 보여준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("no session") }))

    render(<ExhibitorProfileHub profileKey="exh-1" orgEventRoleId="role-1" />)

    expect(await screen.findByText("프로필을 불러오지 못했어요")).toBeInTheDocument()
    expect(screen.queryByText("manager@hanwhasystems.com")).not.toBeInTheDocument()
  })
})
