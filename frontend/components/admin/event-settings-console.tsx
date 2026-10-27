"use client"

import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CircleAlert, Clock, Mail, MailX, Save } from "lucide-react"
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
  changedSettingsFields,
  countMisalignedSlots,
  EVENT_ERROR_MESSAGES,
  rebaseSettingsDraft,
  SETTINGS_ERROR_MESSAGES,
  settingsPatchOf,
  toggleVenueType,
  validateApplicationPeriod,
  validateEventSettings,
} from "@/lib/admin/event-settings"
import {
  DEFAULT_PARTICIPANT_EMAIL_ENABLED,
  PARTICIPANT_MENU_ITEMS,
  PARTICIPANT_MENU_LABELS,
  SLOT_MINUTES_OPTIONS,
  VENUE_TYPES,
  VENUE_TYPE_LABELS,
  type AdminEvent,
  type AdminEventSettings,
  type AdminOrganization,
  type SlotMinutes,
  type VenueType,
} from "@/lib/admin/types"
import {
  isAdminHttpMode,
  loadEventSettings,
  patchEvent,
  patchUnavailableSlots,
  saveEventSettings,
} from "@/lib/admin/admin-actions"
import { createAdminApplicationTransport } from "@/lib/admin/application-transport"
import { eventDateIds } from "@/lib/admin/events"
import { DEFAULT_PARTICIPANT_MENU, PARTICIPANT_MENUS } from "@/lib/event/participant-menu"
import { isOperatorConflict, saveUnavailableSlotsChecked } from "@/lib/operator/application-client"
import { toggleUnavailableSlot } from "@/lib/operator/slot-grid"
import { slotTimes } from "@/lib/organizer/schedule"
import { UnavailableSlotGrid } from "@/components/operator/unavailable-slot-grid"

// 행사 설정 — 이 행사에만 적용되는 운영 정책.
//  ① 미팅 시간 단위(10/20/30/60) — 라디오 카드            → PATCH /events/{id}/settings
//  ② 신청기간 시작·종료                                   → PATCH /events/{id}   (행사 리소스!)
//  ③ 정책 토글: 사용 가능한 미팅 장소 유형 / 동일 역할 상호 열람 → PATCH /events/{id}/settings
//  ④ 참가자 메뉴(미팅만 / 전체 메뉴) — 라디오 카드          → PATCH /events/{id}/settings
//  ⑤ 참가자 알림 메일(보내지 않음 / 보냄) — 라디오 카드     → PATCH /events/{id}/settings
//  ⑥ 참가사별 미팅 불가 시간대 — 기업을 고르고 슬롯 그리드 토글  → PATCH .../unavailable-slots
//
// 한 화면이지만 저장은 리소스별로 갈라 나간다(백엔드 계약 그대로). 신청기간이 settings가 아니라
// event에 사는 게 헷갈리기 쉬워 아래 저장 함수에 주석으로 못박아 둔다.
//
// 슬롯 격자는 행사 전시 기간 × 하루 운영시간을 슬롯 길이로 끊어 만든다. 운영시간·점심 블록은
// 운영자 콘솔의 스케줄 기본값(lib/organizer/schedule)을 재사용한다 — 이 화면이 다루는 계약 필드는
// slot_minutes 하나이고, 나머지는 배정 엔진 쪽 설정이기 때문이다.

