import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"

// /organizer 콘솔의 "권한 조회 실패" 배너(2026-09-21, lib/organizer/console-access 참고). 크롬
// (AppShellForRequest)은 무겁게 mock — 여기선 레이아웃 자신의 배너 배선만 검증한다
// (app/admin/sub-operator-admin.test.tsx와 같은 방식으로 셸을 얇게 목업).

const access = vi.hoisted(() => ({
  value: {
    realSession: true,
    permissionLevel: "sub" as const,
    permissionUnknown: false,
    session: { role: "organizer", permissionLevel: "sub", user: { name: "", affiliation: "", email: "", phone: "" }, tradeOffice: "" },
  },
}))

vi.mock("@/lib/organizer/console-access", () => ({
  resolveOrganizerConsoleAccess: async () => access.value,
}))
vi.mock("@/components/layout/app-shell", () => ({
  AppShellForRequest: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe("OrganizerLayout — 권한 조회 실패 배너", () => {
  it("permissionUnknown이면 배너를 보여준다(최소 권한은 유지)", async () => {
    access.value = { ...access.value, permissionUnknown: true }
    const { default: OrganizerLayout } = await import("./layout")

    render(await OrganizerLayout({ children: <div data-testid="body" /> }))

    expect(screen.getByText("권한 정보를 확인하지 못했습니다")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("확인된 등급(sub)이면 배너가 없다", async () => {
    access.value = { ...access.value, permissionUnknown: false }
    const { default: OrganizerLayout } = await import("./layout")

    render(await OrganizerLayout({ children: <div data-testid="body" /> }))

    expect(screen.queryByText("권한 정보를 확인하지 못했습니다")).not.toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })
})
