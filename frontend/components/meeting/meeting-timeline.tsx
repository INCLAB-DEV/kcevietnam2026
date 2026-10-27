"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAutoRefresh } from "@/hooks/use-auto-refresh"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import {
  MeetingDetailPanel,
  MeetingPanelEmpty,
} from "@/components/meeting/meeting-detail-panel"
import { MeetingActionStrip } from "@/components/meeting/meeting-action-strip"
import type { ActionStripView } from "@/lib/meeting/action-strip"
import type {
  MeetingPanelView,
  PanelEmptyKind,
} from "@/lib/meeting/meeting-panel"
import type {
  DayTimeline,
  SlotMeeting,
  SlotTone,
  TimelineSlot,
  UnlistedMeeting,
} from "@/lib/meeting/timeline"

// MY-001 일별 타임라인(F-MY-001 D9). UI는 shadcn 컴포넌트(Item/Card/Badge)로 구성.
// 분기는 데스크톱(≥768)에선 실제 콘텐츠 폭 기준(사이드바 펼침/접힘·줌 무관, codex 검수):
//  - 2컬럼이 각자 min-width(타임라인 17rem + gap 1rem + 기업정보 22rem) 안에 들어가면 좌|우 인라인
//  - 그보다 좁아지면(compact) 기업정보 인라인 미노출 + 타임라인만, 미팅 선택 시 하단 Sheet 팝업으로 조회
// 단, nav가 오버레이 시트로 접히는 폭(<768, useIsMobile)에선 콘텐츠 폭과 무관하게 compact 고정.
//  → nav 접힘 순간 인라인 사이드바(256px)가 사라지며 콘텐츠가 넓어져 2컬럼이 잠깐 떴다 사라지던
//    깜빡임(뷰포트 668~768 死구간)을 없앤다(nav 접힘과 타임라인 compact를 768로 일치).
// min-width 이하로 우그러뜨리지 않고 팝업으로 분리해 패널이 아래로 밀려나는 케이스를 없앤다.
// 타임라인 min을 17rem으로 둔 이유: 날짜 탭이 최소 3개는 안 잘리고 보여야 함(그 미만
// 폭은 compact 풀폭으로 떨어뜨려 탭에 여유를 준다). 날짜가 더 많으면 탭 행은 가로 스크롤.
const COMPACT_THRESHOLD = 640 // px = 17rem(타임라인) + 1rem(gap) + 22rem(기업정보). 미만이면 compact.

// 루트의 실제 폭을 관찰해 compact 여부 반환. 측정 전(null)엔 인라인 2컬럼으로 가정(넓은 화면 플리커 방지).
function useCompact(ref: React.RefObject<HTMLElement | null>): boolean | null {
  const [compact, setCompact] = useState<boolean | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setCompact(w < COMPACT_THRESHOLD)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return compact
}

interface MeetingTimelineProps {
  days: DayTimeline[]
  panels: Record<string, MeetingPanelView>
  initialSelectedId: string | null
  // 포커싱(명시적 선택) 안 한 상태에서 우측 패널에 기본으로 띄울 다음(예정) 미팅.
  // 선택과 달리 해당 행은 하이라이트하지 않는다(비포커스 기본 표시).
  defaultMeetingId?: string | null
  emptyState: PanelEmptyKind | null
  // 상단 "나를 기다리는 액션" 스트립(D15~D17). 없거나 0건이면 스트립은 렌더되지 않는다.
  actionStrip?: ActionStripView | null
  // 어느 날짜 탭에도 못 실은 미팅(행사일 밖·시각 미정). 조용히 사라지면 "분명 잡혔는데 없다"가
  // 되므로 타임라인 위에 건수와 상대/시각을 그대로 노출한다. 0건이면 아무것도 렌더하지 않는다.
  unlisted?: UnlistedMeeting[]
}

