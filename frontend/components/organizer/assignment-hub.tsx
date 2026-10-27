"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Minus, Plus, Search, Sparkles, X, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HelpHint } from "@/components/help/help-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { boothLabel, type Organization } from "@/lib/types"
import { BUYER_TYPE_LABELS } from "@/lib/organizer/participant-labels"
import {
  fitFromRecs,
  indexOrgs,
  oppositeCandidates,
  unavailableSets,
  type AssignmentScheduleData,
} from "@/lib/organizer/assignment-schedule"
import {
  createForcedMeeting,
  type AssignmentMeeting,
} from "@/lib/organizer/forced-assignment"
import {
  addConfirmed,
  notifyAssignmentFailure,
  pendingNotYetListed,
  submitAssignments,
  submitForcedAssignment,
} from "@/lib/organizer/forced-assignment-submit"
import { cn } from "@/lib/utils"
import { localIsoWithOffset } from "@/lib/timezone"
import {
  addMinutes,
  buildSlotUniverse,
  slotId,
  slotMeetingsFor,
  slotTimes,
  spanOf,
  type ScheduleSettings,
} from "@/lib/organizer/schedule"
import {
  expandOccupancy,
  freeRunLength,
  isAvailableAt,
  maxRunSlots,
  meetingCountFor,
  mergeConsecutive,
} from "@/lib/organizer/slot-intersection"
import {
  confirmDraft,
  proposeSingleOrgFill,
  singleFillOrderLabel,
  removeDraftMeeting,
  type DraftMeeting,
  type SaturationDraft,
  type SaturationInput,
} from "@/lib/organizer/saturation"
import {
  postSaturationConfirm,
  postSaturationRun,
} from "@/lib/organizer/assignment-actions"
import { refreshAssignmentViews } from "@/lib/organizer/assignment-refresh"
import {
  CandidateRow,
  MeetingChip,
  StatusTag,
  singleFillConfirmNotice,
  toPanelCounterpart,
} from "./assignment-shared"
import { CompanyApplication } from "./company-application"
import { MeetingDetailPanel } from "@/components/meeting/meeting-detail-panel"
import { cancelAssignedMeeting } from "@/lib/organizer/meeting-actions"
import type { MeetingPanelView, PanelMember } from "@/lib/meeting/meeting-panel"
// 내 미팅(MY-001)과 동일한 상태·라벨·액션 산출을 위해 같은 순수 헬퍼를 재사용한다(단일 출처).
import {
  actionsFor,
  isEndedAccepted,
  isExpiredProposed,
  kstTime,
  labelFor,
  toneFor,
} from "@/lib/meeting/timeline"
import { isDeadSlotMeeting, occupyingSlotMeeting } from "@/lib/meeting/slot-pick"
import type { RequestDirection } from "@/lib/home/meeting-status-rollup"
import { koTranslator } from "@/lib/i18n/ko-translator"

type Tab = "exhibitor" | "buyer"

// 운영자 콘솔은 한국어 고정 — 참가자 화면과 공유하는 labelFor에 한국어 번역기를 명시적으로 넘긴다
// (labelFor는 번역기가 필수 인자다. 쿠키 로케일이 en이어도 이 슬라이드의 상태 라벨은 한국어).
const koStatusT = koTranslator("meeting.status")

// 전체 일괄배정 결과가 0건일 때의 안내. 백엔드 규칙(app/matching/assignment_service.create_saturation_run)은
// 활성 미팅이 0건인 참가사·바이어끼리 함께 비는 시간에 짝짓는다 — 모두 이미 미팅이 있으면 0건이 정상이다.
// 운영자가 "고장인가?"가 아니라 다음 행동(⚡·[+])을 알 수 있게 그 규칙을 함께 말한다.
const EMPTY_SATURATION_TITLE = "추가로 배정할 빈 쌍이 없습니다"
const EMPTY_SATURATION_HINT =
  "전체 일괄배정은 아직 미팅이 없는 참가사·바이어끼리 함께 비는 시간에 짝짓습니다. 이미 미팅이 있는 기업은 행의 ⚡(단일 일괄배정)나 빈 슬롯 [+]로 채워 주세요."

interface AssignmentHubProps {
  data: AssignmentScheduleData
  // OP-002 "개별 추천" 딥링크로 들어온 대상 기업 id(사전선택). 그 기업 탭으로 열고 행을 강조한다.
  initialTargetId?: string
  // 현재 시각(KST) — 과거 슬롯을 배정 불가로 제외하는 기준(내 미팅과 동일 방식). 페이지가 주입.
  now: { date: string; time: string }
}

/// n칸을 이은 미팅 1건의 **스팬**(분) = (n-1) * stride + slotMinutes. 마지막 칸 뒤의 텀은 미팅에
/// 포함되지 않는다(백엔드 slot_grid.validate_slot_run 의 스팬 정의 = 마지막 칸 end − 첫 칸 start 와
/// 동일). spanOf 의 역함수다.
///
/// ⚠ 스테퍼는 반드시 이 값으로 움직여야 한다. `v ± slotMinutes` 로 걸으면 40분/텀5분 격자에서
/// 40 → 80 → 120 이 되는데, 실제 2칸 스팬은 85분이다. 그러면 화면은 "10:00 ~ 11:20" 을 보여주는데
/// 백엔드에는 2칸(10:00~11:25)이 저장되어 **표시와 저장이 어긋난다** — 10:00~10:30 배정이
/// 10:00~10:45 로 저장되던 QA 지적(B1/B2)과 같은 종류의 사고다(mt003gap0001).
/// slotGapMinutes=0 이면 stride===slotMinutes 라 n * slotMinutes 로 줄어 구동작과 동일하다.
function spanForSlots(slotCount: number, settings: ScheduleSettings): number {
  const stride = settings.slotMinutes + settings.slotGapMinutes
  if (slotCount <= 1 || stride <= 0) return settings.slotMinutes
  return (slotCount - 1) * stride + settings.slotMinutes
}

