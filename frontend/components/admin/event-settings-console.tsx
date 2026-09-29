"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { CircleAlert, Clock, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  countMisalignedSlots,
  EVENT_ERROR_MESSAGES,
  SETTINGS_ERROR_MESSAGES,
  toggleVenueType,
  validateApplicationPeriod,
  validateEventSettings,
} from "@/lib/admin/event-settings"
import {
  SLOT_MINUTES_OPTIONS,
  VENUE_TYPES,
  VENUE_TYPE_LABELS,
  type AdminEvent,
  type AdminEventSettings,
  type AdminOrganization,
  type SlotMinutes,
  type VenueType,
} from "@/lib/admin/types"
import { patchEvent, patchEventSettings, patchUnavailableSlots } from "@/lib/admin/admin-actions"
import { eventDateIds, formatEventDate } from "@/lib/admin/events"
import { slotId, slotTimes } from "@/lib/organizer/schedule"

// 행사 설정 — 이 행사에만 적용되는 운영 정책.
//  ① 미팅 시간 단위(10/20/30/60) — 라디오 카드            → PATCH /events/{id}/settings
//  ② 신청기간 시작·종료                                   → PATCH /events/{id}   (행사 리소스!)
//  ③ 정책 토글: 사용 가능한 미팅 장소 유형 / 동일 역할 상호 열람 → PATCH /events/{id}/settings
//  ④ 참가사별 미팅 불가 시간대 — 기업을 고르고 슬롯 그리드 토글  → PATCH .../unavailable-slots
//
// 한 화면이지만 저장은 리소스별로 갈라 나간다(백엔드 계약 그대로). 신청기간이 settings가 아니라
// event에 사는 게 헷갈리기 쉬워 아래 저장 함수에 주석으로 못박아 둔다.
//
// 슬롯 격자는 행사 전시 기간 × 하루 운영시간을 슬롯 길이로 끊어 만든다. 운영시간·점심 블록은
// 운영자 콘솔의 스케줄 기본값(lib/organizer/schedule)을 재사용한다 — 이 화면이 다루는 계약 필드는
// slot_minutes 하나이고, 나머지는 배정 엔진 쪽 설정이기 때문이다.

// H9 — 운영시간·점심·최소보장슬롯은 더 이상 FE 하드코딩(구 OPERATING_WINDOW: 10:00~18:10/45분,
// 문서 근거 없음 — timezone-analysis.md §2.3)이 아니라 백엔드 실계약(AdminEventSettings)에서 온다.
// null(점심 미설정)은 백엔드 _assignment_settings_out과 동일한 "00:00" 폴백(빈 구간, slotTimes가
// 아무 칸도 걸러내지 않는다).
function operatingWindow(settings: AdminEventSettings) {
  return {
    startTime: settings.operating_start,
    endTime: settings.operating_end,
    lunchStart: settings.lunch_start ?? "00:00",
    lunchEnd: settings.lunch_end ?? "00:00",
    minSlots: settings.min_guaranteed_slots,
    slotGapMinutes: settings.slot_gap_minutes,
    maxMeetingMinutes: settings.max_meeting_minutes,
  }
}

