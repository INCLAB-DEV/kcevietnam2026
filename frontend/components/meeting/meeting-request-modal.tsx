"use client"

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock,
  DoorOpen,
  Handshake,
  MapPin,
  Sparkles,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { Organization, ViewerRole } from "@/lib/types"
import type {
  AcceptanceMode,
  MeetingAvailability,
  MeetingDate,
  MeetingDraft,
  VenueKind,
  VenueNumber,
  VenueOption,
} from "@/lib/meeting/types"
import {
  orderedSlots,
  slotRangeLabel,
  toggleSlot,
  type SlotShape,
} from "@/lib/meeting/slot-selection"
import { acceptanceCopy } from "@/lib/meeting/acceptance"
import { meetingActionErrorMessage } from "@/lib/meeting/action-error"
import { createMeeting, isMeetingHttpMode } from "@/lib/meeting/meeting-actions"
import { resolveLocale } from "@/lib/i18n/config"

interface MeetingRequestModalProps {
  org: Organization
  // 슬롯·장소·AI 초안은 서버에서 api-client로 읽어 내려준 값(F-MT-001) — 모달은 그리기만 한다.
  availability: MeetingAvailability
  // 신청 주체 역할 — 실 제출(POST /api/meetings)의 my_role 힌트로 쓴다(ROLE_AMBIGUOUS 회피).
  viewerRole: ViewerRole
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 모달 UI 계약(VenueKind) → 백엔드 캐노니컬 장소 어휘. http-meetings-client의
// CANONICAL_TO_VENUE_KIND와 반대 방향 매핑(별칭도 수용되지만 캐노니컬을 보낸다).
const VENUE_KIND_TO_CANONICAL: Record<VenueKind, string> = {
  booth: "booth",
  table: "zone_table",
  room: "business_room",
}

// 날짜의 가용 슬롯 수(날짜 칩 부제용) — 받은 가용성에서 파생하는 순수 표시 로직.
function availableCount(date: MeetingDate): number {
  return [...date.morning, ...date.afternoon].filter((s) => s.available).length
}

type Step = 1 | 2 | 3 | "done"

// 단계 라벨 키 — t("request.step*")로 조립(StepIndicator 호출부).
const STEP_LABEL_KEYS = ["stepTime", "stepVenue", "stepConfirm"] as const

const VENUE_ICONS: Record<
  VenueKind,
  React.ComponentType<{ className?: string }>
> = {
  booth: Building2,
  table: Handshake,
  room: DoorOpen,
}

function emptyDraft(availability: MeetingAvailability): MeetingDraft {
  // **고를 수 있는** 장소가 하나뿐이면 자동 선택해 시작한다 — 행사 설정 venueTypes가 1개인 경우
  // (예: 베트남 전시는 부스만)와, 목록엔 여럿이지만 운영 정책상 부스만 예약을 받는 경우가 모두
  // 여기 걸린다(나머지 줄은 선택 불가로 그려지므로 사용자가 고를 게 없다).
  // 번호(테이블/룸)가 있는 유형이면 번호는 여전히 사용자가 고른다.
  const selectable = availability.venues.filter((v) => v.selectable)
  const autoVenue = selectable.length === 1 ? selectable[0] : null
  return {
    dateId: availability.dates[0]?.id ?? null,
    slotIds: [],
    venueKind: autoVenue?.kind ?? null,
    venueNumber: null,
    reason: availability.draftReason,
  }
}

export function MeetingRequestModal({
  org,
  availability,
  viewerRole,
  open,
  onOpenChange,
}: MeetingRequestModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0">
        {/* radix가 닫힐 때 콘텐츠를 언마운트 → 열 때마다 MeetingFlow가 새로 마운트되며 상태가 초기화된다. */}
        {open && (
          <MeetingFlow
            org={org}
            availability={availability}
            viewerRole={viewerRole}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MeetingFlow({
  org,
  availability: initialAvailability,
  viewerRole,
  onClose,
}: {
  org: Organization
  availability: MeetingAvailability
  viewerRole: ViewerRole
  onClose: () => void
}) {
  const t = useTranslations("meeting.toast")
  const tr = useTranslations("meeting.request")
  const tErrors = useTranslations("meeting.errors")
  const locale = useLocale()
  const [step, setStep] = useState<Step>(1)
  // 실 제출(SLOT_TAKEN)에서 가용성을 다시 읽어 이 상태를 갱신한다 — prop을 직접 쓰면 재조회가
  // 반영되지 않는다(재조회 유도, F-MT-001 P1-3 에러 분기).
  const [availability, setAvailability] = useState(initialAvailability)
  const [draft, setDraft] = useState<MeetingDraft>(() => emptyDraft(initialAvailability))
  const [submitting, setSubmitting] = useState(false)

  const venues = availability.venues
  const selectedDate = useMemo(
    () =>
      availability.dates.find((d) => d.id === draft.dateId) ?? availability.dates[0],
    [draft.dateId, availability.dates]
  )
  const ordered = useMemo(() => orderedSlots(selectedDate), [selectedDate])
  // 격자 모양은 seam이 내려준 행사값 그대로 쓴다(FE 상수 금지 — 30분을 박아두면 40분/텀5분 행사에서
  // 종료 시각과 연속 상한이 둘 다 틀려진다. mt003gap0001).
  const shape: SlotShape = useMemo(
    () => ({
      slotMinutes: availability.slotMinutes,
      slotGapMinutes: availability.slotGapMinutes,
      maxMeetingMinutes: availability.maxMeetingMinutes,
    }),
    [availability.slotMinutes, availability.slotGapMinutes, availability.maxMeetingMinutes]
  )
  const rangeLabel = useMemo(
    () => slotRangeLabel(ordered, draft.slotIds, shape, tr),
    [ordered, draft.slotIds, shape, tr]
  )
  const selectedVenue = venues.find((v) => v.kind === draft.venueKind) ?? null

  // 진입 상태는 FE에서 재유도하지 않고 seam이 내려준 값을 그대로 쓴다(ADR-0005 진실원천=백엔드).
  const acceptance = availability.acceptanceMode

  // 단계별 "다음" 활성 조건.
  const canAdvance =
    step === 1
      ? draft.slotIds.length > 0
      : step === 2
        ? // 선택 불가 장소가 초안에 들어와 있으면(구 상태·조작) 진행시키지 않는다 — 신청은 어차피
          // 백엔드에서 막힌다.
          Boolean(selectedVenue?.selectable) &&
          (draft.venueKind === "booth" || Boolean(draft.venueNumber))
        : draft.reason.trim().length > 0

  function pickDate(dateId: string) {
    // 날짜를 바꾸면 슬롯 선택은 초기화(날짜 간 연속성 없음).
    setDraft((d) => ({ ...d, dateId, slotIds: [] }))
  }

  function clickSlot(slotId: string) {
    setDraft((d) => ({ ...d, slotIds: toggleSlot(ordered, d.slotIds, slotId, shape) }))
  }

  function pickVenue(kind: VenueKind) {
    // 예약을 받지 않는 장소는 선택 상태를 바꾸지 않는다 — 버튼도 disabled지만, "흐리게만 보이고
    // 실제로는 골라진다"가 이 화면의 원래 결함이라 상태 쪽에도 못 박는다.
    if (!venues.find((v) => v.kind === kind)?.selectable) return
    setDraft((d) => ({ ...d, venueKind: kind, venueNumber: null }))
  }

  function pickNumber(numberId: string) {
    setDraft((d) => ({ ...d, venueNumber: numberId }))
  }

  function next() {
    if (!canAdvance || submitting) return
    if (step === 3) {
      submit()
      return
    }
    setStep((s) => ((s as number) + 1) as Step)
  }

  function back() {
    if (step === 1) return
    setStep((s) => ((s as number) - 1) as Step)
  }

  // 가용성 재조회 — SLOT_TAKEN(방금 선점됨) 이후 최신 슬롯으로 1단계에 되돌린다.
  async function refetchAvailability(): Promise<MeetingAvailability | null> {
    try {
      const res = await fetch(
        `/api/discover/availability?org=${encodeURIComponent(org.id)}&locale=${encodeURIComponent(locale)}`
      )
      if (!res.ok) return null
      return (await res.json()) as MeetingAvailability
    } catch {
      return null
    }
  }

  async function submit() {
    // 실 세션(NEXT_PUBLIC_AUTH_CLIENT==="http")이 아니면 기존 목업 동작 그대로 — 아래 테스트들이
    // 이 분기를 검증한다(components/meeting/meeting-request-modal.test.tsx).
    if (!isMeetingHttpMode()) {
      setStep("done")
      toast(
        acceptance === "immediate"
          ? tr("immediateToast", { org: org.name })
          : tr("requestedToast", { org: org.name })
      )
      return
    }

    if (!draft.venueKind || draft.slotIds.length === 0) return // canAdvance가 이미 보장 — 방어
    setSubmitting(true)
    const result = await createMeeting({
      counterpartOrgId: org.id,
      slotIds: draft.slotIds,
      venueType: VENUE_KIND_TO_CANONICAL[draft.venueKind],
      venueLabel: draft.venueNumber,
      reason: draft.reason,
      myRole: viewerRole,
    })
    setSubmitting(false)

    if (result.success) {
      setStep("done")
      return
    }

    if (result.errorCode === "SLOT_TAKEN") {
      toast(t("createSlotTaken"))
      const fresh = await refetchAvailability()
      if (fresh) {
        setAvailability(fresh)
        setDraft((d) => ({ ...emptyDraft(fresh), reason: d.reason }))
      }
      setStep(1)
      return
    }

    // (쌍, 시각) 단위 중복 — 같은 상대에게 같은 시각으로 두 번 신청했다(#11). 예전의 쌍 단위
    // 차단은 폐기됐다: 같은 상대와 **다른 시각**으로 여러 번 잡는 건 이제 정상이다.
    if (result.errorCode === "DUPLICATE_APPLICATION") {
      toast(t("createDuplicateApplication"))
      return
    }

    // 그 밖의 거절 — ko는 백엔드 문구 그대로, en은 에러 코드를 번역 문구로(lib/meeting/action-error.ts).
    toast(meetingActionErrorMessage(result, resolveLocale(locale), tErrors, t("createError")))
  }

  const summary = venueSummary(selectedVenue, draft.venueNumber)
  // 날짜·요일·시간을 잇는 모양도 로케일의 것이다 — ko "10/20(화) 09:00 - 09:30", en "10/20 (Tue) 09:00 - 09:30".
  const dateTimeSummary =
    rangeLabel &&
    tr("dateTimeSummary", { date: selectedDate.label, weekday: selectedDate.weekday, range: rangeLabel.range })

  if (step === "done") {
    return (
      <DoneView
        org={org}
        mode={acceptance}
        dateTime={dateTimeSummary || ""}
        venue={summary}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="flex max-h-[inherit] flex-col">
      {/* 헤더 + 단계 표시 */}
      <div className="border-b px-5 pt-5 pb-4">
        <DialogTitle>{tr("title")}</DialogTitle>
        <DialogDescription className="mt-0.5 truncate">
          {org.name}
        </DialogDescription>
        <StepIndicator step={step} />
      </div>

      {/* 본문 (스크롤) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {step === 1 && (
          <TimeStep
            dates={availability.dates}
            selectedDateId={draft.dateId}
            selection={draft.slotIds}
            ordered={ordered}
            rangeLabel={rangeLabel}
            shape={shape}
            onPickDate={pickDate}
            onClickSlot={clickSlot}
          />
        )}
        {step === 2 && (
          <VenueStep
            venues={venues}
            selectedKind={draft.venueKind}
            selectedNumber={draft.venueNumber}
            onPickVenue={pickVenue}
            onPickNumber={pickNumber}
          />
        )}
        {step === 3 && (
          <ConfirmStep
            dateTime={dateTimeSummary || ""}
            venue={summary}
            reason={draft.reason}
            onReasonChange={(reason) => setDraft((d) => ({ ...d, reason }))}
          />
        )}
      </div>

      {/* 푸터 (이전/다음) */}
      <div className="flex items-center gap-3 border-t px-5 py-4">
        {step > 1 && (
          <Button variant="outline" size="lg" onClick={back}>
            <ChevronLeft data-icon="inline-start" />
            {tr("back")}
          </Button>
        )}
        <Button
          size="lg"
          className="flex-1"
          disabled={!canAdvance || submitting}
          onClick={next}
        >
          {step === 3 ? tr("submit") : tr("next")}
        </Button>
      </div>
    </div>
  )
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  const tr = useTranslations("meeting.request")
  return (
    <ol className="mt-4 flex items-center gap-1.5">
      {STEP_LABEL_KEYS.map((labelKey, i) => {
        const n = (i + 1) as 1 | 2 | 3
        const active = n === step
        const done = n < step
        return (
          <li key={labelKey} className="flex flex-1 items-center gap-1.5">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
                active && "bg-primary text-primary-foreground",
                done && "bg-primary/15 text-primary",
                !active && !done && "bg-muted text-muted-foreground"
              )}
            >
              {done ? <Check className="size-3" /> : n}
            </span>
            <span
              className={cn(
                "text-xs font-semibold",
                active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {tr(labelKey)}
            </span>
            {n < 3 && <span className="h-px flex-1 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}

function TimeStep({
  dates,
  selectedDateId,
  selection,
  ordered,
  rangeLabel,
  shape,
  onPickDate,
  onClickSlot,
}: {
  dates: MeetingDate[]
  selectedDateId: string | null
  selection: string[]
  ordered: ReturnType<typeof orderedSlots>
  rangeLabel: ReturnType<typeof slotRangeLabel>
  /// 행사 격자 모양 — 안내 문구의 "N분 슬롯 / 최대 M분"을 여기서 채운다(하드코딩 금지).
  shape: SlotShape
  onPickDate: (id: string) => void
  onClickSlot: (id: string) => void
}) {
  const tr = useTranslations("meeting.request")
  const morning = ordered.filter((s) => Number(s.time.split(":")[0]) < 12)
  const afternoon = ordered.filter((s) => Number(s.time.split(":")[0]) >= 12)

  return (
    <div className="flex flex-col gap-4">
      {/* 날짜 칩 */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {dates.map((d) => {
          const active = d.id === selectedDateId
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => onPickDate(d.id)}
              aria-pressed={active}
              className={cn(
                "flex shrink-0 flex-col items-center gap-0.5 rounded-lg border px-4 py-2 transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              )}
            >
              <span className="text-xs font-medium opacity-80">
                {d.weekday}
              </span>
              <span className="text-sm font-bold">{d.label}</span>
              <span className="text-[10px] opacity-70">
                {tr("slotsAvailable", { count: availableCount(d) })}
              </span>
            </button>
          )
        })}
      </div>

      {/* 범례 */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" /> {tr("legendBoth")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted-foreground/40" /> {tr("legendConflict")}
        </span>
      </div>

      <SlotGrid
        label={tr("morning")}
        slots={morning}
        selection={selection}
        onClick={onClickSlot}
      />
      <SlotGrid
        label={tr("afternoon")}
        slots={afternoon}
        selection={selection}
        onClick={onClickSlot}
      />

      {/* 선택 요약 */}
      {rangeLabel ? (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-lg border bg-accent/50 px-3 py-2.5 text-sm font-semibold">
          <Clock className="size-4 text-primary" />
          {rangeLabel.range} · {rangeLabel.duration}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {tr("slotHint", {
            minutes: shape.slotMinutes,
            max: shape.maxMeetingMinutes,
          })}
        </p>
      )}
    </div>
  )
}

function SlotGrid({
  label,
  slots,
  selection,
  onClick,
}: {
  label: string
  slots: ReturnType<typeof orderedSlots>
  selection: string[]
  onClick: (id: string) => void
}) {
  if (slots.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold text-muted-foreground">{label}</h3>
      <div className="grid grid-cols-4 gap-2">
        {slots.map((slot) => {
          const selected = selection.includes(slot.id)
          return (
            <button
              key={slot.id}
              type="button"
              disabled={!slot.available}
              aria-pressed={selected}
              onClick={() => onClick(slot.id)}
              className={cn(
                "rounded-lg border py-2 text-sm font-semibold tabular-nums transition-colors",
                // 불가: 채운 회색 배경 + 테두리 제거 + 취소선으로 "비활성"을 또렷이.
                !slot.available &&
                  "cursor-not-allowed border-transparent bg-muted text-muted-foreground/45 line-through",
                // 가용: 흰 배경 + 또렷한 테두리로 "누를 수 있음"을 드러냄.
                slot.available &&
                  !selected &&
                  "border-border bg-background hover:border-foreground/30 hover:bg-muted",
                selected && "border-primary bg-primary text-primary-foreground"
              )}
            >
              {slot.time}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// 테이블/룸 번호 선택 그리드 — 선택 UI·자동 선택 요약 양쪽에서 공유.
function NumberGrid({
  numbers,
  selectedNumber,
  onPickNumber,
}: {
  numbers: VenueNumber[]
  selectedNumber: string | null
  onPickNumber: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2 pl-1">
      {numbers.map((num) => {
        const numActive = num.id === selectedNumber
        return (
          <button
            key={num.id}
            type="button"
            disabled={!num.available}
            aria-pressed={numActive}
            onClick={() => onPickNumber(num.id)}
            className={cn(
              "rounded-lg border py-2 text-sm font-semibold transition-colors",
              !num.available &&
                "cursor-not-allowed border-transparent bg-muted text-muted-foreground/45 line-through",
              num.available &&
                !numActive &&
                "border-border bg-background hover:border-foreground/30 hover:bg-muted",
              numActive &&
                "border-primary bg-primary text-primary-foreground"
            )}
          >
            {num.label}
          </button>
        )
      })}
    </div>
  )
}

function VenueStep({
  venues,
  selectedKind,
  selectedNumber,
  onPickVenue,
  onPickNumber,
}: {
  venues: VenueOption[]
  selectedKind: VenueKind | null
  selectedNumber: string | null
  onPickVenue: (kind: VenueKind) => void
  onPickNumber: (id: string) => void
}) {
  const tr = useTranslations("meeting.request")
  // 목록에 고를 수 있는 장소가 딱 하나뿐이면(행사 설정에서 온 목록 — 베트남 전시는 부스만) 고를
  // 필요가 없다. 선택 UI 대신 자동 선택된 요약을 보여준다. 번호(테이블/룸)가 있는 유형이면 번호는
  // 그대로 고른다. 선택 불가 줄이 섞여 있으면 요약이 아니라 아래 목록을 그린다 — 못 고르는 장소도
  // 참가자에게 보여야 하고, "자동 선택"이라고 말할 수 있는 상황도 아니다.
  if (venues.length === 1 && venues[0].selectable) {
    const only = venues[0]
    const Icon = VENUE_ICONS[only.kind]
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-lg border border-primary bg-accent/50 p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-semibold">{only.name}</span>
              <Badge variant="secondary" className="gap-1 font-medium text-primary">
                <Check className="size-3" />
                {tr("autoSelected")}
              </Badge>
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
              {only.description}
            </span>
          </span>
        </div>
        {only.numbers && (
          <NumberGrid numbers={only.numbers} selectedNumber={selectedNumber} onPickNumber={onPickNumber} />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {venues.map((v) => {
        const Icon = VENUE_ICONS[v.kind]
        const active = v.kind === selectedKind
        // 예약을 받지 않는 장소 — 흐리게만 그리지 않고 실제로 못 누르게 한다(disabled + aria).
        const unbookable = !v.selectable
        return (
          <div key={v.kind} className="flex flex-col gap-2">
            <button
              type="button"
              aria-pressed={active}
              disabled={unbookable}
              aria-disabled={unbookable}
              onClick={() => onPickVenue(v.kind)}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                unbookable
                  ? "cursor-not-allowed border-dashed bg-muted/40 opacity-60"
                  : active
                    ? "border-primary bg-accent/50"
                    : "bg-background hover:bg-muted"
              )}
            >
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-md",
                  active && !unbookable
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span
                    className={cn("font-semibold", unbookable && "text-muted-foreground")}
                  >
                    {v.name}
                  </span>
                  {v.badge && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "font-medium",
                        v.badge.tone === "limited" &&
                          "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
                        v.badge.tone === "unavailable" &&
                          "bg-muted text-muted-foreground"
                      )}
                    >
                      {v.badge.text}
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {v.description}
                </span>
              </span>
              {active && <Check className="size-5 shrink-0 text-primary" />}
            </button>

            {/* 테이블/룸 번호 선택 — 해당 장소가 선택됐을 때만(선택 불가 장소는 펼치지 않는다) */}
            {active && !unbookable && v.numbers && (
              <NumberGrid numbers={v.numbers} selectedNumber={selectedNumber} onPickNumber={onPickNumber} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function ConfirmStep({
  dateTime,
  venue,
  reason,
  onReasonChange,
}: {
  dateTime: string
  venue: string
  reason: string
  onReasonChange: (v: string) => void
}) {
  const tr = useTranslations("meeting.request")
  return (
    <div className="flex flex-col gap-4">
      {/* 선택 요약 */}
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-3">
          <Calendar className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">
              {tr("dateTimeLabel")}
            </p>
            <p className="text-sm font-semibold">{dateTime}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <MapPin className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">
              {tr("venueLabel")}
            </p>
            <p className="text-sm font-semibold">{venue}</p>
          </div>
        </div>
      </div>

      {/* 신청 사유 (AI 초안 pre-fill) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="meeting-reason" className="text-sm font-semibold">
            {tr("reasonLabel")}
          </label>
          <Badge variant="secondary" className="gap-1 font-medium text-primary">
            <Sparkles className="size-3" />
            {tr("aiDraftBadge")}
          </Badge>
        </div>
        <Textarea
          id="meeting-reason"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          rows={7}
          className="min-h-36"
        />
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Sparkles className="size-3" />
          {tr("aiDraftHint")}
        </p>
      </div>
    </div>
  )
}

function DoneView({
  org,
  mode,
  dateTime,
  venue,
  onClose,
}: {
  org: Organization
  mode: AcceptanceMode
  dateTime: string
  venue: string
  onClose: () => void
}) {
  const tr = useTranslations("meeting.request")
  const tAcceptance = useTranslations("meeting.acceptance")
  const copy = acceptanceCopy(mode, org.name, tAcceptance)
  const immediate = mode === "immediate"
  return (
    <div className="flex flex-col items-center gap-5 px-5 py-8 text-center">
      <span
        className={cn(
          "flex size-16 items-center justify-center rounded-full",
          immediate
            ? "bg-primary/10 text-primary"
            : "bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300"
        )}
      >
        {immediate ? (
          <CheckCircle2 className="size-8" />
        ) : (
          <Clock className="size-8" />
        )}
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-bold tracking-tight">{copy.title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {copy.description}
        </p>
      </div>

      <div className="w-full rounded-lg border bg-muted/40 p-4 text-left text-sm">
        <Row label={tr("venueLabel")} value={venue} />
        <Row label={tr("dateTimeLabel")} value={dateTime} />
        <div className="mt-2 flex items-center justify-between border-t pt-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {tr("statusLabel")}
          </span>
          <span
            className={cn(
              "flex items-center gap-1 text-xs font-semibold",
              immediate ? "text-primary" : "text-amber-600"
            )}
          >
            {immediate ? (
              <Check className="size-3.5" />
            ) : (
              <Clock className="size-3.5" />
            )}
            {copy.statusLabel}
          </span>
        </div>
      </div>

      <Button size="lg" className="w-full" onClick={onClose}>
        {tr("confirmButton")}
      </Button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm font-medium">{value}</span>
    </div>
  )
}

function venueSummary(
  venue: VenueOption | null,
  number: string | null
): string {
  if (!venue) return ""
  if (venue.numbers && number) return `${venue.name} · ${number}`
  return venue.name
}