// 슬림 시맨틱 액센트(F-MY-001 D2 + near-mono): 면은 모노, 좌측 4px 틱에만 상태색.
// green=확정/예정, red=응답대기, orange=회의록 작성 필요, blue=회의록 완료(보관), gray=노쇼/거절/취소/빈.
const TICK_BG: Record<SlotTone, string> = {
  green: "bg-status-confirmed",
  red: "bg-status-pending",
  orange: "bg-status-review",
  blue: "bg-status-archived",
  gray: "bg-status-muted",
}

// 받은 응답대기(=내가 응답해야 할 건)만 라벨을 강조. 만료·나머지는 중립 muted 텍스트.
function isActionNeeded(m: SlotMeeting): boolean {
  return !m.expired && m.status === "proposed" && m.direction === "received"
}

// 미팅 id가 어느 날짜 탭에 있는지 — 한 칸에 여러 건이 쌓이므로(#10) 대표 건만이 아니라
// 칸의 모든 건을 훑는다(대표가 아닌 건으로 딥링크/점프해도 그 날짜 탭이 열려야 한다).
function dayIdOf(days: DayTimeline[], meetingId: string | null): string | undefined {
  if (!meetingId) return undefined
  return days.find((d) =>
    d.slots.some(
      (s) => s.kind === "meeting" && s.meetings.some((m) => m.meetingId === meetingId)
    )
  )?.dateId
}