// 참가자 알림 메일 선택지(nt004mail0001). 꺼짐(보내지 않음)이 기본이라 먼저 둔다(2026-10-16 발주사 결정).
// 범위는 참가사·바이어에게 가는 **모든 메일**이다 — 자동 알림 메일과 러브콜 메일. 회원가입 인증 코드만 예외다
// (2026-10-16 발주사 요구 "어떠한 메일도" — 카드에 적는다).
const PARTICIPANT_EMAIL_OPTIONS: readonly { value: boolean; label: string; detail: string }[] = [
  {
    value: false,
    label: "보내지 않음",
    detail: "메일을 보내지 않습니다 — 자동 알림은 사이트 안 알림만 남고, 러브콜 메일은 보낼 수 없습니다",
  },
  {
    value: true,
    label: "보냄",
    detail: "자동 알림을 이메일과 사이트 안 알림으로 보내고, 러브콜 메일도 보낼 수 있습니다",
  },
]

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
  // 불가 시간 저장을 기다리는 동안 — 격자를 잠가 요청이 겹치지 않게 한다(전체 치환이라 순서가 뒤집히면
  // 늦게 도착한 옛 목록이 이긴다).
  const [slotSaving, setSlotSaving] = useState(false)
  // 설정 저장을 기다리는 동안 — 저장 버튼을 "저장 중"으로 잠근다. 두 저장이 겹치면 늦게 온 응답이 화면을
  // 덮어 서버와 어긋날 수 있다. ref는 같은 틱의 두 번째 클릭(상태 반영 전)까지 막는다.
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  // 운영자가 이 화면에서 실제로 바꾼 설정 필드 — 저장할 때 이 필드만 보낸다(changedSettingsFields 주석).
  const changedFields = changedSettingsFields(settings, draft)
  const settingsDirty = changedFields.length > 0
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
  const selectedSlots = unavailable[selectedOrgId] ?? []

  async function save() {
    if (savingRef.current) return
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
    savingRef.current = true
    setSaving(true)
    const savedParts: string[] = []
    try {
      if (settingsCheck?.valid) {
        // 화면 상태(저장된 값·맨 위 메일 상태 표시·저장 알림)는 서버가 2xx로 답한 **뒤에** 바꾼다 — 응답 전에
        // 먼저 바꿔 보이면, 거절됐을 때 운영자가 메일이 꺼졌다/켜졌다고 믿고 진행하게 된다.
        const base = settings
        const target = settingsCheck.settings
        // 운영자가 바꾼 필드만 보낸다 — 값은 검증·정규화를 거친 target에서. 화면을 오래 열어 둔 사이 다른
        // 마스터가 바꾼 값(예: 참가자 알림 메일)을 이 탭이 열 때 읽은 값으로 되돌리지 않는다.
        const result = await saveEventSettings(event.id, settingsPatchOf(target, changedFields))
        if (result.success) {
          // 서버가 돌려준 저장 결과가 정본이다(목업·본문 없음이면 보낸 값).
          const saved = result.settings ?? target
          setSettings(saved)
          setDraft((current) => rebaseSettingsDraft(current, target, saved))
          savedParts.push(`미팅 단위 ${saved.slot_minutes}분`)
          // 참가자 메뉴는 참가사·바이어 화면 전체가 바뀌는 값이라, 바꿨을 때는 무엇으로 바꿨는지 알린다.
          if (saved.participant_menu !== base.participant_menu) {
            savedParts.push(`참가자 메뉴 ${PARTICIPANT_MENU_LABELS[saved.participant_menu]}`)
          }
          // 참가자 알림 메일도 같다 — 메일이 나가고 안 나가고가 갈리는 값이라 켜고 끈 사실을 적는다.
          if (saved.participant_email_enabled !== base.participant_email_enabled) {
            savedParts.push(
              `참가사·바이어 알림 메일 ${saved.participant_email_enabled ? "보냄" : "보내지 않음"}`,
            )
          }
        } else {
          // 저장되지 않았다(거절·네트워크 단절). 화면이 들고 있던 값을 믿지 않고 서버의 지금 값을 다시 읽어
          // 맞춘다 — 운영자가 고른 값(draft)은 그 위에 남겨 "저장하지 않은 변경"으로 보이고 다시 저장할 수 있다.
          const fresh = await loadEventSettings(event.id)
          if (fresh) {
            setSettings(fresh)
            setDraft((current) => rebaseSettingsDraft(current, base, fresh))
          }
          toast.error("정책 저장에 실패했어요", {
            description: "설정이 저장되지 않았습니다. 다시 저장해 주세요.",
          })
        }
      }
      // ⚠ 신청기간은 settings가 아니라 **행사** 리소스로 나간다(백엔드 확정 계약).
      if (eventCheck?.valid) {
        const submitted = period
        const result = await patchEvent(event.id, submitted).catch(() => ({ success: false }))
        if (result.success) {
          setEvent((prev) => ({ ...prev, ...submitted }))
          savedParts.push(`신청기간 ${submitted.application_start} ~ ${submitted.application_end}`)
        } else {
          toast.error("신청기간 저장에 실패했어요")
        }
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }

    if (savedParts.length > 0) {
      toast("행사 설정을 저장했어요", { description: savedParts.join(" · ") })
    }
  }

  // 칸을 누르면 바로 저장한다(전체 치환). 먼저 화면에 반영하되 서버가 거절하면 되돌리고 알린다 —
  // 예전엔 결과를 보지 않아, 저장에 실패해도 화면에는 지정된 것처럼 남았다.
  //
  // 이 화면의 목록은 페이지를 열 때 읽은 값이다. 그 뒤 다른 곳(신청서 편집 패널·대리작성 다이얼로그·다른
  // 운영자)에서 같은 기업의 불가 시간을 바꿨는데 여기서 옛 목록으로 "전체"를 보내면 그 변경이 사라진다.
  // 그래서 실연동에서는 보내기 직전에 그 기업의 지금 목록을 서버에서 다시 읽어, 화면이 보여 주던 목록과
  // 다르면 보내지 않고 격자를 최신으로 바꾼다(신청서 편집 패널과 같은 검사 — 클라이언트 쪽 검사다,
  // lib/operator/application-client "동시 수정 검사"). 목업에는 다시 읽을 서버가 없다.
  async function toggleSlot(slot: string) {
    if (readOnly || !selectedOrg || slotSaving) return
    const orgId = selectedOrgId
    const previous = unavailable[orgId] ?? []
    const next = toggleUnavailableSlot(previous, slot)
    setUnavailable((prev) => ({ ...prev, [orgId]: next }))
    setSlotSaving(true)
    try {
      if (isAdminHttpMode()) {
        const stored = await saveUnavailableSlotsChecked(
          createAdminApplicationTransport(event.id, orgId, null),
          next,
          previous,
        )
        setUnavailable((prev) => ({ ...prev, [orgId]: stored }))
      } else if (!(await patchUnavailableSlots(event.id, orgId, next)).success) {
        throw new Error("save_failed")
      }
    } catch (error) {
      if (isOperatorConflict(error)) {
        setUnavailable((prev) => ({ ...prev, [orgId]: error.latest as string[] }))
        toast.error("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요", {
          description:
            "최신 내용을 불러왔습니다. 방금 누른 칸은 저장하지 않았으니 확인하고 다시 눌러 주세요.",
        })
      } else {
        // 서버 거절·네트워크 단절(fetch는 throw한다) — 방금 누른 칸을 되돌린다.
        setUnavailable((prev) => ({ ...prev, [orgId]: previous }))
        toast.error("미팅 불가 시간 저장에 실패했어요", {
          description: "방금 누른 칸은 되돌렸습니다. 잠시 후 다시 시도해 주세요.",
        })
      }
    } finally {
      setSlotSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 참가자 알림 메일의 저장된 상태를 맨 위에 한 줄로 늘 보인다. 꺼짐이 기본이라 경고(빨강) 대신 상태 표시다
          — 대부분의 행사가 꺼진 채로 있으므로 늘 뜨는 경고는 소음이 된다. 메일이 실제로 나가는 켜짐 쪽을
          강조한다. */}
      <div
        role="status"
        aria-label="참가사·바이어 알림 메일 상태"
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm",
          settings.participant_email_enabled ? "border-primary/40 bg-primary/5" : "bg-muted/30",
        )}
      >
        {settings.participant_email_enabled ? (
          <Mail className="size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <MailX className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="font-medium">참가사·바이어 알림 메일</span>
        <Badge variant={settings.participant_email_enabled ? "default" : "outline"}>
          {settings.participant_email_enabled ? "보냄" : "보내지 않음"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {settings.participant_email_enabled
            ? "자동 알림과 러브콜 메일이 참가사·바이어 이메일로 나갑니다."
            : "참가사·바이어에게 메일이 나가지 않습니다 — 자동 알림은 사이트 안 알림으로만 남고, 러브콜 메일은 보낼 수 없습니다."}
        </span>
      </div>

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

      {/* ── 참가자 메뉴 ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>참가자 메뉴</CardTitle>
          <CardDescription>
            ‘미팅만’을 고르면 참가사·바이어 화면의 왼쪽 메뉴에 ‘미팅’만 보입니다. 대시보드·기업
            탐색·알림·프로필은 메뉴에서 숨겨지고 기능은 그대로 유지됩니다.
            저장하면 참가사·바이어 화면과 안내 메일 문구가 바로 바뀝니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="참가자 메뉴">
            {PARTICIPANT_MENUS.map((menu) => (
              <button
                key={menu}
                type="button"
                role="radio"
                aria-checked={draft.participant_menu === menu}
                disabled={readOnly}
                onClick={() => setDraft((p) => ({ ...p, participant_menu: menu }))}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  draft.participant_menu === menu
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {PARTICIPANT_MENU_LABELS[menu]}
                  {menu === DEFAULT_PARTICIPANT_MENU && (
                    <Badge variant="outline" className="font-normal">
                      기본
                    </Badge>
                  )}
                </span>
                {/* 이 선택지에서 참가자에게 실제로 보이는 메뉴 */}
                <span className="text-xs text-muted-foreground">
                  왼쪽 메뉴: {PARTICIPANT_MENU_ITEMS[menu]}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── 참가자 알림 메일 ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>참가사·바이어 알림 메일</CardTitle>
          <CardDescription>
            기본은 ‘보내지 않음’입니다 — 참가사·바이어에게 메일이 나가지 않습니다. 자동 알림은 사이트 안
            알림으로만 남고, 회의록 화면의 러브콜 메일도 보낼 수 없습니다(참가자 계정으로 대신 작업하다 눌러도
            막힙니다). ‘보냄’으로 켜면 신청 승인·미팅 요청·확정·취소·리마인더 같은 자동 알림을 참가사·바이어
            이메일로도 보내고, 러브콜 메일도 보낼 수 있습니다. 다시 켜도 꺼져 있던 동안의 메일은 보내지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            role="radiogroup"
            aria-label="참가사·바이어 알림 메일"
          >
            {PARTICIPANT_EMAIL_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={draft.participant_email_enabled === option.value}
                disabled={readOnly}
                onClick={() =>
                  setDraft((p) => ({ ...p, participant_email_enabled: option.value }))
                }
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  draft.participant_email_enabled === option.value
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {option.label}
                  {option.value === DEFAULT_PARTICIPANT_EMAIL_ENABLED && (
                    <Badge variant="outline" className="font-normal">
                      기본
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{option.detail}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            자동 알림 메일과 러브콜 메일이 이 설정을 따릅니다. 회원가입 인증 코드만 이 설정과 관계없이 발송됩니다.
          </p>
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
          {dirty && !saving && (
            <span className="text-xs text-muted-foreground">저장하지 않은 변경이 있습니다</span>
          )}
          <Button onClick={() => void save()} disabled={!dirty || saving} aria-busy={saving}>
            <Save data-icon="inline-start" />
            {saving ? "저장 중…" : "설정 저장"}
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
            {selectedOrg && <Badge variant="outline">불가 {selectedSlots.length}칸</Badge>}
          </div>

          {/* 격자 UI는 대리작성 다이얼로그·신청서 편집 패널과 함께 쓴다(components/operator). */}
          <UnavailableSlotGrid
            grid={selectedOrg ? { dateIds, times } : null}
            blocked={selectedSlots}
            onToggle={(slot) => void toggleSlot(slot)}
            readOnly={readOnly || slotSaving}
          />
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