export function EventSettingsConsole({
  event: initialEvent,
  settings: initialSettings,
  organizations,
  readOnly,
}: {
  event: AdminEvent
  settings: AdminEventSettings
  organizations: AdminOrganization[]
  readOnly: boolean
}) {
  const [event, setEvent] = useState<AdminEvent>(initialEvent)
  const [settings, setSettings] = useState<AdminEventSettings>(initialSettings)
  const [draft, setDraft] = useState<AdminEventSettings>(initialSettings)
  // 신청기간은 행사 리소스 필드라 설정 draft와 분리해서 들고 있는다.
  const [period, setPeriod] = useState({
    application_start: initialEvent.application_start,
    application_end: initialEvent.application_end,
  })
  const [errors, setErrors] = useState<string[]>([])
  const [unavailable, setUnavailable] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(organizations.map((o) => [o.id, o.unavailable_slots])),
  )
  const [selectedOrgId, setSelectedOrgId] = useState<string>(organizations[0]?.id ?? "")

  const settingsDirty =
    draft.slot_minutes !== settings.slot_minutes ||
    draft.allow_same_role_discovery !== settings.allow_same_role_discovery ||
    draft.enabled_venue_types.join(",") !== settings.enabled_venue_types.join(",") ||
    draft.operating_start !== settings.operating_start ||
    draft.operating_end !== settings.operating_end ||
    (draft.lunch_start ?? "") !== (settings.lunch_start ?? "") ||
    (draft.lunch_end ?? "") !== (settings.lunch_end ?? "") ||
    draft.slot_gap_minutes !== settings.slot_gap_minutes ||
    draft.max_meeting_minutes !== settings.max_meeting_minutes
  const periodDirty =
    period.application_start !== event.application_start ||
    period.application_end !== event.application_end
  const dirty = settingsDirty || periodDirty

  // 슬롯 격자(길이·간격·운영시간·점심)를 바꾸면 기존 불가 시간대가 새 격자와 어긋날 수 있다 —
  // 저장 전에 알려준다. 실제 격자(draftTimes)와 직접 대조하므로 모듈로를 재발명하지 않는다(계약서
  // §3.10 — 자정 기준 모듈로는 앵커·stride가 있는 격자에서 정상 슬롯을 어긋남으로 오판했다).
  const draftTimes = useMemo(
    () => slotTimes({ ...operatingWindow(draft), slotMinutes: draft.slot_minutes }),
    [draft],
  )
  const misaligned = useMemo(() => {
    const gridChanged =
      draft.slot_minutes !== settings.slot_minutes ||
      draft.slot_gap_minutes !== settings.slot_gap_minutes ||
      draft.operating_start !== settings.operating_start ||
      draft.operating_end !== settings.operating_end ||
      (draft.lunch_start ?? "") !== (settings.lunch_start ?? "") ||
      (draft.lunch_end ?? "") !== (settings.lunch_end ?? "")
    if (!gridChanged) return 0
    return Object.values(unavailable).reduce(
      (sum, slots) => sum + countMisalignedSlots(slots, draftTimes),
      0,
    )
  }, [draft, settings, unavailable, draftTimes])

  const dateIds = useMemo(() => eventDateIds(event), [event])
  const times = useMemo(
    () => slotTimes({ ...operatingWindow(settings), slotMinutes: settings.slot_minutes }),
    [settings],
  )
  const selectedOrg = organizations.find((o) => o.id === selectedOrgId) ?? null
  const selectedSlots = new Set(unavailable[selectedOrgId] ?? [])

  function save() {
    // 두 리소스를 각자의 검증기로 따로 검사한다(엔드포인트가 둘이므로) — 그리고 **바뀐 리소스만**
    // 검사한다. 예전엔 손대지 않은 리소스까지 항상 같이 검증해서, 신청기간을 아직 안 만진 상태에서
    // 미팅 시간 단위만 바꿔도 event.exhibition_start/end(이 화면엔 입력칸조차 없다) 검증에 걸려
    // 요청이 아예 안 나갔다(H7). 신청기간 자체를 고칠 때도 validateEvent(행사 등록 화면 전체
    // 검증기)가 아니라 이 화면이 실제로 다루는 신청기간만 보는 validateApplicationPeriod를 쓴다 —
    // 안 그러면 전시기간이 아직 미확정(빈 문자열)인 행사는 신청기간조차 영원히 저장할 수 없다.
    const settingsCheck = settingsDirty ? validateEventSettings(settings, draft) : null
    const eventCheck = periodDirty ? validateApplicationPeriod(period) : null

    const messages = [
      ...(settingsCheck && !settingsCheck.valid
        ? settingsCheck.errors.map((c) => SETTINGS_ERROR_MESSAGES[c])
        : []),
      ...(eventCheck && !eventCheck.valid ? eventCheck.errors.map((c) => EVENT_ERROR_MESSAGES[c]) : []),
    ]
    if (messages.length > 0) {
      setErrors(messages)
      return
    }

    setErrors([])
    const savedParts: string[] = []

    if (settingsCheck?.valid) {
      setSettings(settingsCheck.settings)
      setDraft(settingsCheck.settings)
      savedParts.push(`미팅 단위 ${settingsCheck.settings.slot_minutes}분`)
      void patchEventSettings(event.id, {
        slot_minutes: settingsCheck.settings.slot_minutes,
        enabled_venue_types: settingsCheck.settings.enabled_venue_types,
        allow_same_role_discovery: settingsCheck.settings.allow_same_role_discovery,
        operating_start: settingsCheck.settings.operating_start,
        operating_end: settingsCheck.settings.operating_end,
        lunch_start: settingsCheck.settings.lunch_start,
        lunch_end: settingsCheck.settings.lunch_end,
        slot_gap_minutes: settingsCheck.settings.slot_gap_minutes,
        max_meeting_minutes: settingsCheck.settings.max_meeting_minutes,
      }).then((r) => {
        if (!r.success) toast.error("정책 저장에 실패했어요")
      })
    }
    // ⚠ 신청기간은 settings가 아니라 **행사** 리소스로 나간다(백엔드 확정 계약).
    if (eventCheck?.valid) {
      setEvent((prev) => ({ ...prev, ...period }))
      savedParts.push(`신청기간 ${period.application_start} ~ ${period.application_end}`)
      void patchEvent(event.id, period).then((r) => {
        if (!r.success) toast.error("신청기간 저장에 실패했어요")
      })
    }

    if (savedParts.length > 0) {
      toast("행사 설정을 저장했어요", { description: savedParts.join(" · ") })
    }
  }

  function toggleSlot(slot: string) {
    if (readOnly || !selectedOrg) return
    const current = unavailable[selectedOrgId] ?? []
    const next = current.includes(slot)
      ? current.filter((s) => s !== slot)
      : [...current, slot].sort()
    setUnavailable((prev) => ({ ...prev, [selectedOrgId]: next }))
    void patchUnavailableSlots(event.id, selectedOrgId, next)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── 미팅 시간 단위 ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>미팅 시간 단위</CardTitle>
          <CardDescription>
            한 미팅 슬롯의 길이입니다. 배정 그리드의 칸 수와 하루 가능 미팅 수가 여기서 파생됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="radiogroup" aria-label="미팅 시간 단위">
            {SLOT_MINUTES_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={draft.slot_minutes === m}
                disabled={readOnly}
                onClick={() => setDraft((p) => ({ ...p, slot_minutes: m as SlotMinutes }))}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  draft.slot_minutes === m
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <span className="flex items-center gap-1.5 text-lg font-semibold tabular-nums">
                  <Clock className="size-4 text-muted-foreground" />
                  {m}분
                </span>
                <span className="text-xs text-muted-foreground">
                  하루 약 {slotTimes({ ...operatingWindow(draft), slotMinutes: m }).length}슬롯
                </span>
              </button>
            ))}
          </div>
          {misaligned > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-status-pending">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              슬롯 격자를 바꾸면 기존에 지정된 불가 시간대 {misaligned}칸이 새 격자와 어긋납니다.
              저장 후 아래에서 다시 확인해 주세요.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 운영시간 · 점심 · 슬롯 간격(텀) ─────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>운영시간 · 점심 · 슬롯 간격</CardTitle>
          <CardDescription>
            하루 미팅 격자를 만드는 나머지 축입니다. 예) 40분 상담 + 5분 텀이면 슬롯 간격을 5로
            설정하세요 — 상담 사이 이동 시간이 확보됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-op-start">운영 시작</Label>
              <Input
                id="set-op-start"
                type="time"
                value={draft.operating_start}
                disabled={readOnly}
                onChange={(e) => setDraft((p) => ({ ...p, operating_start: e.target.value }))}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-op-end">운영 종료</Label>
              <Input
                id="set-op-end"
                type="time"
                value={draft.operating_end}
                disabled={readOnly}
                onChange={(e) => setDraft((p) => ({ ...p, operating_end: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-lunch-start">점심 시작</Label>
              <Input
                id="set-lunch-start"
                type="time"
                value={draft.lunch_start ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, lunch_start: e.target.value || null }))
                }
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-lunch-end">점심 종료</Label>
              <Input
                id="set-lunch-end"
                type="time"
                value={draft.lunch_end ?? ""}
                disabled={readOnly}
                onChange={(e) => setDraft((p) => ({ ...p, lunch_end: e.target.value || null }))}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-slot-gap">슬롯 간격(텀, 분)</Label>
              <Input
                id="set-slot-gap"
                type="number"
                min={0}
                max={30}
                value={draft.slot_gap_minutes}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, slot_gap_minutes: Number(e.target.value) }))
                }
              />
              <span className="text-xs text-muted-foreground">
                슬롯 사이 이동 시간입니다(0~30분). 이 시간은 어떤 미팅도 점유하지 않습니다.
              </span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="set-max-meeting">미팅 최대 길이(분)</Label>
              <Input
                id="set-max-meeting"
                type="number"
                min={10}
                max={480}
                value={draft.max_meeting_minutes}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, max_meeting_minutes: Number(e.target.value) }))
                }
              />
              <span className="text-xs text-muted-foreground">
                연속 예약(멀티슬롯)으로 한 미팅이 늘어날 수 있는 최대 길이입니다(10~480분).
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 신청기간 (행사 리소스) ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>비즈매칭 신청기간</CardTitle>
          <CardDescription>
            참가사·바이어가 신청서를 작성할 수 있는 기간입니다. 종료 후 승인된 기업에게 본 서비스가
            열립니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="set-app-start">신청 시작</Label>
            <Input
              id="set-app-start"
              type="date"
              value={period.application_start}
              disabled={readOnly}
              onChange={(e) => setPeriod((p) => ({ ...p, application_start: e.target.value }))}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="set-app-end">신청 종료</Label>
            <Input
              id="set-app-end"
              type="date"
              value={period.application_end}
              disabled={readOnly}
              onChange={(e) => setPeriod((p) => ({ ...p, application_end: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 정책 토글 ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>운영 정책</CardTitle>
          <CardDescription>행사마다 다른 운영 형태를 여기서 켜고 끕니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">사용 가능한 미팅 장소 유형</span>
            <p className="text-xs text-muted-foreground">
              이 행사에서 미팅을 열 수 있는 장소입니다. 최소 1개는 켜져 있어야 합니다.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {VENUE_TYPES.map((v: VenueType) => {
                const on = draft.enabled_venue_types.includes(v)
                return (
                  <label
                    key={v}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                      on ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                      readOnly && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={readOnly}
                      onChange={() =>
                        setDraft((p) => ({
                          ...p,
                          enabled_venue_types: toggleVenueType(p.enabled_venue_types, v),
                        }))
                      }
                    />
                    {VENUE_TYPE_LABELS[v]}
                  </label>
                )
              })}
            </div>
          </div>

          <Separator />

          <label className={cn("flex items-start gap-3", readOnly && "cursor-not-allowed opacity-60")}>
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.allow_same_role_discovery}
              disabled={readOnly}
              onChange={(e) =>
                setDraft((p) => ({ ...p, allow_same_role_discovery: e.target.checked }))
              }
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">동일 역할 상호 열람 허용</span>
              <span className="text-xs text-muted-foreground">
                켜면 참가사가 다른 참가사를, 바이어가 다른 바이어를 탐색·미팅 신청할 수 있습니다.
                기본은 꺼짐(참가사↔바이어 교차 매칭만).
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {errors.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="flex items-center justify-end gap-3">
          {dirty && <span className="text-xs text-muted-foreground">저장하지 않은 변경이 있습니다</span>}
          <Button onClick={save} disabled={!dirty}>
            <Save data-icon="inline-start" />
            설정 저장
          </Button>
        </div>
      )}

      {/* ── 참가사별 미팅 불가 시간대 ──────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>미팅 불가 시간대</CardTitle>
          <CardDescription>
            기업을 고르고 칸을 눌러 배정 불가 시간을 지정합니다. 표시된 칸은 배정 엔진이 비워 둡니다.
            (이 설정은 운영자 전용입니다 — 기업이 직접 바꾸지 않습니다.)
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="max-w-full">
                  <span className="truncate">{selectedOrg ? selectedOrg.name_ko : "기업 선택"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuRadioGroup value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  {organizations.map((o) => (
                    <DropdownMenuRadioItem key={o.id} value={o.id}>
                      {o.name_ko}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedOrg && <Badge variant="outline">불가 {selectedSlots.size}칸</Badge>}
          </div>

          {!selectedOrg || dateIds.length === 0 || times.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              슬롯 격자를 만들 수 없습니다. 행사 기간과 미팅 시간 단위를 먼저 확인해 주세요.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-muted/40">
                    <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground">
                      날짜
                    </th>
                    {times.map((t) => (
                      <th
                        key={t}
                        className="px-1 py-2 text-center font-medium tabular-nums text-muted-foreground"
                      >
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dateIds.map((dateId) => (
                    <tr key={dateId} className="border-t">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-background px-3 py-1.5 font-medium">
                        {formatEventDate(dateId)}
                      </td>
                      {times.map((t) => {
                        const id = slotId(dateId, t)
                        const blocked = selectedSlots.has(id)
                        return (
                          <td key={id} className="p-0.5">
                            <button
                              type="button"
                              disabled={readOnly}
                              aria-pressed={blocked}
                              aria-label={`${formatEventDate(dateId)} ${t} ${blocked ? "불가 해제" : "불가 지정"}`}
                              onClick={() => toggleSlot(id)}
                              className={cn(
                                "h-7 w-full min-w-10 rounded transition-colors disabled:cursor-not-allowed",
                                blocked ? "bg-foreground text-background" : "bg-muted/50 hover:bg-muted",
                              )}
                            >
                              {blocked ? "×" : ""}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            운영시간 {settings.operating_start}~{settings.operating_end}
            {settings.lunch_start && settings.lunch_end && (
              <> · 점심 {settings.lunch_start}~{settings.lunch_end} 제외</>
            )}{" "}
            · 슬롯 {settings.slot_minutes}분
            {settings.slot_gap_minutes > 0 && <> + 텀 {settings.slot_gap_minutes}분</>} 기준
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