export function MeetingTimeline({
  days,
  panels,
  initialSelectedId,
  defaultMeetingId = null,
  emptyState,
  actionStrip = null,
  unlisted = [],
}: MeetingTimelineProps) {
  const t = useTranslations("meeting.timeline")
  // 상대가 수락·거절·취소해도 내 화면은 스스로 갱신되지 않는다(폴링·SSE 없음) — 탭 복귀·포커스·
  // 30초 주기로 서버 컴포넌트를 다시 그려 상대 쪽 변화를 받아온다.
  useAutoRefresh()
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)

  // 진입 시 활성 탭은 (선택이 있으면 선택, 없으면) 비포커스 기본으로 띄울 다음 미팅의 날짜로 맞춘다.
  const dayOfSelected = dayIdOf(days, selectedId ?? defaultMeetingId)
  const defaultDay =
    dayOfSelected ??
    // 오늘(행사 당일) 탭. now 칩이 만료칸에 걸려 없더라도 isToday로 오늘을 고른다.
    days.find((d) => d.isToday)?.dateId ??
    days.find((d) => d.pendingCount > 0)?.dateId ??
    days[0]?.dateId

  const [activeDay, setActiveDay] = useState<string | undefined>(defaultDay)
  const rootRef = useRef<HTMLDivElement>(null)
  // nav가 모바일 오버레이로 접히는 폭(<768)에선 콘텐츠 폭과 무관하게 compact 고정 —
  // nav 접힘 순간 콘텐츠가 넓어져 2컬럼이 깜빡였다 사라지는 死구간(668~768) 제거(상단 주석).
  const measured = useCompact(rootRef)
  const isMobile = useIsMobile()
  const compact = isMobile ? true : measured
  // 시트(바텀시트) 열림은 별도 상태로 관리한다. compact에서 슬롯을 "눌렀을 때"만
  // 열고, 리사이즈만으로는 열지 않는다(좁히기만 해도 튀어나오던 문제 제거).
  const [sheetOpen, setSheetOpen] = useState(false)
  // 예외: 딥링크 진입(알림 인박스 → /meetings?meeting=:id)은 "그 행을 눌러 연 것"과 같은 의도다.
  // compact에선 인라인 패널이 없어 선택만으론 화면에 아무것도 안 뜨므로 시트를 자동으로 연다.
  // compact 측정이 끝난 뒤 최초 1회만 — 이후 리사이즈로 좁아졌다고 다시 열리지는 않는다.
  // effect 대신 렌더 중 보정(아래 wasCompact 보정과 동일한 React 권장 패턴).
  const [deepLinkHandled, setDeepLinkHandled] = useState(initialSelectedId === null)
  if (!deepLinkHandled && compact !== null) {
    setDeepLinkHandled(true)
    if (compact) setSheetOpen(true)
  }
  // 빈 시간대 선택(미팅 선택과 상호배타). 같은 시각이 날마다 있으므로 dateId까지 합친 키로 식별.
  // 선택하면 우측 패널/시트에 "이 시간대 비어있음 → 기업 탐색" 안내를 띄운다.
  const [selectedEmptyKey, setSelectedEmptyKey] = useState<string | null>(null)
  const handleSelect = (id: string) => {
    // 같은 행을 다시 누르면 선택 해제(토글). aria-current를 끌 수 있게 하고,
    // 인라인에선 빈 패널로, compact에선 시트를 닫는다.
    if (id === selectedId) {
      setSelectedId(null)
      setSheetOpen(false)
      return
    }
    setSelectedId(id)
    setSelectedEmptyKey(null) // 미팅 선택 시 빈 시간대 선택 해제
    if (compact === true) setSheetOpen(true)
  }
  // 빈 시간대 선택(토글). 미팅 선택을 비우고 discover 안내 패널/시트를 띄운다.
  const handleSelectEmpty = (key: string) => {
    if (key === selectedEmptyKey) {
      setSelectedEmptyKey(null)
      setSheetOpen(false)
      return
    }
    setSelectedEmptyKey(key)
    setSelectedId(null)
    if (compact === true) setSheetOpen(true)
  }
  // 상단 스트립 → 타임라인 점프(D17): 대상 미팅을 선택 + 그 날짜 탭으로 전환(+compact면 시트 오픈).
  // 수락/거부·회의록 진입은 선택 시 열리는 패널 한 곳에만 둬 분기·중복을 막는다.
  const jumpTo = (id: string) => {
    const dayId = dayIdOf(days, id)
    if (dayId) setActiveDay(dayId)
    setSelectedId(id)
    setSelectedEmptyKey(null)
    if (compact === true) setSheetOpen(true)
  }
  // 폭이 넓어져 인라인 패널로 전환되면 열림 의도를 비운다 — 다시 좁혀도 누르기
  // 전엔 시트가 자동으로 열리지 않도록. effect 대신 렌더 중 보정(React 권장 패턴).
  const [wasCompact, setWasCompact] = useState(compact)
  if (wasCompact !== compact) {
    setWasCompact(compact)
    if (compact === false) setSheetOpen(false)
  }
  if (!defaultDay) return null

  // 포커싱(명시적 선택)이 있으면 그 미팅을, 없으면 비포커스 기본으로 다음 예정 미팅을 띄운다.
  // 둘 다 없을 때만 빈 상태로 떨어진다. (시트/하이라이트는 selectedView=포커스에만 반응)
  const selectedView = selectedId ? (panels[selectedId] ?? null) : null
  const panelView =
    selectedView ??
    (defaultMeetingId ? (panels[defaultMeetingId] ?? null) : null)
  // 빈 시간대를 직접 선택했으면 discover 안내가 미팅 패널/기본 빈 상태보다 우선한다.
  const emptySlotSelected = selectedEmptyKey !== null
  const panel = emptySlotSelected ? (
    <MeetingPanelEmpty kind="empty-slot" />
  ) : panelView ? (
    <MeetingDetailPanel view={panelView} />
  ) : emptyState ? (
    <MeetingPanelEmpty kind={emptyState} />
  ) : null

  return (
    <div>
      {/* 상단: "나를 기다리는 액션" 스트립(받은 미팅요청·회의록). 0건이면 스스로 렌더 안 함. */}
      {actionStrip && <MeetingActionStrip view={actionStrip} onJump={jumpTo} />}
      {/* 타임라인에 못 실은 미팅(행사일 밖·시각 미정) — 버리지 않고 여기서 드러낸다. */}
      {unlisted.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-md border border-status-review/60 bg-status-review/5 px-3 py-2"
        >
          <p className="text-sm font-medium text-foreground">
            {t("unlistedTitle", { count: unlisted.length })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("unlistedHint")}</p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {unlisted.map((m) => (
              <li key={m.meetingId} className="text-xs text-foreground">
                <span className="font-medium">{m.counterpartName}</span>
                <span className="text-muted-foreground tabular-nums">
                  {" · "}
                  {m.scheduledLabel ?? t("unlistedUnknownTime")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* 줄바꿈 없는 2컬럼: 각 컬럼은 min-width 이하로 줄지 않고, 둘 다 안 들어가면(compact) 우측을
          숨겨 타임라인만 풀폭으로 남긴다(패널이 아래로 밀려나는 케이스 제거). compact에선 Sheet 팝업. */}
      <div ref={rootRef} className="flex items-start gap-4">
        {/* 좌: 타임라인 — 최소 17rem(날짜 탭 3개 보장), 남는 폭은 grow 2:3로 우측과 나눠 가진다 */}
        <Tabs
          value={activeDay}
          onValueChange={setActiveDay}
          className="min-w-[17rem] flex-[2]"
        >
          <TabsList
            data-tour="meeting-days"
            variant="line"
            className="w-full justify-start overflow-x-auto"
          >
            {days.map((day) => {
              // 칸 수가 아니라 미팅 건수 — 한 칸에 여러 건이 쌓일 수 있다(#10).
              const meetingCount = day.slots.reduce(
                (n, s) => n + (s.kind === "meeting" ? s.meetings.length : 0),
                0
              )
              return (
                <TabsTrigger
                  key={day.dateId}
                  value={day.dateId}
                  className="flex-none gap-1.5"
                >
                  <span className="tabular-nums">{day.label}</span>
                  <span className="text-muted-foreground">{day.weekday}</span>
                  {/* 날짜 오른쪽에 그날 미팅 갯수 pill. */}
                  <span
                    data-icon="inline-end"
                    aria-label={t("meetingCountAria", { count: meetingCount })}
                    className="inline-flex min-w-5 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums"
                  >
                    {meetingCount}
                  </span>
                  {/* 받은 응답대기(D11): 숫자 배지 대신 빨간 dot으로 간접 알림(있다/없다만). */}
                  {day.pendingCount > 0 && (
                    <span
                      aria-label={t("pendingAria")}
                      className="absolute -top-0.5 right-0 size-1.5 rounded-full bg-destructive"
                    />
                  )}
                </TabsTrigger>
              )
            })}
          </TabsList>

          {days.map((day) => (
            <TabsContent key={day.dateId} value={day.dateId} className="mt-4">
              <ol data-tour="meeting-list" className="flex flex-col gap-2">
                {day.slots.map((slot) => (
                  <SlotRow
                    key={slot.time}
                    slot={slot}
                    // 선택/비포커스 기본표시는 칸이 아니라 **건** 단위 — 한 칸에 여러 건이 쌓이므로(#10).
                    selectedId={selectedId}
                    defaultMeetingId={defaultMeetingId}
                    // 현재 시각이 이 슬롯 행에 속하면 "지금 HH:MM" 칩(앵커, 항상). nowLive면 진행 중(확정) 링/배경.
                    nowTime={
                      day.now?.rowTime === slot.time ? day.now.time : null
                    }
                    nowLive={
                      day.now?.rowTime === slot.time ? day.now.live : false
                    }
                    onSelect={handleSelect}
                    // 빈 시간대도 선택 가능 — 선택 시 기업 탐색 안내. dateId까지 합쳐 날짜별로 구분.
                    emptySelected={
                      slot.kind === "empty" &&
                      selectedEmptyKey === `${day.dateId}__${slot.time}`
                    }
                    onSelectEmpty={() =>
                      handleSelectEmpty(`${day.dateId}__${slot.time}`)
                    }
                  />
                ))}
              </ol>
            </TabsContent>
          ))}
        </Tabs>

        {/* 우: 기업정보 인라인 패널 — 최소 22rem, 남는 폭은 grow 2:3로 더 큰 몫. compact일 땐 미렌더(팝업으로) */}
        {compact !== true && (
          <aside
            data-tour="meeting-panel"
            className="sticky top-20 min-w-[22rem] flex-[3]"
          >
            {panel}
          </aside>
        )}

        {/* compact(좁은 폭): 미팅 선택 시 기업정보를 하단 팝업(바텀시트)으로 조회 */}
        {compact === true && (
          <Sheet
            open={sheetOpen && (!!selectedView || emptySlotSelected)}
            onOpenChange={(open) => {
              if (!open) {
                // compact에선 "닫힘 = 비선택". selectedId·빈슬롯 선택을 함께 비워, 닫은 뒤 같은 행을 다시
                // 누르면 토글-해제(아무 일 없음)가 아니라 시트가 다시 열리게 한다(codex P1).
                setSheetOpen(false)
                setSelectedId(null)
                setSelectedEmptyKey(null)
              }
            }}
          >
            <SheetContent
              side="bottom"
              className="max-h-[85svh] gap-0 rounded-t-xl p-0"
            >
              {/* 장식용 그래버 바(닫기는 우상단 X·오버레이 탭·Esc). 드래그 어포던스로
                오해되지 않도록 실제 동작은 명시적 닫기 컨트롤에 맡긴다. */}
              <div
                aria-hidden
                className="flex shrink-0 justify-center pt-3 pb-1"
              >
                <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
              </div>
              <SheetHeader className="sr-only">
                <SheetTitle>{t("sheetTitle")}</SheetTitle>
              </SheetHeader>
              {/* 본문만 스크롤 — 그래버는 상단 고정 */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
                {emptySlotSelected ? (
                  <MeetingPanelEmpty kind="empty-slot" />
                ) : selectedView ? (
                  <MeetingDetailPanel view={selectedView} embedded />
                ) : null}
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  )
}

// 비포커스 기본 표시 건: 명시적 선택이 없을 때(selectedId === null)만, 패널에 떠 있는
// 다음 예정 미팅을 가리킨다. 선택(배경+링)과 달리 배경만 옅게 칠해 차별한다.
function isPreviewing(
  meetingId: string,
  selectedId: string | null,
  defaultMeetingId: string | null
): boolean {
  return selectedId === null && !!defaultMeetingId && meetingId === defaultMeetingId
}

function SlotRow({
  slot,
  selectedId,
  defaultMeetingId,
  nowTime,
  nowLive,
  onSelect,
  emptySelected,
  onSelectEmpty,
}: {
  slot: TimelineSlot
  // 선택/비포커스 기본표시는 건 단위 — 한 칸에 여러 건이 쌓일 수 있다(#10).
  selectedId: string | null
  defaultMeetingId: string | null
  // 현재 시각이 이 슬롯 행에 속하면 "HH:MM"(미팅·빈칸 공통), 아니면 null → "지금 HH:MM" 칩(앵커).
  nowTime: string | null
  // 그 행이 진행 중(확정 accepted) 미팅이면 true → 인디고 링/배경 강조. 칩(nowTime)과 독립.
  nowLive: boolean
  onSelect: (id: string) => void
  // 빈 시간대 선택 상태/핸들러(빈 슬롯 행에서만 의미).
  emptySelected: boolean
  onSelectEmpty: () => void
}) {
  const t = useTranslations("meeting.timeline")
  const showNow = nowTime !== null
  // 빈 슬롯: "비어 있음" 텍스트를 빼고 옅은 시각·점만 남겨 시간축 맥락만 유지(노이즈 제거).
  // 시간 열(w-12)·틱 열(w-1)을 채운 슬롯과 공유해 좌측 시간축이 세로로 정렬되게 한다.
  // 단, 지금이 이 빈칸이면 "지금 HH:MM" 칩 + 프라이머리 틱으로 "지금 여기"를 그 행에 표시(분리선 대신).
  // 빈 슬롯도 선택 가능 — 누르면 그 시간대를 채울 기업 탐색(discover) 안내를 패널/시트에 띄운다.
  if (slot.kind === "empty") {
    return (
      <li>
        <button
          type="button"
          aria-current={emptySelected ? "true" : undefined}
          onClick={onSelectEmpty}
          className={cn(
            "flex w-full items-center gap-3 rounded-md py-1 text-left transition-colors",
            "hover:bg-accent/40 hover:text-foreground",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            emptySelected
              ? "bg-accent/60 text-foreground ring-2 ring-ring/50"
              : showNow
                ? "text-foreground"
                // M-09: 알파 합성 대비가 무너져(35% 알파 → 라이트 모드 실효 1.57:1) 토큰을
                // 아무리 어둡게 해도 최대 2.43:1까지밖에 못 올라간다 — 알파를 없애고 불투명
                // --muted-foreground(라이트 4.74:1, oklch 0.556) 그대로 쓴다.
                : "text-muted-foreground"
          )}
        >
          <time className="w-12 shrink-0 text-right text-xs tabular-nums">
            {slot.time}
          </time>
          <span
            aria-hidden
            className={cn(
              "w-1 shrink-0",
              showNow && "h-3 self-center rounded-full bg-now"
            )}
          />
          {showNow ? (
            <span className="shrink-0 rounded-full bg-now px-2 py-0.5 text-[11px] font-medium text-now-foreground tabular-nums">
              {t("nowLabel", { time: nowTime ?? "" })}
            </span>
          ) : (
            <span aria-hidden className="text-xs leading-none">
              ·
            </span>
          )}
        </button>
      </li>
    )
  }
  // 한 칸에 여러 건이 걸리면(같은 시각으로 A·B·C가 각각 신청) 전부 세로로 쌓는다(#10).
  // 각 건이 독립 버튼이라 수락·거절·취소·회의록이 자기 meetingId로 나간다.
  // 시각(시간축)은 한 칸에 하나뿐이라 대표 건(첫 줄)에만 찍고, 나머지 건은 같은 폭의 빈 열로
  // 들여써 시간축 정렬을 유지한다 — 스택이 아니라 "이 시간에 걸린 것들"로 읽히게.
  const multiple = slot.meetings.length > 1
  return (
    <li>
      <div
        className="flex flex-col gap-1"
        {...(multiple
          ? { role: "group", "aria-label": t("slotMeetingsAria", { count: slot.meetings.length }) }
          : {})}
      >
        {slot.meetings.map((m, i) => {
          const primary = i === 0
          const selected = m.meetingId === selectedId
          return (
            <button
              key={m.meetingId}
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(m.meetingId)}
              // 점유 칸 수(span)만큼 블록을 높여, 가려진 뒤 칸을 블록 안에 흡수한다(빈칸과 겹쳐 보이던 문제).
              // 30분 슬롯 1칸 ≈ 2rem(빈칸 24px+gap 8px) → 좌측 상태 틱이 블록 전체를 덮어 점유 폭이 보인다.
              // 점유는 대표(활성) 건만 한다 — 죽은 건은 뒤 칸을 삼키지 않는다(timeline.ts occupancy).
              style={primary && slot.span > 1 ? { minHeight: `${slot.span * 2}rem` } : undefined}
              className={cn(
                "flex w-full items-stretch gap-3 rounded-md pr-3 text-left transition-colors",
                // 죽은 이력(거절·취소)은 한 줄로 축약 — 활성 건의 높이·가독성을 해치지 않게.
                m.dead ? "py-1" : "py-2",
                "hover:bg-accent/60",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                // 비포커스 기본 표시: 배경만(링 없음) — 명시적 선택과 차별.
                isPreviewing(m.meetingId, selectedId, defaultMeetingId) && "bg-accent/40",
                // 명시적 선택(포커스): 배경 + 링.
                selected && "bg-accent/60 ring-2 ring-ring/50",
                // 진행 중(now가 이 확정 미팅 안): 인디고(now) 링 — 선택(회색 링)과 색으로 구분되는 "지금 여기".
                // 만료/완료 등 비확정 행은 칩(앵커)만 뜨고 링은 없음 → "진행 중"으로 오인 안 됨.
                // 진행 중인 건 대표(확정) 건 하나뿐이라 첫 줄에만 붙인다.
                primary && nowLive && "bg-now/5 ring-1 ring-now/60"
              )}
            >
              {/* 시간축 — 시작 시각 + 점유한 뒤 칸 시각(라벨 유지). 빈 슬롯과 같은 w-12·text-xs로 사이즈 통일.
                  뒤 칸 시각은 슬롯 리듬(2rem)에 맞춰 블록 안에 절대배치 → 미팅이 그 칸들을 덮는다. */}
              <span className="relative w-12 shrink-0 self-stretch">
                {primary && (
                  <>
                    <time className="block pt-0.5 text-right text-xs font-semibold text-foreground tabular-nums">
                      {slot.time}
                    </time>
                    {slot.coveredTimes.map((ct, k) => (
                      <time
                        key={ct}
                        aria-hidden
                        // 점유된(가려진) 시각도 시작 시각과 동일하게 검정·볼드(text-foreground font-semibold) —
                        // 빈 슬롯의 옅은 회색과 달리 "이 시간은 잡힘"을 시간축에서 일관된 한 덩어리로 보이게 한다.
                        className="absolute right-0 pt-0.5 text-right text-xs font-semibold text-foreground tabular-nums"
                        style={{ top: `${(k + 1) * 2}rem` }}
                      >
                        {ct}
                      </time>
                    ))}
                  </>
                )}
              </span>
              {/* 4px 상태 틱 — 유일한 상태색. 행 높이만큼 늘려 블록감. 건마다 자기 상태색을 갖는다. */}
              <span
                aria-hidden
                className={cn(
                  "w-1 shrink-0 self-stretch rounded-full",
                  TICK_BG[m.tone]
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate font-medium",
                    m.dead
                      ? "text-xs text-muted-foreground"
                      : "text-sm text-foreground"
                  )}
                >
                  {m.counterpartName}
                </span>
                {/* 모든 미팅이 "시작–종료"를 동일하게 표시(단일칸 30분도 10:00–10:30) — 멀티슬롯만 시간대가
                    보이고 단일칸은 안 보이던 불일치 제거. 죽은 건은 한 줄 축약이라 시간대를 접는다
                    (시작 시각은 시간축에 이미 있고, 지난 이력의 길이는 판단에 쓰이지 않는다). */}
                {!m.dead && (
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {slot.time}–{m.endTime}
                  </span>
                )}
                {/* 격자 밖 시각(예: 40분/텀5분으로 바뀌기 전에 09:30으로 잡힌 건) — 지우지 않고
                    자기 시각에 그대로 그리되, 운영자가 찾아 고칠 수 있게 표시한다. 색만으로
                    알리지 않도록 문구를 함께 둔다(대비는 text-foreground로 확보). */}
                {primary && slot.offGrid && (
                  <span
                    title={t("offGridHint")}
                    className="mt-1 inline-block rounded-sm border border-status-review px-1 py-px text-[10px] font-medium text-foreground"
                  >
                    {t("offGridBadge")}
                  </span>
                )}
              </span>
              {/* 현재 시각 칩(인디고 앵커) — now가 이 행이면 항상. 상태 라벨과 별개 요소라 겹치지 않는다. */}
              {primary && showNow && (
                <span className="shrink-0 self-center rounded-full bg-now px-2 py-0.5 text-[11px] font-medium text-now-foreground tabular-nums">
                  {t("nowLabel", { time: nowTime ?? "" })}
                </span>
              )}
              {/* 상태 라벨(확정/응답 필요/…)은 진행 중이어도 그대로 유지. */}
              <span
                className={cn(
                  "shrink-0 self-center",
                  m.dead ? "text-[11px]" : "text-xs",
                  isActionNeeded(m)
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {m.label}
              </span>
            </button>
          )
        })}
      </div>
    </li>
  )
}