export function AssignmentHub({
  data,
  initialTargetId,
  now,
}: AssignmentHubProps) {
  const th = useTranslations("help.hints")
  const router = useRouter()
  const byId = useMemo(() => indexOrgs(data), [data])
  const targetOrg = initialTargetId ? byId[initialTargetId] : undefined

  const [tab, setTab] = useState<Tab>(
    targetOrg?.role === "buyer" ? "buyer" : "exhibitor"
  )
  const [dateId, setDateId] = useState(data.dates[0]?.id ?? "")
  const [meetings, setMeetings] = useState<AssignmentMeeting[]>(data.meetings)
  // 서버 진실 채택(QA B4) — 저장 후 router.refresh()로 서버가 새 meetings를 내려주면 낙관적 목록을
  // 그걸로 **교체**한다. 안 그러면 useState 초기값이 마운트 때 한 번 박혀, 화면은 영원히 낙관적
  // 추정치(예: 수락대기)를 들고 있고 서버 진실(확정·실제 id·다른 운영자의 배정)과 갈라진다.
  // 렌더 중 prop 변화에 맞춰 state를 조정하는 표준 패턴(React "Adjusting state when props change").
  const [serverMeetings, setServerMeetings] = useState(data.meetings)
  if (serverMeetings !== data.meetings) {
    setServerMeetings(data.meetings)
    setMeetings(data.meetings)
  }
  // 저장 중(서버 2xx 전) 낙관적 미팅 — 확정 목록(meetings)과 **따로** 든다(2026-10-01). 저장은 5~6초
  // 걸리고 운영자는 그 사이 다른 칸을 계속 배정한다. 예전엔 낙관적 미팅도 meetings에 섞여 있어, 먼저
  // 끝난 저장의 router.refresh가 서버 목록으로 meetings를 통째로 교체하면 아직 저장 중인 칸이 빈 칸
  // [+]로 되살아나 같은 배정을 다시 누를 수 있었다(중복 제출). 이 목록은 서버 진실 채택(위)이 건드리지
  // 않는다 — 성공하면 meetings로 옮기고, 실패하면 여기서 빼는 것이 곧 롤백이다.
  const [saving, setSaving] = useState<AssignmentMeeting[]>([])
  // 같은 쌍·같은 시각을 저장 중에 또 보내지 않게 하는 즉시 가드(렌더를 기다리지 않는다).
  const inFlightIds = useRef(new Set<string>())
  // ⚡ 배치마다 낙관적 id가 겹치지 않게 하는 일련번호(저장 중 배치가 둘 이상일 수 있다).
  const fillBatchSeq = useRef(0)
  // 일괄배정 실행 설정(배정 시간대 window·최소 보장 N). 타임테이블 기준(행사 운영시간·base 슬롯)은
  // data.settings 고정 — settings.startTime/endTime은 "이번 배정이 채울 시간대"일 뿐 그리드를 안 바꾼다.
  // (base slotMinutes·lunch는 행사값 그대로 유지, 다이얼로그에서 안 건드림.)
  const [settings, setSettings] = useState<ScheduleSettings>(data.settings)
  // 회의 1건이 차지할 길이(분). 타임라인 base 슬롯(settings.slotMinutes, 고정)과 독립 — 이 값만 바꿔도
  // 그리드 기준은 안 바뀌고 회의가 몇 base 슬롯을 차지할지만 바뀐다(30/60/90 = 1/2/3칸).
  const [assignMinutes, setAssignMinutes] = useState(data.settings.slotMinutes)
  const [runNumber, setRunNumber] = useState(0)
  const [draft, setDraft] = useState<SaturationDraft | null>(null)

  // 시트/다이얼로그
  const [slotTarget, setSlotTarget] = useState<{
    org: Organization
    slot: string
  } | null>(null)
  // 지금 만들 미팅의 길이(분) — 운영자가 시트에서 "10:00~11:00"처럼 범위를 늘린다(QA B5).
  // 그리드 칸 간격의 배수(1/2/3칸 = 30/60/90분)만 허용한다. 시트를 열 때마다 한 칸으로 초기화.
  const [forcedMinutes, setForcedMinutes] = useState(data.settings.slotMinutes)
  const [counterpartQuery, setCounterpartQuery] = useState("")
  const [fillPreview, setFillPreview] = useState<{
    org: Organization
    drafts: DraftMeeting[]
  } | null>(null)
  const [saturationOpen, setSaturationOpen] = useState(false)
  // 전체 일괄배정 서버 계산 대기 중 — 설정 다이얼로그는 이미 닫혀 있으므로 우상단 버튼이 진행을 보여준다.
  const [saturationRunning, setSaturationRunning] = useState(false)
  // 마지막 전체 일괄배정이 새 쌍 0건이었던 run 번호 — 그리드 위에 결과를 남긴다(runSaturation 주석).
  const [emptyRunNumber, setEmptyRunNumber] = useState<number | null>(null)
  // 검색·필터(기업이 많아 행을 좁힌다) + 배정된 셀 클릭 시 상대 기업 상세 슬라이드.
  const [query, setQuery] = useState("")
  const [onlyShort, setOnlyShort] = useState(false) // 배정 부족(보장 N 미만 — 미배정 0건 포함)
  const [onlyPending, setOnlyPending] = useState(false) // 수락대기(proposed) 보유
  const [detail, setDetail] = useState<{
    meeting: AssignmentMeeting
    rowOrg: Organization
  } | null>(null)

  // 서버 저장(POST) 진행 표시 — 확정/실행 버튼 잠금. 낙관적 업데이트라 화면은 먼저 바뀐다.
  const [isPending, startTransition] = useTransition()

  const reviewing = draft !== null // 전체 포화 Draft 검토 중 — 다른 배정 액션은 잠근다
  const fit = useMemo(() => fitFromRecs(data.recsByOrgId), [data])
  // 기업별 "불가" 슬롯(신청 때 지정) — 배정·후보에서 제외. 그리드엔 "불가"로 표시.
  const unavailable = useMemo(
    () => unavailableSets(data.unavailableByOrgId),
    [data]
  )
  // 그리드 열(슬롯 시각) = 행사(event) 운영시간에서 파생, 고정. 일괄배정 다이얼로그의 배정 시간대(settings)와
  // 무관 — 타임테이블은 항상 행사 운영시간(data.settings)을 본다. 점심 블록 제외.
  const columns = useMemo(() => slotTimes(data.settings), [data.settings])
  // 과거 슬롯은 배정 불가(내 미팅과 동일): 슬롯 시작이 현재 시각 이전이면 제외한다.
  const nowKey = `${now.date} ${now.time}`
  const isPastSlot = (time: string) => `${dateId} ${time}` < nowKey
  // 지금 시간 라인 — 오늘이면 "아직 안 끝난 첫 슬롯"(종료 시각 > 현재)에 세로 라인. 진행 중 슬롯을
  // 다음 칸으로 넘기지 않는다(14:32면 14:30 슬롯에 라인). 하루가 끝났으면 라인 없음(null).
  const isToday = now.date === dateId
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number)
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
  }
  const nowMin = toMin(now.time)
  const nowLineTime = isToday
    ? (columns.find((t) => toMin(t) + settings.slotMinutes > nowMin) ?? null)
    : null
  // 저장 중 미팅 중 아직 서버 목록에 안 들어온 것 — 화면에 "저장 중"으로 그리고 칸을 잠근다.
  const pendingShown = useMemo(
    () => pendingNotYetListed(saving, meetings),
    [saving, meetings]
  )
  const savingIds = useMemo(
    () => new Set(pendingShown.map((m) => m.id)),
    [pendingShown]
  )
  // 저장 중 미팅이 걸린 기업 — 그 기업의 ⚡ 보충을 저장이 끝날 때까지 잠근다.
  const savingOrgIds = useMemo(
    () => new Set(pendingShown.flatMap((m) => [m.exhibitorId, m.buyerId])),
    [pendingShown]
  )
  // 같은 상대가 연달아 잡힌 슬롯은 한 블록으로 합쳐 렌더·점유한다(멀티 시간 선택 대체).
  // 저장 중 건은 확정 건과 섞어 병합하지 않는다 — 병합 블록은 첫 미팅의 신원을 따르므로, 섞이면
  // 저장 중 칸이 "확정"으로(또는 그 반대로) 보인다.
  const merged = useMemo(
    () => [
      ...mergeConsecutive(meetings, settings.slotMinutes, settings.slotGapMinutes),
      ...mergeConsecutive(pendingShown, settings.slotMinutes, settings.slotGapMinutes),
    ],
    [meetings, pendingShown, settings]
  )
  // 멀티슬롯 점유를 펼친 목록(빈슬롯 판정 공용) — 병합본 기준, **살아있는 건만**.
  // 거절·취소는 칸을 잡지 않는다(#10 규칙, 백엔드 slot_booking._OCCUPYING과 같은 방향) — 예전엔
  // 죽은 이력이 여기 섞여 그 칸의 상대 후보가 통째로 사라지고 [+]도 안 떴다(QA 지적 A).
  const expanded = useMemo(
    () =>
      expandOccupancy(
        merged.filter((m) => !isDeadSlotMeeting(m.status)),
        settings.slotMinutes,
        settings.slotGapMinutes
      ),
    [merged, settings]
  )
  // 이 날짜에 실제로 배정 가능한 칸 집합(그리드 열 ∩ 미래) — 멀티슬롯 길이가 하루 끝·점심을 넘지
  // 않게 막는 경계다. 연속 판정은 시각 산술로 하므로(freeRunLength) 목록이 아니라 집합으로 넘긴다.
  const assignableSlots = useMemo(
    () =>
      new Set(
        columns
          .filter((t) => `${dateId} ${t}` >= nowKey)
          .map((t) => slotId(dateId, t))
      ),
    [columns, dateId, nowKey]
  )
  // 배정 가능한 슬롯 유니버스 = 이번 배정 시간대(settings.startTime~endTime) ∩ 미래(과거 제외).
  // base 슬롯·점심은 행사값 그대로. 다이얼로그에서 시간대를 좁히면 그 창 안에서만 배정된다(그리드 열은 불변).
  const allSlotIds = useMemo(
    () =>
      buildSlotUniverse(
        data.dates.map((d) => d.id),
        settings
      )
        .filter((s) => `${s.dateId} ${s.time}` >= nowKey)
        .map((s) => s.id),
    [data, settings, nowKey]
  )

  // 행(기업) 필터 — 이름 검색 + 빈 슬롯 보유 + 미배정.
  const baseRows = tab === "exhibitor" ? data.exhibitors : data.buyers
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return baseRows.filter((org) => {
      if (q && !org.name.toLowerCase().includes(q)) return false
      // 배정 부족 = 보장 슬롯 N 미만(미배정 0건 포함). 누구부터 채울지 찾는 핵심 신호.
      if (onlyShort && meetingCountFor(org.id, merged) >= settings.minSlots)
        return false
      // 수락대기 보유 = proposed(받는 쪽 응답 대기) 미팅이 있는 기업.
      if (
        onlyPending &&
        !merged.some(
          (m) =>
            (m.exhibitorId === org.id || m.buyerId === org.id) &&
            m.status === "proposed"
        )
      ) {
        return false
      }
      return true
    })
  }, [baseRows, query, onlyShort, onlyPending, merged, settings.minSlots])

  function buildInput(existing: AssignmentMeeting[]): SaturationInput {
    return {
      exhibitors: data.exhibitors,
      buyers: data.buyers,
      fit,
      applicationOrder: data.applicationOrder,
      allSlotIds,
      // 멀티슬롯(연속) 미팅의 뒤 칸까지 점유로 펼쳐, 빈슬롯 보충이 거기 겹치지 않게 한다.
      existing: expandOccupancy(existing, settings.slotMinutes, settings.slotGapMinutes),
      unavailable, // 각 기업이 신청 때 불가로 둔 슬롯은 배정 제외
      assignMinutes, // 배정 회의 1건이 차지할 길이(base 슬롯 여러 칸) — 그리드 기준과 독립
    }
  }

  // 한 칸(기업 × 슬롯)에서 **뒤 칸을 점유**하는 건(colSpan 기준). 확정 미팅이 있으면 그 칸의 대표,
  // 없으면 Draft의 대표. 죽은 이력(거절·취소)만 남은 칸은 아무것도 점유하지 않는다 — 90분짜리 거절이
  // 뒤의 빈 칸을 삼켜 배정 가능한 자리를 감추던 잠재 버그 차단(#10, 내 미팅 타임라인과 동일 규칙).
  // 칸의 미팅 목록 자체는 slotMeetingsFor가 표시 순서(활성 위/죽은 것 아래)로 돌려준다 — 참가자
  // 타임라인과 같은 유틸(slot-pick)을 공유하고, 서버 정렬(created_at 오름차순) 뒤집기도 거기서 한다.
  function occupierAt(orgId: string, slot: string) {
    const live = slotMeetingsFor(merged, orgId, slot)
    const source =
      live.length > 0 ? live : draft ? slotMeetingsFor(draft.meetings, orgId, slot) : []
    return occupyingSlotMeeting(source)
  }
  function counterpartOf(
    m: AssignmentMeeting,
    rowOrg: Organization
  ): Organization | undefined {
    return rowOrg.role === "exhibitor" ? byId[m.buyerId] : byId[m.exhibitorId]
  }
  function slotLabel(slot: string): string {
    const [d, t] = slot.split("T")
    return `${data.dates.find((x) => x.id === d)?.label ?? d} ${t}`
  }

  // 배정된 셀 클릭 → 상대 기업 상세 슬라이드. 내 미팅(MY-001) 팝업과 100% 동일 — 같은 MeetingDetailPanel에
  // 같은 순수 헬퍼(labelFor·toneFor·actionsFor·expired/ended)로 만든 view를 넣는다. viewer=행의 기업 관점.
  function panelViewFor(
    m: AssignmentMeeting,
    rowOrg: Organization
  ): MeetingPanelView | null {
    const cp = counterpartOf(m, rowOrg)
    if (!cp) return null
    // "2026-09-16T14:30"(행사 로컬 벽시계) → ISO(행사 timeZone 오프셋). kst*·expired 판정 입력.
    // ⚠ +09:00 고정은 쓰지 않는다 — data.timezone이 KST가 아니면(베트남 등) 만료 판정이 몇 시간
    // 어긋난다(H5/P0-2, timezone-analysis.md §1.4). data.timezone 미지정(mock)은 Asia/Seoul 폴백.
    const scheduledAt = localIsoWithOffset(m.slotId, data.timezone ?? "Asia/Seoul")
    // 신청 방향(내 미팅 정합): 요청 주체가 이 행 기업이면 '내가 신청', 아니면 '상대가 신청'. 없으면 상대(received).
    const direction: RequestDirection =
      m.requestedByOrgId === rowOrg.id ? "sent" : "received"
    const attended = m.attended ?? true
    const expired = isExpiredProposed(m.status, scheduledAt, now)
    const ended = isEndedAccepted(m.status, scheduledAt, m.durationMinutes, now)
    const rec = (data.recsByOrgId[rowOrg.id] ?? []).find(
      (r) => r.org.id === cp.id
    )
    const usC = data.contactsByOrgId[rowOrg.id]
    const themC = data.contactsByOrgId[cp.id]
    const members: PanelMember[] = []
    if (usC) members.push({ side: "us", name: usC.name, title: usC.title })
    if (themC)
      members.push({ side: "them", name: themC.name, title: themC.title })
    const time = kstTime(scheduledAt)
    return {
      meetingId: m.id,
      status: m.status,
      tone: expired
        ? "gray"
        : toneFor(m.status, { attended, hasReview: m.hasReview, ended }),
      statusLabel: expired
        ? "응답 시간 지남"
        : labelFor(
            m.status,
            direction,
            {
              attended,
              hasReview: m.hasReview,
              ended,
            },
            koStatusT,
          ),
      reviewDone: m.status === "completed" && attended && !!m.hasReview,
      direction,
      directionLabel: direction === "sent" ? "내가 신청" : "상대가 신청",
      time,
      endTime: addMinutes(time, m.durationMinutes ?? settings.slotMinutes),
      // 장소 라벨이 없는 건 = 서버 목록이 아직 안 내려온 방금 저장한 미팅(또는 장소 없는 옛 데이터).
      // 장소는 서버가 정책대로 정하므로(기본: 참가사 부스, 2026-10-01) 여기서 특정 유형을 지어내지
      // 않는다 — 예전 폴백 "비즈매칭존 테이블"은 부스 정책에서 틀린 안내였다(리뷰 L6).
      venue: m.venue ?? "장소 확인 중",
      // 조직자 슬라이드는 조회용이라 "회의록" 액션은 뺀다 — 그 액션은 /meetings/[id]로 가는데 조직자는
      // 거기서 리다이렉트로 튕겨나기 때문(codex review P1). 수락/거부/취소는 유지.
      actions: expired
        ? []
        : actionsFor(m.status, direction, rowOrg.role, attended).filter(
            (a) => a !== "review"
          ),
      counterpart: toPanelCounterpart(cp),
      // 상대 기업 원본 + 관점(행 기업). 조직자 슬라이드는 hideDetailLink로 "기업 상세 보기" 모달을
      // 숨기므로 org·viewerRole은 실제로 모달을 열진 않지만, MeetingPanelView 계약상 채워둔다.
      org: cp,
      viewerRole: rowOrg.role,
      match: rec ? { score: rec.aiScore, reasons: rec.aiReasons } : null,
      members,
      detailHref: `/organizer/members/${cp.id}`,
    }
  }

  // 저장이 끝난 뒤 화면들을 서버 진실로 맞춘다(QA B4).
  //  · router.refresh() — 이 화면을 서버에서 다시 그려 낙관적 목록을 실제 미팅으로 교체(위 채택 로직).
  //  · refreshAssignmentViews() — 참가기업 관리·기업 상세·참가자 화면의 Client Cache 무효화.
  // 서버 액션이 실패해도(네트워크 등) 배정 자체는 이미 저장됐으므로 화면을 막지 않고 삼킨다.
  function syncAfterWrite() {
    void refreshAssignmentViews().catch(() => {})
    router.refresh()
  }

  // 저장 중 목록에서 빼고 확정 목록으로 옮긴다(서버 2xx 확정 후에만 부른다).
  function promoteSaved(saved: AssignmentMeeting[]) {
    const ids = new Set(saved.map((m) => m.id))
    setSaving((prev) => prev.filter((m) => !ids.has(m.id)))
    setMeetings((prev) => addConfirmed(prev, saved))
  }

  // ── Forced 배정(빈 슬롯 시트에서 상대 선택) ──────────────────────────────────
  // 낙관적 업데이트: 화면에 "저장 중"으로 먼저 반영(그 칸은 잠긴다) → POST 저장 → 서버가 2xx로 확정한
  // **뒤에만** 확정 표시 + 성공 토스트. 실패 시 롤백 + 원인별 토스트(예전엔 응답 전에 성공 토스트가
  // 먼저 뜨고, 실패하면 이유와 무관하게 "네트워크 확인"이라고 했다 — 2026-10-01 고객 신고).
  function assignForced(
    rowOrg: Organization,
    candidate: Organization,
    slot: string,
    durationMinutes: number
  ) {
    const buyer = rowOrg.role === "buyer" ? rowOrg : candidate
    const exhibitor = rowOrg.role === "exhibitor" ? rowOrg : candidate
    try {
      // 길이는 항상 명시해서 보낸다 — 받는 쪽(API 라우트)이 "미지정=한 칸" 폴백을 타지 않게 해
      // scheduled_end가 언제나 시작 + 고른 시간으로 저장된다(QA B1/B2).
      const m = createForcedMeeting(
        buyer,
        exhibitor,
        slot,
        `forced-${buyer.id}-${exhibitor.id}-${slot}`,
        durationMinutes
      )
      // 같은 쌍·같은 시각이 이미 저장 중이면 다시 보내지 않는다(중복 제출 차단).
      if (inFlightIds.current.has(m.id)) return
      inFlightIds.current.add(m.id)
      setSaving((prev) => [...prev, m])
      setSlotTarget(null)
      setCounterpartQuery("")
      const startTime = slot.slice(slot.indexOf("T") + 1)
      startTransition(async () => {
        const ok = await submitForcedAssignment(m, setSaving, () => router.push("/login"), {
          partiesOf: () => ({ exhibitorName: exhibitor.name, buyerName: buyer.name }),
          onResync: syncAfterWrite,
        })
        inFlightIds.current.delete(m.id)
        if (!ok) return
        promoteSaved([m])
        toast(`${exhibitor.name} ↔ ${buyer.name} 배정`, {
          description: `${startTime}~${addMinutes(startTime, durationMinutes)} · 운영자 배정은 즉시 확정`,
        })
        syncAfterWrite()
      })
    } catch (e) {
      toast("배정할 수 없어요", {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // ── 단일 일괄배정([⚡]) — 미리보기 후 확정 ──────────────────────────────────
  function openSingleFill(org: Organization) {
    const drafts = proposeSingleOrgFill(
      org.id,
      buildInput(merged),
      settings,
      runNumber + 1
    )
    if (drafts.length === 0) {
      toast(`${org.name} 빈 슬롯을 채울 후보가 없어요`, {
        description: "이미 다 찼거나 가능한 상대가 없습니다",
      })
      return
    }
    setFillPreview({ org, drafts })
  }
  // ⚡ 확정도 강제 배정과 같은 규칙 — 저장 중 표시·잠금 → 2xx 뒤에만 성공 토스트 → 실패 시 롤백 +
  // 원인별 토스트. 배치는 앞에서부터 저장하다 실패한 곳에서 멈추므로(BFF), 일부가 이미 저장됐으면
  // "N건 중 M건만"이라고 말하고 서버 진실로 다시 그린다(롤백만 하면 저장된 건이 화면에서 사라진다).
  function confirmSingleFill() {
    if (!fillPreview) return
    fillBatchSeq.current += 1
    const batch = fillBatchSeq.current
    const orgName = fillPreview.org.name
    const withIds = fillPreview.drafts.map((d, i) => ({
      ...d,
      id: `fill-${batch}-${i}`,
    }))
    setSaving((prev) => [...prev, ...withIds])
    setFillPreview(null)
    startTransition(async () => {
      const ok = await submitAssignments(withIds, setSaving, {
        onSessionExpired: () => router.push("/login"),
        partiesOf: (m) => ({
          exhibitorName: byId[m.exhibitorId]?.name,
          buyerName: byId[m.buyerId]?.name,
        }),
        failureTitle: (r) =>
          r.savedCount
            ? `${orgName} 빈 슬롯 ${withIds.length}건 중 ${r.savedCount}건만 배정됐어요`
            : undefined,
        onResync: syncAfterWrite,
      })
      if (!ok) return
      promoteSaved(withIds)
      toast(`${orgName} 빈 슬롯 ${withIds.length}건 배정`, {
        description: "출처: AI 매칭",
      })
      syncAfterWrite()
    })
  }

  // ── 전체 일괄배정(우상단) — Draft 생성(서버 계산) → 그리드 위 검토 → 확정/폐기 ─────
  // Draft 계산은 POST /api/organizer/saturation — 서버 진실(확정 store 포함) 기준으로 돌린다.
  // 실 배정 엔진이 backend 소관(ADR-0006)이라 계산 위치를 서버로 옮겨 그 자리를 예약한다.
  //
  // 결과가 0건(새로 짝지을 쌍 없음)이면 토스트만으로는 놓친다 — 몇 초 뒤 사라져 운영자가 "실행이
  // 됐는지"조차 알 수 없었다(2026-10-01 E2E: 200 count:0인데 화면 변화 없음). 그래서 다음 실행 전까지
  // 그리드 위에 결과 안내를 남기고, 실행 중엔 우상단 버튼을 "실행 중…"으로 잠근다.
  function runSaturation() {
    const next = runNumber + 1
    setRunNumber(next)
    setSaturationOpen(false)
    setEmptyRunNumber(null)
    setSaturationRunning(true)
    startTransition(async () => {
      const result = await postSaturationRun({
        settings,
        assignMinutes,
        runNumber: next,
        now,
      })
      setSaturationRunning(false)
      if (!result.success || !result.draft) {
        // 실패 이유는 원인별로(네트워크 문구는 진짜 네트워크 실패일 때만 — describeAssignmentError).
        notifyAssignmentFailure(result, {
          onSessionExpired: () => router.push("/login"),
          title: "포화배정 실행에 실패했어요",
        })
        return
      }
      if (result.draft.meetings.length === 0) {
        // run 번호는 서버 값(권위, saturation BFF가 백엔드 run_number로 덮어쓴다) — Draft 배너와 같다.
        setEmptyRunNumber(result.draft.runNumber)
        toast(EMPTY_SATURATION_TITLE, {
          description: `전체 포화배정 run #${result.draft.runNumber} — ${EMPTY_SATURATION_HINT}`,
        })
        return
      }
      setDraft(result.draft)
      toast(`전체 포화배정 실행 (run #${next})`, {
        description: `Draft ${result.draft.meetings.length}건 — 검토 후 확정하세요`,
      })
    })
  }
  function confirmSaturation() {
    if (!draft) return
    const reviewedDraft = draft
    const confirmed = confirmDraft(reviewedDraft)
    // 강제·⚡와 같은 규칙 — 저장 중으로 먼저 보이고, 성공 문구는 서버 2xx 뒤에만.
    setSaving((prev) => [...prev, ...confirmed])
    setDraft(null)
    startTransition(async () => {
      const result = await postSaturationConfirm(confirmed)
      if (!result.success) {
        // 롤백: 발효 취소 + Draft 검토 상태 복원(검토 작업을 잃지 않게).
        const ids = new Set(confirmed.map((m) => m.id))
        setSaving((prev) => prev.filter((m) => !ids.has(m.id)))
        setDraft(reviewedDraft)
        notifyAssignmentFailure(result, {
          onSessionExpired: () => router.push("/login"),
          title: "Draft 확정 저장에 실패했어요",
        })
        return
      }
      promoteSaved(confirmed)
      syncAfterWrite()
      if (result.skippedCount) {
        // 실세션 부분성공(backend confirm이 항목별로 슬롯/장소 충돌을 스킵) — 확정/스킵 개수를 알린다.
        // "N건 확정"을 따로 먼저 띄우지 않는다(스킵이 있으면 그 숫자가 틀린 성공 문구가 된다).
        toast(
          `확정 ${result.confirmedCount ?? 0}건 · 충돌로 제외 ${result.skippedCount}건`,
          {
            description:
              "제외된 항목은 슬롯/장소가 그 사이 다른 미팅에 쓰였어요.",
          }
        )
        return
      }
      toast(
        `Draft ${reviewedDraft.meetings.length}건 확정 (run #${reviewedDraft.runNumber})`
      )
    })
  }
  function discardSaturation() {
    setDraft(null)
    toast("Draft 폐기 — 발효되지 않았습니다")
  }

  // 이번 배정에 고를 수 있는 최대 칸 수 — 행 기업이 그 시각부터 연달아 비어 있는 만큼(최대 3칸=90분).
  // 시트의 시간 스테퍼 상한이자, 하루 끝·점심·다음 미팅을 넘어서는 길이를 애초에 못 고르게 하는 경계.
  const maxForcedSlots = useMemo(() => {
    if (!slotTarget) return 1
    return Math.max(
      1,
      freeRunLength({
        orgId: slotTarget.org.id,
        startSlotId: slotTarget.slot,
        slotMinutes: settings.slotMinutes,
        slotGapMinutes: settings.slotGapMinutes,
        daySlots: assignableSlots,
        meetings: expanded,
        unavailable,
        maxMeetingMinutes: settings.maxMeetingMinutes,
      })
    )
  }, [slotTarget, settings, assignableSlots, expanded, unavailable])
  const forcedSpan = spanOf(forcedMinutes, settings.slotMinutes, settings.slotGapMinutes)
  // 일괄배정 "회의 길이" 스테퍼의 현재 칸 수와 상한. 상한은 행사 설정(max_meeting_minutes)에서
  // 역산한다 — 30/60/90 리터럴을 박아두면 40분/텀5분 격자에서 90분이 3칸(스팬 130분)으로 환산돼
  // 백엔드 validate_slot_run 에 422로 튕긴다(mt003gap0001). forcedSpan 과 같은 spanOf 를 쓴다.
  const assignSpan = spanOf(assignMinutes, settings.slotMinutes, settings.slotGapMinutes)
  const maxAssignSlots = useMemo(
    () =>
      maxRunSlots(
        settings.maxMeetingMinutes,
        settings.slotMinutes,
        settings.slotGapMinutes
      ),
    [settings.maxMeetingMinutes, settings.slotMinutes, settings.slotGapMinutes]
  )
  // 시트에 보여줄 "10:00 ~ 11:00" 범위 — 끝 시각은 시작 + 고른 길이(저장되는 scheduled_end와 같은 값).
  const forcedRange = useMemo(() => {
    if (!slotTarget) return null
    const start = slotTarget.slot.slice(slotTarget.slot.indexOf("T") + 1)
    return { start, end: addMinutes(start, forcedMinutes) }
  }, [slotTarget, forcedMinutes])

  // 빈 슬롯 시트 후보: **고른 시간 범위 전체**가 비어있는 반대편 기업(이름순, #6 비-AI 폴백) + 검색.
  // 60/90분을 고르면 뒤 칸까지 비어 있어야 후보로 남는다 — 상대가 뒷칸에 이미 미팅이 있으면
  // 배정해도 백엔드가 슬롯 겹침으로 되돌리기 때문(slot_booking.has_overlap).
  const candidates = useMemo(() => {
    if (!slotTarget) return []
    const q = counterpartQuery.trim().toLowerCase()
    return oppositeCandidates(data, slotTarget.org.role)
      .filter(
        (r) =>
          freeRunLength({
            orgId: r.org.id,
            startSlotId: slotTarget.slot,
            slotMinutes: settings.slotMinutes,
            slotGapMinutes: settings.slotGapMinutes,
            daySlots: assignableSlots,
            meetings: expanded,
            unavailable,
            maxSlots: forcedSpan,
          }) >= forcedSpan
      )
      .filter((r) => !q || r.org.name.toLowerCase().includes(q))
  }, [
    slotTarget,
    counterpartQuery,
    data,
    expanded,
    unavailable,
    assignableSlots,
    settings.slotMinutes,
    settings.slotGapMinutes,
    forcedSpan,
  ])

  const oppositeLabel = tab === "exhibitor" ? "바이어" : "참가사"

  return (
    <div className="flex w-full flex-col gap-4">
      {targetOrg && (
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">
            OP-002에서 선택한 기업:{" "}
          </span>
          <span className="font-medium">{targetOrg.name}</span>
          <span className="text-muted-foreground">
            {" "}
            — 아래에서 강조된 행의 빈 슬롯을 눌러 배정하세요
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="line" data-tour="fm-tabs">
            <TabsTrigger value="exhibitor">참가사</TabsTrigger>
            <TabsTrigger value="buyer">바이어</TabsTrigger>
          </TabsList>
        </Tabs>
        <HelpHint hint={th("fmRun")} side="bottom">
          <Button
            onClick={() => setSaturationOpen(true)}
            disabled={reviewing || saturationRunning}
            aria-busy={saturationRunning || undefined}
            data-tour="fm-run"
          >
            <Sparkles data-icon="inline-start" />
            {saturationRunning ? "일괄배정 실행 중…" : "전체 일괄배정"}
          </Button>
        </HelpHint>
      </div>

      {/* 날짜 선택(행사기간) */}
      <div className="flex flex-wrap gap-1.5">
        {data.dates.map((d) => (
          <Button
            key={d.id}
            size="sm"
            variant={d.id === dateId ? "default" : "outline"}
            onClick={() => setDateId(d.id)}
          >
            {d.label} ({d.weekday})
          </Button>
        ))}
      </div>

      {/* 검색(상단) + 필터(검색바 아래) — 기업이 많아 행을 좁힌다 */}
      <div className="flex flex-col gap-2" data-tour="fm-filters">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder={`${tab === "exhibitor" ? "참가사" : "바이어"} 이름 검색`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={onlyShort ? "default" : "outline"}
            aria-pressed={onlyShort}
            title={`보장 슬롯(${settings.minSlots}) 미만 — 미배정 포함`}
            onClick={() => setOnlyShort((v) => !v)}
          >
            배정 부족
          </Button>
          <Button
            type="button"
            size="sm"
            variant={onlyPending ? "default" : "outline"}
            aria-pressed={onlyPending}
            title="받는 쪽 응답 대기(proposed) 미팅 보유"
            onClick={() => setOnlyPending((v) => !v)}
          >
            수락대기 보유
          </Button>
          {(onlyShort || onlyPending || query) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                setQuery("")
                setOnlyShort(false)
                setOnlyPending(false)
              }}
            >
              초기화
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {rows.length}개 기업
          </span>
        </div>
      </div>

      {/* 전체 일괄배정 결과 0건 — 다음 실행 전까지 남는 안내(토스트는 몇 초 뒤 사라진다) */}
      {emptyRunNumber !== null && !draft && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3"
        >
          <div className="text-sm">
            <span className="font-medium">{EMPTY_SATURATION_TITLE}</span>
            <span className="text-muted-foreground">
              {" "}
              · 전체 포화배정 run #{emptyRunNumber} — {EMPTY_SATURATION_HINT}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEmptyRunNumber(null)}
          >
            닫기
          </Button>
        </div>
      )}

      {/* 전체 포화 Draft 검토 배너 */}
      {draft && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-foreground/40 bg-muted/40 px-4 py-3">
          <div className="text-sm">
            <span className="font-medium">Draft {draft.meetings.length}건</span>
            <span className="text-muted-foreground">
              {" "}
              · 전체 포화배정 run #{draft.runNumber} · 점선 셀을 검토하세요(셀
              ✕로 제외)
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={discardSaturation}
              disabled={isPending}
            >
              폐기
            </Button>
            <Button size="sm" onClick={confirmSaturation} disabled={isPending}>
              확정
            </Button>
          </div>
        </div>
      )}

      {/* 스케줄 매트릭스(기업 × 슬롯) — 가로 스크롤, 첫 열 고정 */}
      <div className="overflow-x-auto rounded-lg border" data-tour="fm-grid">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/40">
              <th className="sticky left-0 z-20 min-w-[160px] border-r border-b bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground">
                기업
              </th>
              {columns.map((t) => (
                <th
                  key={t}
                  title={
                    t === nowLineTime ? `현재 시각 ${now.time}` : undefined
                  }
                  className={cn(
                    "min-w-[96px] border-b px-2 py-2 text-center text-xs font-medium text-muted-foreground tabular-nums",
                    isPastSlot(t) && "text-muted-foreground/35", // 지난 시간 열은 흐리게(배정 불가)
                    t === nowLineTime &&
                      "border-l-2 [border-left-color:var(--now)]" // 지금 시간 세로 라인만(왼쪽 테두리만 색 — 아래 테두리 안 물들게)
                  )}
                >
                  {t === nowLineTime ? (
                    <span className="flex flex-col items-center leading-tight">
                      {/* 세로 라인 위에 현재 시각 라벨(가로줄 없이 라인만 유지) */}
                      <span
                        className="text-[10px] font-semibold"
                        style={{ color: "var(--now)" }}
                      >
                        지금 {now.time}
                      </span>
                      <span>{t}</span>
                    </span>
                  ) : (
                    t
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((org) => {
              // 멀티슬롯(연속) 미팅: 시작칸만 colSpan으로 렌더하고 가려진 뒤 칸은 건너뛴다(내 미팅 동일).
              // 확정 미팅(merged)뿐 아니라 Draft 미팅도 회의 길이만큼 여러 칸을 차지하므로 함께 고려한다.
              const coveredTimes = new Set<string>()
              for (const t of columns) {
                const m = occupierAt(org.id, slotId(dateId, t))
                if (!m) continue
                const sp = spanOf(m.durationMinutes, settings.slotMinutes, settings.slotGapMinutes)
                for (let i = 1; i < sp; i++)
                  coveredTimes.add(addMinutes(t, i * (settings.slotMinutes + settings.slotGapMinutes)))
              }
              return (
                <tr
                  key={org.id}
                  className={
                    org.id === initialTargetId ? "bg-primary/5" : undefined
                  }
                >
                  <th
                    className={`sticky left-0 z-10 min-w-[160px] border-r border-b px-3 py-2 text-left ${
                      org.id === initialTargetId
                        ? "bg-primary/5"
                        : "bg-background"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="min-w-0 truncate text-left font-medium">
                        {org.name}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`${org.name} 단일 일괄배정`}
                        title={
                          savingOrgIds.has(org.id)
                            ? "이 기업 배정을 저장하는 중이에요"
                            : "이 기업 빈 슬롯 자동채움"
                        }
                        // 이 기업이 낀 저장이 끝날 때까지 잠근다 — 서버 확정 전 상태로 보충안을 만들면
                        // 저장이 실패·되돌려질 때 엇갈린다.
                        disabled={reviewing || savingOrgIds.has(org.id)}
                        onClick={() => openSingleFill(org)}
                      >
                        <Zap />
                      </Button>
                    </div>
                    {(boothLabel(org.booth) ||
                      (org.buyerType && BUYER_TYPE_LABELS[org.buyerType])) && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {boothLabel(org.booth) ??
                          (org.buyerType
                            ? BUYER_TYPE_LABELS[org.buyerType]
                            : "")}
                      </span>
                    )}
                  </th>
                  {columns.map((t) => {
                    if (coveredTimes.has(t)) return null // 앞 미팅이 점유한 칸(colSpan으로 흡수)
                    const slot = slotId(dateId, t)
                    const liveList = slotMeetingsFor(merged, org.id, slot)
                    const draftList = draft
                      ? slotMeetingsFor(draft.meetings, org.id, slot)
                      : []
                    // 확정·Draft 모두 회의 길이만큼 colSpan(뒤칸 흡수) — 점유는 죽지 않은 대표 건만
                    // (occupierAt와 같은 규칙을, 이미 손에 든 목록으로 계산).
                    const span = spanOf(
                      occupyingSlotMeeting(
                        liveList.length > 0 ? liveList : draftList
                      )?.durationMinutes,
                      settings.slotMinutes,
                      settings.slotGapMinutes
                    )
                    return (
                      <td
                        key={t}
                        colSpan={span}
                        className={cn(
                          "border-b px-1.5 py-1.5 align-middle",
                          t === nowLineTime &&
                            "border-l-2 [border-left-color:var(--now)]" // 지금 시간 세로 라인만
                        )}
                      >
                        <Cell
                          org={org}
                          liveList={liveList}
                          draftList={draftList}
                          savingIds={savingIds}
                          reviewing={reviewing}
                          past={isPastSlot(t)}
                          unavailable={
                            !isAvailableAt(org.id, slot, unavailable)
                          }
                          counterpartOf={counterpartOf}
                          onAssign={() => {
                            setForcedMinutes(settings.slotMinutes) // 시트는 항상 한 칸에서 시작
                            setSlotTarget({ org, slot })
                          }}
                          onOpenDetail={(m) =>
                            setDetail({ meeting: m, rowOrg: org })
                          }
                          onRemoveDraft={(id) =>
                            setDraft((prev) =>
                              prev ? removeDraftMeeting(prev, id) : prev
                            )
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  조건에 맞는 기업이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        빈 슬롯
        <Plus className="mx-0.5 inline size-3" />을 누르면 미팅 시간을 정하고 그
        시간에 가능한 {oppositeLabel}를 골라 배정합니다(운영자 배정은 즉시 확정).
        취소·거절된 이력만 남은 칸에도 이력 아래에
        <Plus className="mx-0.5 inline size-3" />이 떠서 이력을 지우지 않고 다시
        배정할 수 있어요. 배정된 셀을 누르면 상대 기업 상세가 열립니다.
      </p>

      {/* 빈 슬롯 → 상대 탐색 시트 */}
      <Sheet
        open={!!slotTarget}
        onOpenChange={(open) => {
          if (!open) {
            setSlotTarget(null)
            setCounterpartQuery("")
          }
        }}
      >
        <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>
              {slotTarget
                ? `${slotLabel(slotTarget.slot)} · ${slotTarget.org.name}`
                : ""}
            </SheetTitle>
            <SheetDescription>
              미팅 시간을 정하고, 그 시간에 비어 있는 {oppositeLabel}를 고르면
              바로 배정됩니다(운영자 배정은 즉시 확정). 후보는 이름순이며 AI
              추천은 아직 제공되지 않아요.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            {/* 미팅 시간(범위) — 한 칸(30분)에서 시작해 연속 칸만큼 늘린다. 늘릴 수 있는 한도는
                행 기업이 그 시각부터 연달아 비어 있는 칸 수(maxForcedSlots)가 정한다(QA B5). */}
            {slotTarget && (
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs text-muted-foreground">미팅 시간</span>
                  <span className="truncate text-sm font-medium tabular-nums">
                    {forcedRange
                      ? `${forcedRange.start} ~ ${forcedRange.end}`
                      : ""}{" "}
                    <span className="text-muted-foreground">
                      ({forcedMinutes}분 · {forcedSpan}칸)
                    </span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="미팅 시간 줄이기"
                    disabled={forcedSpan <= 1}
                    onClick={() =>
                      // 칸 수로 움직이고 스팬을 다시 계산한다 — 분에 stride를 더하면 40/80/120이 되어
                      // 실제 스팬(40/85/130)과 어긋난다(spanForSlots 주석 참고).
                      setForcedMinutes(spanForSlots(Math.max(1, forcedSpan - 1), settings))
                    }
                  >
                    <Minus />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="미팅 시간 늘리기"
                    title={
                      forcedSpan >= maxForcedSlots
                        ? "다음 칸이 비어 있지 않거나 운영시간·미팅 최대 길이를 넘습니다"
                        : undefined
                    }
                    disabled={forcedSpan >= maxForcedSlots}
                    onClick={() =>
                      setForcedMinutes(
                        spanForSlots(Math.min(maxForcedSlots, forcedSpan + 1), settings)
                      )
                    }
                  >
                    <Plus />
                  </Button>
                </div>
              </div>
            )}
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder={`${oppositeLabel} 이름 검색`}
                value={counterpartQuery}
                onChange={(e) => setCounterpartQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {candidates.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>가능한 상대가 없습니다</EmptyTitle>
                    <EmptyDescription>
                      {forcedRange
                        ? `${forcedRange.start}~${forcedRange.end} 내내 비어 있는 ${oppositeLabel}가 없거나 검색 결과가 없어요.`
                        : `그 시간에 비어 있는 ${oppositeLabel}가 없거나 검색 결과가 없어요.`}
                      {forcedSpan > 1 && " 미팅 시간을 줄이면 후보가 늘어납니다."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                candidates.map((rec) => (
                  <CandidateRow
                    key={rec.org.id}
                    candidate={rec.org}
                    score={rec.aiScore}
                    onAssign={() =>
                      assignForced(
                        slotTarget!.org,
                        rec.org,
                        slotTarget!.slot,
                        forcedMinutes
                      )
                    }
                  />
                ))
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* 단일 일괄배정 미리보기 */}
      <Dialog
        open={!!fillPreview}
        onOpenChange={(open) => !open && setFillPreview(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fillPreview?.org.name} 빈 슬롯 채움 제안</DialogTitle>
            {/* 기업 상세 [자동채움]과 같은 안내 — 확정 = 실제 배정 + 알림, 고른 기준은 사실대로(리뷰 M2). */}
            <DialogDescription>
              {fillPreview
                ? singleFillConfirmNotice(
                    fillPreview.drafts.length,
                    singleFillOrderLabel(fillPreview.org.id, fit)
                  )
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-5">
            {fillPreview?.drafts.length ? (
              fillPreview.drafts.map((d) => {
                const counterpart =
                  fillPreview.org.role === "exhibitor"
                    ? byId[d.buyerId]
                    : byId[d.exhibitorId]
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {slotLabel(d.slotId)}
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium">
                        {counterpart?.name ?? d.buyerId}
                      </span>
                      <StatusTag meeting={d} />
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="제외"
                      onClick={() =>
                        setFillPreview((prev) =>
                          prev
                            ? {
                                ...prev,
                                drafts: prev.drafts.filter(
                                  (x) => x.id !== d.id
                                ),
                              }
                            : prev
                        )
                      }
                    >
                      <X />
                    </Button>
                  </div>
                )
              })
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                제안이 비었습니다.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFillPreview(null)}>
              폐기
            </Button>
            <Button
              onClick={confirmSingleFill}
              disabled={!fillPreview?.drafts.length || isPending}
            >
              확정
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 전체 일괄배정 설정 → 실행 */}
      <Dialog open={saturationOpen} onOpenChange={setSaturationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>전체 일괄배정 (AI 포화배정)</DialogTitle>
            <DialogDescription>
              전체 참가사 빈 슬롯을 참가사 우선으로 채웁니다. 추가 전용·비파괴 —
              기존 미팅과 다른 기업은 건드리지 않습니다. 실행하면 Draft로 만들어
              그리드에서 검토·확정합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 px-5">
            <SettingField label="최소 보장 슬롯(N)">
              <Input
                type="number"
                min={1}
                value={settings.minSlots}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    minSlots: Math.max(1, Number(e.target.value) || 1),
                  }))
                }
              />
            </SettingField>
            <SettingField label="회의 길이">
              {/* 회의 1건이 차지할 길이 — 이 행사의 칸 길이 기준 1칸부터 max_meeting_minutes 상한까지.
                  30/60/90 리터럴을 쓰면 40분/텀5분 격자에서 90분이 3칸(스팬 130분)이 되어 백엔드가
                  422로 거부한다(mt003gap0001). 칸 수로 움직이고 스팬을 spanForSlots로 다시 계산한다. */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="회의 길이 줄이기"
                  disabled={assignSpan <= 1}
                  onClick={() =>
                    setAssignMinutes(spanForSlots(Math.max(1, assignSpan - 1), settings))
                  }
                >
                  <Minus />
                </Button>
                <span className="min-w-[4.5rem] text-center text-sm font-medium tabular-nums">
                  {assignMinutes}분 · {assignSpan}칸
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="회의 길이 늘리기"
                  title={
                    assignSpan >= maxAssignSlots
                      ? `이 행사 미팅 최대 길이(${settings.maxMeetingMinutes}분)를 넘습니다`
                      : undefined
                  }
                  disabled={assignSpan >= maxAssignSlots}
                  onClick={() =>
                    setAssignMinutes(
                      spanForSlots(Math.min(maxAssignSlots, assignSpan + 1), settings)
                    )
                  }
                >
                  <Plus />
                </Button>
              </div>
            </SettingField>
            <TimeStepper
              label="배정 시작"
              value={settings.startTime}
              onChange={(v) => setSettings((s) => ({ ...s, startTime: v }))}
              minMinutes={toMin(data.settings.startTime)} // 행사 운영시간 안으로 제한
              maxMinutes={toMin(settings.endTime) - 30}
            />
            <TimeStepper
              label="배정 종료"
              value={settings.endTime}
              onChange={(v) => setSettings((s) => ({ ...s, endTime: v }))}
              minMinutes={toMin(settings.startTime) + 30}
              maxMinutes={toMin(data.settings.endTime)} // 행사 운영시간 안으로 제한
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">취소</Button>
            </DialogClose>
            <Button onClick={runSaturation} disabled={isPending}>
              <Sparkles data-icon="inline-start" />
              {isPending ? "실행 중..." : `실행 (run #${runNumber + 1})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 배정된 셀 클릭 → 상대 기업 상세 슬라이드(내 미팅과 같은 MeetingDetailPanel) */}
      <Sheet open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="sr-only">
            <SheetTitle>배정 상세</SheetTitle>
          </SheetHeader>
          {detail
            ? (() => {
                const view = panelViewFor(detail.meeting, detail.rowOrg)
                if (!view) return null
                const cp = counterpartOf(detail.meeting, detail.rowOrg)
                return (
                  <div className="flex flex-col gap-4 px-4 pb-6">
                    {/* 상단: 내 미팅과 동일한 미팅 상세("기업 상세 보기" 모달 푸터는 숨김 — 하단 신청서 인라인으로 대체) */}
                    <MeetingDetailPanel
                      view={view}
                      embedded
                      hideDetailLink
                      cancelAction={cancelAssignedMeeting}
                    />
                    {/* 하단: 그 기업의 비즈매칭 신청서 전체 (프로필 화면과 동일한 뷰 재사용) */}
                    {cp && (
                      <CompanyApplication org={cp} profile={data.profilesByOrgId?.[cp.id] ?? null} />
                    )}
                  </div>
                )
              })()
            : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

// 한 칸 — 채워진 미팅(면 채움 블록·클릭=상세) / Draft(점선) / 불가(신청 제외) / 과거 / 빈 슬롯(+).
function Cell({
  org,
  liveList,
  draftList,
  savingIds,
  reviewing,
  past,
  unavailable,
  counterpartOf,
  onAssign,
  onOpenDetail,
  onRemoveDraft,
}: {
  org: Organization
  // 한 칸에 걸린 미팅 **전부**(표시 순서: 활성 위 / 죽은 이력 아래). 비어 있으면 미배정 칸(#10).
  liveList: AssignmentMeeting[]
  draftList: AssignmentMeeting[]
  // 서버 확정 대기 중인 낙관적 미팅 id — 그 칩은 "저장 중"으로 그리고 눌리지 않는다(칸 잠금).
  savingIds: ReadonlySet<string>
  reviewing: boolean
  past: boolean
  unavailable: boolean
  counterpartOf: (
    m: AssignmentMeeting,
    rowOrg: Organization
  ) => Organization | undefined
  onAssign: () => void
  onOpenDetail: (m: AssignmentMeeting) => void
  onRemoveDraft: (id: string) => void
}) {
  // 이 칸을 실제로 막고 있는 건(확정·대기·완료) — 없으면 죽은 이력(거절·취소)만 남은 칸이라
  // 다시 배정할 수 있다(QA 지적 A). 점유 판정은 colSpan·빈슬롯 판정과 같은 규칙(slot-pick #10).
  const occupying = occupyingSlotMeeting(liveList)
  // 매칭 이력을 지우지 않은 채 새 배정을 추가하는 진입점(QA 지적 B6) — 이력 목록 **아래**에 [+].
  const addable = !occupying && !unavailable && !past && !reviewing
  if (liveList.length > 0) {
    // 면을 채운 블록 — 점유 영역 전체가 "잡힘"으로 보이게(멀티슬롯 colSpan에서 빈 칸과 헷갈리지 않게).
    // 클릭하면 상대 기업 상세 슬라이드. 과거 미팅은 흐리게(이력).
    // 같은 칸에 여러 건이면 세로로 쌓고, 죽은 이력(거절·취소)은 한 줄로 축약해 활성 건을 안 가린다.
    return (
      <div className="flex flex-col gap-1">
        {liveList.map((m) => {
          const dead = isDeadSlotMeeting(m.status)
          // 저장 중(서버 확정 전) — 아직 서버에 없는 미팅이라 상세·취소를 열 수 없고, 칸도 잠긴다.
          const saving = savingIds.has(m.id)
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpenDetail(m)}
              disabled={saving}
              aria-busy={saving || undefined}
              title={
                saving
                  ? "저장 중이에요 — 서버 확정을 기다리는 중"
                  : "클릭하면 상대 기업 상세"
              }
              className={cn(
                "flex w-full items-stretch rounded-md border px-2 text-left transition-colors hover:bg-muted/70",
                dead
                  ? "border-dashed bg-transparent py-0.5 opacity-70"
                  : "bg-muted/40 py-1.5",
                past && "opacity-60",
                saving && "cursor-wait border-dashed hover:bg-muted/40"
              )}
            >
              <MeetingChip
                meeting={m}
                name={counterpartOf(m, org)?.name ?? "—"}
                compact={dead}
                saving={saving}
              />
            </button>
          )
        })}
        {addable && <AddSlotButton reviewing={reviewing} onAssign={onAssign} />}
      </div>
    )
  }
  if (draftList.length > 0) {
    return (
      <div className="flex flex-col gap-1">
        {draftList.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-1 rounded-md border border-dashed border-foreground/40 bg-muted/30 px-1.5 py-1"
          >
            <MeetingChip meeting={m} name={counterpartOf(m, org)?.name ?? "—"} />
            <button
              type="button"
              aria-label="Draft에서 제외"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => onRemoveDraft(m.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    )
  }
  // 신청 때 지정한 "불가" 슬롯 — 배정 대상 아님. 빗금 배경 + "불가"로 빈 슬롯(+)과 구분.
  if (unavailable) {
    return (
      <span
        title="신청 시 배정 불가로 지정한 시간"
        className="mx-auto flex items-center justify-center rounded-md bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_3px,transparent_3px,transparent_6px)] px-1.5 py-1 text-[10px] text-muted-foreground/70"
      >
        불가
      </span>
    )
  }
  // 과거 빈 슬롯 — 이미 지난 시각이라 배정 불가(내 미팅과 동일). 회색 점만.
  if (past) {
    return (
      <span
        aria-hidden
        className="mx-auto block text-center text-xs text-muted-foreground/30"
        title="지난 시간"
      >
        ·
      </span>
    )
  }
  return <AddSlotButton reviewing={reviewing} onAssign={onAssign} />
}

// 빈 슬롯(또는 죽은 이력만 남은 칸)의 배정 진입점. 빈 칸과 "이력 아래"에서 같은 버튼을 쓴다.
function AddSlotButton({
  reviewing,
  onAssign,
}: {
  reviewing: boolean
  onAssign: () => void
}) {
  return (
    <button
      type="button"
      aria-label="빈 슬롯 — 상대 배정"
      disabled={reviewing}
      onClick={onAssign}
      className="mx-auto flex size-6 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:border-foreground hover:text-foreground disabled:opacity-40"
    >
      <Plus className="size-3.5" />
    </button>
  )
}

function SettingField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

// 30분 단위 시각 스텝퍼(운영 시작/종료) — 1분 단위 없이 −/+ 30분으로만 이동. minMinutes~maxMinutes로 범위 제한.
function TimeStepper({
  label,
  value,
  onChange,
  minMinutes,
  maxMinutes,
}: {
  label: string
  value: string // "HH:MM"
  onChange: (next: string) => void
  minMinutes: number
  maxMinutes: number
}) {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number)
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
  }
  const toStr = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`
  const cur = toMin(value)
  return (
    <SettingField label={label}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={`${label} 30분 당기기`}
          disabled={cur <= minMinutes}
          onClick={() => onChange(toStr(Math.max(minMinutes, cur - 30)))}
        >
          <Minus />
        </Button>
        <span className="min-w-[3.5rem] text-center text-sm font-medium tabular-nums">
          {toStr(cur)}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={`${label} 30분 미루기`}
          disabled={cur >= maxMinutes}
          onClick={() => onChange(toStr(Math.min(maxMinutes, cur + 30)))}
        >
          <Plus />
        </Button>
      </div>
    </SettingField>
  )
}
