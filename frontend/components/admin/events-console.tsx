"use client"

import { useState } from "react"
import { toast } from "sonner"
import { CalendarPlus, Check, MapPin, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { createEvent, patchEvent, patchEventSettings } from "@/lib/admin/admin-actions"
import { EVENT_ERROR_MESSAGES, validateEvent } from "@/lib/admin/event-settings"
import { DEFAULT_PARTICIPANT_MENU } from "@/lib/event/participant-menu"
import {
  DEFAULT_PARTICIPANT_EMAIL_ENABLED,
  SLOT_MINUTES_OPTIONS,
  VENUE_TYPE_LABELS,
  type AdminEvent,
  type AdminEventSettings,
  type SlotMinutes,
} from "@/lib/admin/types"
import { TextField } from "./shared"

// 행사 관리 — 멀티 행사 운영의 근간. 여기서 만든 행사가 스위처에 뜨고, 각 행사가 자기 정책을 갖는다.
//
// 이 폼은 **두 리소스**를 한 화면에서 다룬다(백엔드 계약이 둘로 갈려 있으므로 저장도 둘로 나간다):
//   · PATCH /events/{id}          — 행사명·장소·전시기간·신청기간
//   · PATCH /events/{id}/settings — 미팅 시간 단위
// 장소유형·동일역할 열람 같은 나머지 정책은 "행사 설정" 섹션에서 마저 다룬다.

// 행사 현지 타임존 선택지 — 데모 범위는 2택으로 충분하다(timezone-analysis.md §4 P0-1-4). IANA
// 문자열이 아닌 값이 오면 백엔드 검증(resolve_zone)에서 422로 걸러진다.
const EVENT_TIMEZONE_OPTIONS = ["Asia/Seoul", "Asia/Ho_Chi_Minh"] as const

interface EventFormState {
  name: string
  name_en: string
  venue_name: string
  exhibition_start: string
  exhibition_end: string
  application_start: string
  application_end: string
  slot_minutes: SlotMinutes
  timezone: string
}

function toForm(event: AdminEvent | null, settings: AdminEventSettings | null): EventFormState {
  return {
    name: event?.name ?? "",
    name_en: event?.name_en ?? "",
    venue_name: event?.venue_name ?? "",
    exhibition_start: event?.exhibition_start ?? "",
    exhibition_end: event?.exhibition_end ?? "",
    application_start: event?.application_start ?? "",
    application_end: event?.application_end ?? "",
    slot_minutes: settings?.slot_minutes ?? 30,
    timezone: event?.timezone ?? "Asia/Seoul",
  }
}

// 폼 → 행사 리소스 필드(PATCH /events/{id} 본문).
function toEventFields(form: EventFormState): Omit<AdminEvent, "id"> {
  return {
    name: form.name.trim(),
    name_en: form.name_en.trim() || undefined,
    venue_name: form.venue_name.trim(),
    exhibition_start: form.exhibition_start,
    exhibition_end: form.exhibition_end,
    application_start: form.application_start,
    application_end: form.application_end,
    timezone: form.timezone,
  }
}

export function EventsConsole({
  events,
  settingsByEvent,
  selectedEventId,
  readOnly,
}: {
  events: AdminEvent[]
  settingsByEvent: Record<string, AdminEventSettings>
  selectedEventId: string
  readOnly: boolean
}) {
  const [rows, setRows] = useState<AdminEvent[]>(events)
  const [settings, setSettings] = useState<Record<string, AdminEventSettings>>(settingsByEvent)
  const [editing, setEditing] = useState<AdminEvent | null>(null)
  const [creating, setCreating] = useState(false)
  const [newSeq, setNewSeq] = useState(0)

  function saveEdit(form: EventFormState) {
    if (!editing) return
    const target = editing
    const fields = toEventFields(form)
    setRows((prev) => prev.map((e) => (e.id === target.id ? { ...e, ...fields } : e)))
    setSettings((prev) => ({
      ...prev,
      [target.id]: { ...prev[target.id], slot_minutes: form.slot_minutes },
    }))
    setEditing(null)
    toast(`'${fields.name}' 행사를 수정했어요`)
    // 리소스가 둘이라 저장도 둘로 나간다(계약 그대로).
    void patchEvent(target.id, fields)
    if (settings[target.id]?.slot_minutes !== form.slot_minutes) {
      void patchEventSettings(target.id, { slot_minutes: form.slot_minutes })
    }
  }

  function saveCreate(form: EventFormState) {
    const seq = newSeq + 1
    setNewSeq(seq)
    const id = `evt-new-${seq}`
    const fields = toEventFields(form)
    const created: AdminEventSettings = {
      event_id: id,
      slot_minutes: form.slot_minutes,
      // 신규 행사의 기본 정책 — 부스만 켜고 동일역할 열람은 끈다(가장 보수적인 출발점).
      enabled_venue_types: ["booth"],
      allow_same_role_discovery: false,
      // H9 — 문서 확정 기본값(운영시간 09:00~18:00/30분, 점심 없음, 최소보장 10) 그대로 초기화한다
      // (docs/db/schema.sql event_schedule_settings 기본값과 동일 — timezone-analysis.md §3.3).
      operating_start: "09:00",
      operating_end: "18:00",
      lunch_start: null,
      lunch_end: null,
      min_guaranteed_slots: 10,
      slot_gap_minutes: 0,
      max_meeting_minutes: 90,
      // 신규 행사는 백엔드 기본값과 같은 값으로 시작한다(참가자 메뉴 = 미팅만, 참가자 알림 메일 = 꺼짐).
      participant_menu: DEFAULT_PARTICIPANT_MENU,
      participant_email_enabled: DEFAULT_PARTICIPANT_EMAIL_ENABLED,
    }
    setRows((prev) => [...prev, { id, ...fields }])
    setSettings((prev) => ({ ...prev, [id]: created }))
    setCreating(false)
    toast(`'${fields.name}' 행사를 만들었어요`, {
      description: "상단 스위처에서 전환한 뒤 세부 정책을 설정하세요",
    })
    // backend EventCreate(extra=forbid)는 정책 필드를 top-level로 받는다 — 중첩 settings가 아니다
    // (AdminEventCreateBody, lib/admin/admin-actions.ts 참조).
    void createEvent({
      ...fields,
      slot_minutes: created.slot_minutes,
      enabled_venue_types: created.enabled_venue_types,
      allow_same_role_discovery: created.allow_same_role_discovery,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {!readOnly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreating(true)}>
            <CalendarPlus data-icon="inline-start" />
            행사 추가
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((event) => {
          const s = settings[event.id]
          const isCurrent = event.id === selectedEventId
          return (
            <Card key={event.id} className={cn(isCurrent && "ring-1 ring-primary")}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {event.name}
                  {isCurrent && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <Check className="size-3" />
                      관리 중
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>{event.name_en ?? "-"}</CardDescription>
                {!readOnly && (
                  <CardAction>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(event)}>
                      <Pencil data-icon="inline-start" />
                      수정
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{event.venue_name}</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-20 shrink-0 text-muted-foreground">타임존</span>
                  <span className="tabular-nums">{event.timezone}</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-20 shrink-0 text-muted-foreground">전시 기간</span>
                  <span className="tabular-nums">
                    {event.exhibition_start} ~ {event.exhibition_end}
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="w-20 shrink-0 text-muted-foreground">신청기간</span>
                  <span className="tabular-nums">
                    {event.application_start} ~ {event.application_end}
                  </span>
                </div>
                {s && (
                  <>
                    <div className="flex gap-3">
                      <span className="w-20 shrink-0 text-muted-foreground">미팅 단위</span>
                      <span className="tabular-nums">{s.slot_minutes}분</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-20 shrink-0 text-muted-foreground">장소</span>
                      <span className="flex flex-wrap gap-1">
                        {s.enabled_venue_types.map((v) => (
                          <Badge key={v} variant="outline" className="text-[10px]">
                            {VENUE_TYPE_LABELS[v]}
                          </Badge>
                        ))}
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <EventFormDialog
        key={editing?.id ?? `create-${newSeq}`}
        mode={editing ? "edit" : "create"}
        open={!!editing || creating}
        initial={toForm(editing, editing ? settings[editing.id] : null)}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setCreating(false)
          }
        }}
        onSubmit={editing ? saveEdit : saveCreate}
      />
    </div>
  )
}

function EventFormDialog({
  mode,
  open,
  initial,
  onOpenChange,
  onSubmit,
}: {
  mode: "create" | "edit"
  open: boolean
  initial: EventFormState
  onOpenChange: (open: boolean) => void
  onSubmit: (form: EventFormState) => void
}) {
  const [form, setForm] = useState<EventFormState>(initial)
  const [errors, setErrors] = useState<string[]>([])

  const set = <K extends keyof EventFormState>(key: K, value: EventFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // 행사 리소스 검증기를 그대로 태운다 — 행사 폼과 설정 화면이 같은 규칙을 공유한다.
    const check = validateEvent(toEventFields(form), {})
    if (!check.valid) {
      setErrors(check.errors.map((code) => EVENT_ERROR_MESSAGES[code]))
      return
    }
    setErrors([])
    onSubmit(form)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? "행사 수정" : "행사 추가"}</DialogTitle>
          <DialogDescription>
            행사 식별 정보와 일정을 설정합니다. 장소 유형·동일역할 열람 등 세부 정책은 행사 설정에서
            조정합니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5">
            <div className="flex flex-wrap gap-3">
              <TextField
                id="ev-name"
                label="행사명(국문)"
                value={form.name}
                onChange={(v) => set("name", v)}
              />
              <TextField
                id="ev-name-en"
                label="행사명(영문)"
                value={form.name_en}
                onChange={(v) => set("name_en", v)}
              />
            </div>
            <TextField
              id="ev-venue"
              label="장소"
              value={form.venue_name}
              onChange={(v) => set("venue_name", v)}
              placeholder="예: 베트남 호치민 GEM Center (Grand Castor)"
            />
            <div className="flex flex-wrap gap-3">
              <TextField
                id="ev-ex-start"
                label="전시 시작"
                type="date"
                value={form.exhibition_start}
                onChange={(v) => set("exhibition_start", v)}
              />
              <TextField
                id="ev-ex-end"
                label="전시 종료"
                type="date"
                value={form.exhibition_end}
                onChange={(v) => set("exhibition_end", v)}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <TextField
                id="ev-app-start"
                label="신청 시작"
                type="date"
                value={form.application_start}
                onChange={(v) => set("application_start", v)}
              />
              <TextField
                id="ev-app-end"
                label="신청 종료"
                type="date"
                value={form.application_end}
                onChange={(v) => set("application_end", v)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">행사 현지 타임존</span>
              <p className="text-xs text-muted-foreground">
                미팅 시각·슬롯 그리드 표시가 전부 이 값 기준으로 계산됩니다(ADR-0014).
              </p>
              <div className="flex flex-wrap gap-2">
                {EVENT_TIMEZONE_OPTIONS.map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    aria-pressed={form.timezone === tz}
                    onClick={() => set("timezone", tz)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      form.timezone === tz
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    {tz}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">미팅 시간 단위</span>
              <div className="flex flex-wrap gap-2">
                {SLOT_MINUTES_OPTIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={form.slot_minutes === m}
                    onClick={() => set("slot_minutes", m)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm tabular-nums transition-colors",
                      form.slot_minutes === m
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    {m}분
                  </button>
                ))}
              </div>
            </div>
            {errors.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                {errors.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">{mode === "edit" ? "저장" : "만들기"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
