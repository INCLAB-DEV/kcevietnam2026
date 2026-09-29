import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/lib/test/render-with-intl"
import { OPERATOR_FORBIDDEN_DIGEST } from "@/lib/auth/operator-errors"
import { resolveAdminAccess } from "@/lib/admin/guard"
import type { AdminEvent } from "@/lib/admin/types"

// 관리자 콘솔의 거버넌스 화면을 서브어드민(sub)이 URL로 직접 열었을 때(2026-09-17). 예전엔 master 전용
// API(운영자 목록·배정 그리드)가 403 → 페이지가 크롬째 무너졌다. 이제 API를 부르지 않고 콘솔 틀 안에서
// 권한 안내를 그린다. 크롬(사이드바)은 app/admin/layout.tsx 소관이라 여기선 AdminShell을 틀로만 목업한다.

const EVENT: AdminEvent = {
  id: "evt-1",
  name: "2026 K-콘텐츠 엑스포",
  venue_name: "",
  exhibition_start: "2026-10-20",
  exhibition_end: "2026-10-22",
  application_start: "",
  application_end: "",
  timezone: "Asia/Seoul",
}

const adminContext = vi.hoisted(() => ({ level: "sub" as "sub" | "master" }))

vi.mock("@/components/admin/admin-shell", () => ({
  resolveAdminContext: async () => ({
    ok: true,
    events: [EVENT],
    ctx: {
      access: resolveAdminAccess({ role: "organizer", permissionLevel: adminContext.level }),
      event: EVENT,
      actorName: "운영자",
      user: { name: "운영자", affiliation: "", email: "" },
    },
  }),
  AdminShell: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}))

const adminServer = vi.hoisted(() => ({ getOrganizers: vi.fn(async () => []) }))
vi.mock("@/lib/admin/server", () => ({ adminServerClient: adminServer }))

const api = vi.hoisted(() => ({ getAssignmentSchedule: vi.fn() }))
vi.mock("@/lib/api-client/server", () => ({ serverApiClient: api }))

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin",
}))
vi.mock("@/components/admin/organizers-console", () => ({
  OrganizersConsole: () => <div data-testid="organizers-console" />,
}))
vi.mock("@/components/organizer/assignment-hub", () => ({
  AssignmentHub: () => <div data-testid="assignment-hub" />,
}))

beforeEach(() => {
  adminContext.level = "sub"
  adminServer.getOrganizers.mockClear()
  api.getAssignmentSchedule.mockReset()
})

describe("/admin/organizers — 운영자 관리는 master 전용", () => {
  it("서브어드민은 목록 API를 부르지 않고 권한 안내를 본다", async () => {
    const { default: OrganizersPage } = await import("./organizers/page")

    render(await OrganizersPage())

    expect(screen.getByText("운영자 관리는 슈퍼어드민 전용입니다")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "대시보드로" })).toHaveAttribute("href", "/admin")
    expect(adminServer.getOrganizers).not.toHaveBeenCalled()
    expect(screen.queryByTestId("organizers-console")).not.toBeInTheDocument()
  })

  it("슈퍼어드민은 기존 운영자 콘솔을 본다", async () => {
    adminContext.level = "master"
    const { default: OrganizersPage } = await import("./organizers/page")

    render(await OrganizersPage())

    expect(adminServer.getOrganizers).toHaveBeenCalledWith("evt-1")
    expect(screen.getByTestId("organizers-console")).toBeInTheDocument()
  })
})

describe("/admin/forced-matching — 미팅 배정은 master 전용", () => {
  it("서브어드민은 배정 그리드를 부르지 않고 권한 안내를 본다", async () => {
    const { default: ForcedMatchingPage } = await import("./forced-matching/page")

    render(await ForcedMatchingPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByText("미팅 배정은 슈퍼어드민 전용입니다")).toBeInTheDocument()
    expect(api.getAssignmentSchedule).not.toHaveBeenCalled()
  })

  it("슈퍼어드민은 배정 허브를 본다", async () => {
    adminContext.level = "master"
    api.getAssignmentSchedule.mockResolvedValue({})
    const { default: ForcedMatchingPage } = await import("./forced-matching/page")

    render(await ForcedMatchingPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByTestId("assignment-hub")).toBeInTheDocument()
  })
})

describe("app/admin/error.tsx — 콘솔 안의 안전망", () => {
  it("403(digest)은 권한 안내로, 대시보드로 가는 길을 준다", async () => {
    const { default: AdminError } = await import("./error")
    vi.spyOn(console, "error").mockImplementation(() => {})

    render(
      <AdminError
        error={Object.assign(new Error("admin read failed: GET /events/x/organizers (403)"), { digest: OPERATOR_FORBIDDEN_DIGEST })}
        unstable_retry={vi.fn()}
      />,
    )

    expect(screen.getByText("이 화면을 볼 권한이 없습니다")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "대시보드로" })).toHaveAttribute("href", "/admin")
    expect(screen.queryByText(/admin read failed/)).not.toBeInTheDocument()
  })
})
