import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
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
  participant_menu: "meetings_only",
  participant_email_enabled: false, // 기본값(꺼짐)
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

// 참가자 메뉴(F-NV-001 D15) — 참가사·바이어 화면의 왼쪽 메뉴를 미팅만 낼지 전부 낼지 고르는 항목.
// 선택지는 "미팅만"(기본) / "전체 메뉴" 순서이고, 다른 정책과 같은 "설정 저장"으로 settings PATCH에 실린다.
describe("EventSettingsConsole — 참가자 메뉴", () => {
  function menuRadios() {
    const group = screen.getByRole("radiogroup", { name: "참가자 메뉴" })
    return Array.from(group.querySelectorAll('[role="radio"]')) as HTMLElement[]
  }

  it("제목·설명과 두 선택지를 '미팅만'(기본) → '전체 메뉴' 순서로 보여준다", () => {
    renderConsole({ event, settings, organizations, readOnly: false })

    expect(screen.getByText("참가자 메뉴", { selector: '[data-slot="card-title"]' })).toBeInTheDocument()
    expect(
      screen.getByText(/‘미팅만’을 고르면 참가사·바이어 화면의 왼쪽 메뉴에 ‘미팅’만 보입니다/),
    ).toBeInTheDocument()
    expect(screen.getByText(/메뉴에서 숨겨지고 기능은 그대로 유지됩니다/)).toBeInTheDocument()

    const [first, second] = menuRadios()
    expect(menuRadios()).toHaveLength(2)
    expect(first).toHaveTextContent("미팅만")
    expect(first).toHaveTextContent("기본")
    expect(first).toHaveTextContent("왼쪽 메뉴: 미팅")
    expect(second).toHaveTextContent("전체 메뉴")
    expect(second).not.toHaveTextContent("기본")
    expect(second).toHaveTextContent("왼쪽 메뉴: 대시보드 · 기업 탐색 · 미팅 · 알림 · 프로필")
  })

  it("저장된 값이 선택돼 보인다", () => {
    renderConsole({ event, settings, organizations, readOnly: false })
    expect(screen.getByRole("radio", { name: /미팅만/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: /전체 메뉴/ })).toHaveAttribute("aria-checked", "false")
  })

  it("'전체 메뉴'로 바꿔 저장하면 settings PATCH에 participant_menu=full이 실린다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /전체 메뉴/ }))
    expect(screen.getByRole("radio", { name: /전체 메뉴/ })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/settings")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ participant_menu: "full" })
    // 저장 뒤에는 고른 값이 그대로 남고, 더 저장할 변경이 없다.
    expect(screen.getByRole("radio", { name: /전체 메뉴/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled()
  })

  it("'전체 메뉴'인 행사를 '미팅만'으로 되돌려 저장할 수 있다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({
      event,
      settings: { ...settings, participant_menu: "full" },
      organizations,
      readOnly: false,
    })
    expect(screen.getByRole("radio", { name: /전체 메뉴/ })).toHaveAttribute("aria-checked", "true")

    await userEvent.click(screen.getByRole("radio", { name: /미팅만/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [, init] = fetchSpy.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      participant_menu: "meetings_only",
    })
  })

  it("다른 정책만 바꿔 저장하면 메뉴 키는 본문에 없다 — 다른 마스터가 바꾼 메뉴를 덮어쓰지 않는다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({
      event,
      settings: { ...settings, participant_menu: "full" },
      organizations,
      readOnly: false,
    })

    await userEvent.click(screen.getByRole("radio", { name: /20분/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [, init] = fetchSpy.mock.calls[0]
    // 바뀐 필드만 — 백엔드는 PATCH를 exclude_unset으로 받으므로 보내지 않은 키는 서버 값 그대로다.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ slot_minutes: 20 })
  })

  it("읽기 전용(서브어드민)에서는 고를 수 없고 저장 버튼도 없다", () => {
    renderConsole({ event, settings, organizations, readOnly: true })

    for (const radio of menuRadios()) expect(radio).toBeDisabled()
    expect(screen.queryByRole("button", { name: "설정 저장" })).not.toBeInTheDocument()
  })
})

// 참가자 알림 메일(nt004mail0001) — 이 행사의 참가사·바이어에게 메일(자동 알림·러브콜)을 보낼지. "보내지 않음"(기본) / "보냄".
// 다른 정책과 같은 "설정 저장"으로 settings PATCH에 실리고, 저장된 상태는 화면 맨 위 한 줄(상태 표시)로 보인다.
// 기본이 꺼짐이라 경고(alert)가 아니라 상태(status)다 — 메일이 실제로 나가는 켜짐 쪽을 강조한다.
describe("EventSettingsConsole — 참가자 알림 메일", () => {
  function emailRadios() {
    const group = screen.getByRole("radiogroup", { name: "참가사·바이어 알림 메일" })
    return Array.from(group.querySelectorAll('[role="radio"]')) as HTMLElement[]
  }
  function emailStatus() {
    return screen.getByRole("status", { name: "참가사·바이어 알림 메일 상태" })
  }
  const off: AdminEventSettings = { ...settings, participant_email_enabled: false }
  const on: AdminEventSettings = { ...settings, participant_email_enabled: true }

  it("제목·설명·범위 안내와 두 선택지('보내지 않음'(기본) → '보냄')를 보여준다", () => {
    renderConsole({ event, settings: off, organizations, readOnly: false })

    expect(
      screen.getByText("참가사·바이어 알림 메일", { selector: '[data-slot="card-title"]' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/기본은 ‘보내지 않음’입니다/)).toBeInTheDocument()
    expect(
      screen.getByText(/신청 승인·미팅 요청·확정·취소·리마인더 같은 자동 알림을 참가사·바이어 이메일로도/),
    ).toBeInTheDocument()
    expect(screen.getByText(/다시 켜도 꺼져 있던 동안의 메일은 보내지 않습니다/)).toBeInTheDocument()
    // 범위: 꺼지면 러브콜 메일도 막히고(2026-10-16 발주사 요구 "어떠한 메일도"), 예외는 회원가입 인증 코드뿐이다.
    expect(screen.getByText(/회의록 화면의 러브콜 메일도 보낼 수 없습니다/)).toBeInTheDocument()
    expect(
      screen.getByText(/자동 알림 메일과 러브콜 메일이 이 설정을 따릅니다\. 회원가입 인증 코드만 이 설정과 관계없이 발송됩니다/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/러브콜 메일은 이 설정과 관계없이/)).not.toBeInTheDocument()

    const [first, second] = emailRadios()
    expect(emailRadios()).toHaveLength(2)
    expect(first).toHaveTextContent("보내지 않음")
    expect(first).toHaveTextContent("기본")
    expect(first).toHaveAttribute("aria-checked", "true")
    expect(second).toHaveTextContent("보냄")
    expect(second).not.toHaveTextContent("기본")
    expect(second).toHaveAttribute("aria-checked", "false")
  })

  it("기본(꺼짐) 상태는 경고 없이 맨 위 상태 표시로 '보내지 않음'을 보인다", () => {
    renderConsole({ event, settings: off, organizations, readOnly: true }) // 서브어드민에게도 보인다

    expect(emailStatus()).toHaveTextContent("보내지 않음")
    expect(emailStatus()).toHaveTextContent("참가사·바이어에게 메일이 나가지 않습니다 — 자동 알림은 사이트 안 알림으로만 남고, 러브콜 메일은 보낼 수 없습니다.")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    for (const radio of emailRadios()) expect(radio).toBeDisabled()
  })

  it("켜진 행사는 맨 위 상태 표시로 '보냄'(메일이 나감)을 보인다", () => {
    renderConsole({ event, settings: on, organizations, readOnly: false })

    expect(emailStatus()).toHaveTextContent("보냄")
    expect(emailStatus()).toHaveTextContent("자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다.")
    expect(screen.getByRole("radio", { name: /^보냄/ })).toHaveAttribute("aria-checked", "true")
  })

  it("'보냄'으로 켜 저장하면 settings PATCH에 participant_email_enabled=true가 실리고 상태가 바뀐다", async () => {
    const fetchSpy = stubHttp()
    const toastSpy = vi.spyOn(toast, "error").mockImplementation(() => "")
    renderConsole({ event, settings: off, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /^보냄/ }))
    // 저장 전에는 상태 표시가 그대로다(저장된 상태 기준).
    expect(emailStatus()).toHaveTextContent("보내지 않음")
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [path, init] = fetchSpy.mock.calls[0]
    expect(path).toBe("/api/admin/events/evt-1/settings")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      participant_email_enabled: true,
    })
    await waitFor(() => expect(emailStatus()).toHaveTextContent("자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다."))
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled()
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it("켜진 행사를 '보내지 않음'으로 다시 꺼 저장할 수 있다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings: on, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /보내지 않음/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [, init] = fetchSpy.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      participant_email_enabled: false,
    })
    await waitFor(() => expect(emailStatus()).toHaveTextContent("보내지 않음"))
  })

  it("다른 정책만 바꿔 저장하면 메일 키는 본문에 없다 — 켜 둔 값을 이 탭이 다시 쓰지 않는다", async () => {
    const fetchSpy = stubHttp()
    renderConsole({ event, settings: on, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /20분/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const [, init] = fetchSpy.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ slot_minutes: 20 })
  })

  it("오래 열어 둔 탭 — 다른 마스터가 켠 메일을 되돌리지 않고, 저장 응답(서버 값)으로 화면을 맞춘다", async () => {
    // 이 탭은 꺼짐일 때 열렸다. 그 사이 다른 마스터가 켰다 — 서버의 PATCH 응답이 그 사실을 싣고 온다.
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, init?: RequestInit) => {
      const patch = JSON.parse((init?.body as string) ?? "{}") as Partial<AdminEventSettings>
      return Response.json({ ...on, ...patch })
    })
    vi.stubGlobal("fetch", fetchSpy)
    renderConsole({ event, settings: off, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /20분/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toEqual({ slot_minutes: 20 })
    await waitFor(() =>
      expect(emailStatus()).toHaveTextContent("자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다."),
    )
    expect(screen.getByRole("radio", { name: /^보냄/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: /20분/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled() // 더 저장할 변경이 없다
  })

  it("성공 알림·상태 표시는 서버 응답(2xx) 뒤에만 바뀌고, 그동안 저장 버튼은 '저장 중'으로 잠긴다", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    let respond: (res: Response) => void = () => {}
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    )
    vi.stubGlobal("fetch", fetchSpy)
    const toastSpy = vi.spyOn(toast, "error").mockImplementation(() => "")
    renderConsole({ event, settings: off, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /^보냄/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    // 응답 전 — 아직 아무것도 바뀌지 않았다. 버튼은 잠겨 두 번째 저장이 나가지 않는다.
    const busy = await screen.findByRole("button", { name: "저장 중…" })
    expect(busy).toBeDisabled()
    expect(emailStatus()).toHaveTextContent("보내지 않음")
    fireEvent.click(busy)
    expect(fetchSpy).toHaveBeenCalledOnce()

    respond(Response.json({ ...off, participant_email_enabled: true }))

    await waitFor(() =>
      expect(emailStatus()).toHaveTextContent("자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다."),
    )
    expect(await screen.findByRole("button", { name: "설정 저장" })).toBeDisabled()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(toastSpy).not.toHaveBeenCalled()
  })

  // 저장 실패 뒤의 서버 — PATCH는 실패시키고(거절 또는 네트워크 단절), GET은 서버의 지금 값을 준다.
  function stubFailingSave(server: AdminEventSettings, failure: "reject" | "network") {
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    const fetchSpy = vi.fn(async (_path: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return Response.json(server)
      if (failure === "network") throw new TypeError("Failed to fetch")
      return Response.json({ detail: "권한 없음" }, { status: 403 })
    })
    vi.stubGlobal("fetch", fetchSpy)
    return fetchSpy
  }

  it("저장이 거절되면 서버의 지금 값을 다시 읽어 맞추고, 고른 값은 남겨 다시 저장할 수 있게 둔다", async () => {
    // 그 사이 다른 마스터가 메뉴를 '전체 메뉴'로 바꿔 두었다(서버 값). 이 탭은 메일만 켜려다 거절됐다.
    const fetchSpy = stubFailingSave({ ...off, participant_menu: "full" }, "reject")
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    renderConsole({ event, settings: off, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /^보냄/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe("정책 저장에 실패했어요")
    expect(fetchSpy.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["PATCH", "GET"])
    // 서버에는 저장되지 않았다 — 메일이 나가는 것처럼 보이면 안 된다.
    expect(emailStatus()).toHaveTextContent("보내지 않음")
    // 서버 값(손대지 않은 메뉴)은 화면에 반영되고, 고른 값(메일 켜기)은 남아 "저장하지 않은 변경"으로 보인다.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /전체 메뉴/ })).toHaveAttribute("aria-checked", "true"),
    )
    expect(screen.getByRole("radio", { name: /^보냄/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("저장하지 않은 변경이 있습니다")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled()
  })

  it("네트워크가 끊겨 요청 자체가 실패해도 같은 방식으로 서버 값을 다시 읽는다", async () => {
    stubFailingSave(on, "network")
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    renderConsole({ event, settings: on, organizations, readOnly: false })

    await userEvent.click(screen.getByRole("radio", { name: /보내지 않음/ }))
    await userEvent.click(screen.getByRole("button", { name: "설정 저장" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // 꺼진 것처럼 보이지 않는다 — 서버 상태(켜짐)를 그대로 보인다.
    expect(emailStatus()).toHaveTextContent("자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다.")
    expect(screen.getByRole("radio", { name: /보내지 않음/ })).toHaveAttribute("aria-checked", "true")
    expect(await screen.findByRole("button", { name: "설정 저장" })).toBeEnabled()
  })
})

// 미팅 불가 시간 격자 — 이 화면의 목록은 페이지를 열 때 읽은 값이고, 칸을 누르면 그 기업의 **전체** 목록을
// 보낸다. 그 사이 다른 곳(신청서 편집 패널·대리작성·다른 운영자)에서 바뀐 것을 지우지 않게, 실연동에서는
// 보내기 직전에 그 기업의 지금 목록을 다시 읽어 견준다.
describe("EventSettingsConsole — 미팅 불가 시간 격자", () => {
  const datedEvent: AdminEvent = {
    ...event,
    exhibition_start: "2026-10-20",
    exhibition_end: "2026-10-21",
  }
  const exhibitor = {
    id: "org-1",
    event_id: "evt-1",
    role: "exhibitor",
    name_ko: "픽셀아츠 스튜디오",
    name_en: null,
    application_status: "approved",
    unavailable_slots: ["2026-10-20T09:00"],
  } as unknown as AdminOrganization

  // 서버의 지금 불가 시간(바꿀 수 있다)과 나간 저장 기록.
  function stubSlotServer(initial: string[], options: { failPatch?: boolean } = {}) {
    let stored = [...initial]
    const writes: string[][] = []
    vi.stubEnv("NEXT_PUBLIC_AUTH_CLIENT", "http")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        if (method === "GET" && url === "/api/admin/events/evt-1/organizations/org-1") {
          return Response.json({
            id: "org-1",
            org_event_role_id: "role-1",
            event_id: "evt-1",
            is_exhibitor: true,
            is_buyer: false,
            application_status: "approved",
            buyer_profile: null,
            exhibitor_profile: {
              org_event_role_id: "role-1",
              application_status: "approved",
              unavailable_meeting_slots: stored,
            },
          })
        }
        if (method === "PATCH" && url === "/api/admin/events/evt-1/organizations/org-1/unavailable-slots") {
          if (options.failPatch) return Response.json({ detail: "저장 실패" }, { status: 500 })
          stored = (JSON.parse(init?.body as string) as { slots: string[] }).slots
          writes.push(stored)
          return Response.json({
            org_event_role_id: "role-1",
            application_status: "approved",
            unavailable_meeting_slots: stored,
          })
        }
        return new Response(null, { status: 200 })
      }),
    )
    return {
      writes,
      stored: () => stored,
      changeElsewhere: (next: string[]) => {
        stored = next
      },
    }
  }

  function renderGrid() {
    return renderConsole({
      event: datedEvent,
      settings,
      organizations: [exhibitor],
      readOnly: false,
    })
  }

  it("칸을 누르면 서버의 지금 목록을 확인한 뒤 전체 목록을 보낸다", async () => {
    const server = stubSlotServer(["2026-10-20T09:00"])
    renderGrid()
    expect(screen.getByText("불가 1칸")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(server.writes).toHaveLength(1))
    expect(server.writes[0]).toEqual(["2026-10-20T09:00", "2026-10-21T10:00"])
    expect(await screen.findByText("불가 2칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 해제/ })).toBeInTheDocument()
  })

  it("다른 곳에서 불가 시간이 바뀌었으면 누른 칸을 저장하지 않고 격자를 최신으로 바꾼다", async () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    const server = stubSlotServer(["2026-10-20T09:00"])
    renderGrid()

    // 이 화면을 열어 둔 사이 다른 곳(신청서 편집 패널 등)에서 두 칸이 더 지정됐다.
    server.changeElsewhere(["2026-10-20T09:00", "2026-10-20T14:00", "2026-10-21T15:00"])
    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요")
    // 보내지 않았다 — 보냈다면 "전체 = 두 칸"이 돼 다른 곳에서 지정한 두 칸이 사라진다.
    expect(server.writes).toHaveLength(0)
    expect(server.stored()).toEqual(["2026-10-20T09:00", "2026-10-20T14:00", "2026-10-21T15:00"])
    expect(await screen.findByText("불가 3칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/20 .* 14:00 불가 해제/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ })).toBeInTheDocument()

    // 최신 격자에서 다시 누르면 저장된다(네 칸 전체).
    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ }))
    await waitFor(() => expect(server.writes).toHaveLength(1))
    expect(server.writes[0]).toEqual([
      "2026-10-20T09:00",
      "2026-10-20T14:00",
      "2026-10-21T10:00",
      "2026-10-21T15:00",
    ])
  })

  it("저장이 실패하면 방금 누른 칸을 되돌리고 알린다", async () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    const server = stubSlotServer(["2026-10-20T09:00"], { failPatch: true })
    renderGrid()

    await userEvent.click(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe("미팅 불가 시간 저장에 실패했어요")
    expect(await screen.findByText("불가 1칸")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /10\/21 .* 10:00 불가 지정/ })).toBeEnabled()
    expect(server.stored()).toEqual(["2026-10-20T09:00"])
  })
})
