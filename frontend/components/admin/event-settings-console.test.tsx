import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EventSettingsConsole } from "./event-settings-console"
import type { AdminEvent, AdminEventSettings, AdminOrganization } from "@/lib/admin/types"

// H7 — 설정 저장이 완전 무반응(네트워크 요청 0건)이던 버그의 회귀 테스트.
// 원인: save()가 항상 validateEvent(전시기간 포함 전체 행사 검증)까지 같이 돌렸는데, 이 화면엔
// 전시기간(exhibition_start/end) 입력칸이 아예 없다 — 백엔드가 그 필드를 비워 보내면(dateOrEmpty
// → "") 신청기간·정책 등 이 화면이 다루는 어떤 값만 바꿔도 영원히 막혔다. 이제는 바뀐 리소스만
// 검증·전송한다(설정 전용 변경은 event 검증과 무관하게 나가야 한다).

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderConsole(props: ComponentProps<typeof EventSettingsConsole>) {
  return render(<EventSettingsConsole {...props} />)
}

const settings: AdminEventSettings = {
  event_id: "evt-1",
  slot_minutes: 30,
  enabled_venue_types: ["booth", "zone_table"],
  allow_same_role_discovery: false,
  operating_start: "09:00",
  operating_end: "18:00",
  lunch_start: "12:00",
  lunch_end: "13:00",
  min_guaranteed_slots: 10,
  slot_gap_minutes: 0,
  max_meeting_minutes: 90,
}

// 실 데이터 재현: 전시기간이 아직 확정되지 않은 행사(백엔드가 null → dateOrEmpty로 "" 매핑).
// 이 화면은 exhibition_start/end를 편집할 수 없으므로 이 값들은 영원히 ""로 남을 수 있다.
const event: AdminEvent = {
  id: "evt-1",
  name: "2026 베트남 K-콘텐츠 엑스포",
  venue_name: "",
  exhibition_start: "",
  exhibition_end: "",
  application_start: "2026-08-26",
  application_end: "2026-09-11",
  timezone: "Asia/Ho_Chi_Minh",
}

const organizations: AdminOrganization[] = []

function stubHttp() {
  vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
  const fetchSpy = vi.fn(
    async (_path: string, _init?: RequestInit) => new Response(null, { status: 200 }),
  )
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

describe("EventSettingsConsole — 저장 버튼 → fetch 배선(H7)", () => {
  it("전시기간이 비어 있어도 미팅 시간 단위만 바꾸면 settings PATCH가 나간다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /20분/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/settings")
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ slot_minutes: 20 })
    // 손대지 않은 신청기간(행사 리소스)은 검증도, 전송도 되지 않는다.
    expect(screen.queryByText(/전시 시작일/)).not.toBeInTheDocument()
  })

  it("동일 역할 상호 열람만 켜도 settings PATCH가 나간다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("checkbox", { name: /동일 역할 상호 열람 허용/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [path] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/settings")
  })

  it("신청기간만 바꾸면 event PATCH가 나가고 settings PATCH는 나가지 않는다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings, organizations, readOnly: false })

    // type="date" 입력은 userEvent.type으로 문자열을 그대로 못 넣는다(세그먼트 입력) — fireEvent로
    // 값을 직접 갈아끼운다.
    fireEvent.change(screen.getByLabelText("신청 시작"), { target: { value: "2026-08-01" } })
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1")
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      application_start: "2026-08-01",
    })
  })

  it("변경이 없으면 저장 버튼이 비활성화라 요청도 없다", () => {
    stubHttp()
    renderConsole({ event, settings, organizations, readOnly: false })
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled()
  })
})
