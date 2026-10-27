"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Search, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { boothLabel, type Organization } from "@/lib/types"
import { BUYER_TYPE_LABELS } from "@/lib/organizer/participant-labels"
import {
  APPLICATION_STATUS_LABELS,
  isParticipant,
  type MemberRow,
} from "@/lib/organizer/members"
import { CandidateRow, MeetingChip, StatusTag, singleFillConfirmNotice } from "./assignment-shared"
import {
  fitFromRecs,
  indexOrgs,
  oppositeCandidates,
  unavailableSets,
  type AssignmentScheduleData,
} from "@/lib/organizer/assignment-schedule"
import { createForcedMeeting, type AssignmentMeeting } from "@/lib/organizer/forced-assignment"
import {
  addConfirmed,
  pendingNotYetListed,
  submitAssignments,
  submitForcedAssignment,
} from "@/lib/organizer/forced-assignment-submit"
import { refreshAssignmentViews } from "@/lib/organizer/assignment-refresh"
import {
  addMinutes,
  buildSlotUniverse,
  slotId,
  slotMeetingsFor,
  spanOf,
} from "@/lib/organizer/schedule"
import { isDeadSlotMeeting, occupyingSlotMeeting } from "@/lib/meeting/slot-pick"
import {
  expandOccupancy,
  isAvailableAt,
  isFreeAt,
  meetingCountFor,
  mergeConsecutive,
} from "@/lib/organizer/slot-intersection"
import {
  proposeSingleOrgFill,
  singleFillOrderLabel,
  type DraftMeeting,
  type SaturationInput,
} from "@/lib/organizer/saturation"

interface MemberDetailProps {
  org: Organization
  member: MemberRow | null
  data: AssignmentScheduleData
  // 현재 시각(KST) — 과거 슬롯을 배정 불가로 제외(내 미팅·OP-005와 동일 기준).
  now: { date: string; time: string }
  // 조회 전용(sub 운영자) — 배정 액션(자동채움·빈 슬롯 배정)을 그리지 않는다. 배정은 master 전용
  // 거버넌스(ADR-0012)라 눌러도 백엔드가 403으로 막는다 — 누를 수 없는 버튼을 보여주지 않는다.
  readOnly?: boolean
}

// OP-003 운영자용 기업 디테일 — 프로필(조회) + 이 기업 미팅 일정 + 단일 기업 빈슬롯 보충.
// 전체 포화배정은 여기 없다(OP-005 전용, F-OP-003 D7). 보충은 두 모드: ① 자동채움(AI) ② 추천→선택(Forced).
export function MemberDetail({ org, member, data, now, readOnly = false }: MemberDetailProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const byId = useMemo(() => indexOrgs(data), [data])
  const fit = useMemo(() => fitFromRecs(data.recsByOrgId), [data])
  // 과거 슬롯은 배정 불가(내 미팅·OP-005와 동일): 보충 후보 유니버스에서 제외한다.
  const nowKey = `${now.date} ${now.time}`
  const allSlotIds = useMemo(
    () =>
      buildSlotUniverse(data.dates.map((d) => d.id), data.settings)
        .filter((s) => `${s.dateId} ${s.time}` >= nowKey)
        .map((s) => s.id),
    [data, nowKey],
  )
  const [meetings, setMeetings] = useState<AssignmentMeeting[]>(data.meetings)
  // 서버 진실 채택 — 배정 그리드(assignment-hub)와 같은 패턴. router.refresh()로 서버가 새 목록을
  // 내려주면(새 배열 참조) 확정 목록을 그걸로 **교체**한다. 예전엔 useState 초기값이 마운트 때 한 번
  // 박혀 refresh가 화면을 못 바꿨다 — ⚡ 자동채움이 "2건 중 1건만" 저장된 뒤에도 두 칸이 다 빈 칸으로
  // 남아, 다시 누르면 이미 저장된 첫 항목부터 SLOT_TAKEN/DUPLICATE로 막히는 일이 페이지를 새로 열
  // 때까지 반복됐다(2026-10-01 E2E). 렌더 중 prop 변화에 맞춰 state를 조정하는 표준 패턴.
  const [serverMeetings, setServerMeetings] = useState(data.meetings)
  if (serverMeetings !== data.meetings) {
    setServerMeetings(data.meetings)
    setMeetings(data.meetings)
  }
  // 저장 중(서버 2xx 전) 낙관적 미팅 — 배정 그리드(assignment-hub)와 같은 모델. 확정 목록과 따로 들고
  // "저장 중"으로 그려 그 칸을 잠근다. 성공하면 meetings로 옮기고, 실패하면 여기서 빼는 게 곧 롤백이다.
  // 위 서버 진실 채택은 이 목록을 건드리지 않는다(저장 중인 칸이 refresh로 빈 칸이 되지 않게).
  const [saving, setSaving] = useState<AssignmentMeeting[]>([])
  // 같은 상대·같은 시각을 저장 중에 또 보내지 않게 하는 즉시 가드(렌더를 기다리지 않는다).
  const inFlightIds = useRef(new Set<string>())
  // 자동채움 배치마다 낙관적 id가 겹치지 않게 하는 일련번호.
  const fillBatchSeq = useRef(0)
  const [dateId, setDateId] = useState(data.dates[0]?.id ?? "")
  const isPastSlot = (time: string) => `${dateId} ${time}` < nowKey
  const [slotTarget, setSlotTarget] = useState<{ slot: string } | null>(null)
  const [counterpartQuery, setCounterpartQuery] = useState("")
  const [fillPreview, setFillPreview] = useState<DraftMeeting[] | null>(null)

  const pendingShown = useMemo(() => pendingNotYetListed(saving, meetings), [saving, meetings])
  const savingIds = useMemo(() => new Set(pendingShown.map((m) => m.id)), [pendingShown])
  // 격자 모양 = 칸 길이 + 칸 사이 텀(stride = slotMinutes + slotGapMinutes). 병합·점유 펼침은 **반드시
  // 텀까지** 넘긴다 — 배정 그리드(assignment-hub)와 같은 인자다. 예전엔 여기만 텀을 빠뜨려, 40분+텀5분
  // 격자(10:00 10:45 11:30 …)에서 10:00–11:25(85분) 미팅이 "10:00–12:10"으로 그려져 실제로 빈 11:30 칸이
  // 사라지고, 점유는 존재하지 않는 10:40·11:20으로 펼쳐져 실제로 막힌 10:45가 빈 칸으로 계산됐다 —
  // [자동채움]이 그 10:45를 서버로 보내 SLOT_TAKEN으로 배치가 멈췄다(2026-10-01 리뷰 H1).
  const { slotMinutes, slotGapMinutes } = data.settings
  // 같은 상대가 연달아 잡힌 슬롯은 한 블록으로 합쳐 표시·점유(연속 슬롯 병합). 저장 중 건은 확정 건과
  // 섞어 병합하지 않는다(병합 블록은 첫 미팅의 신원을 따른다 — 섞이면 저장 중 칸이 "확정"으로 보인다).
  const merged = useMemo(
    () => [
      ...mergeConsecutive(meetings, slotMinutes, slotGapMinutes),
      ...mergeConsecutive(pendingShown, slotMinutes, slotGapMinutes),
    ],
    [meetings, pendingShown, slotMinutes, slotGapMinutes],
  )
  // 점유 판정에는 **살아있는 건만** 넣는다 — 거절·취소 이력은 칸을 잡지 않는다(#10 규칙, 백엔드
  // slot_booking._OCCUPYING과 같은 방향). 예전엔 죽은 이력이 그 칸의 상대 후보를 통째로 지웠다.
  const expanded = useMemo(
    () =>
      expandOccupancy(
        merged.filter((m) => !isDeadSlotMeeting(m.status)),
        slotMinutes,
        slotGapMinutes,
      ),
    [merged, slotMinutes, slotGapMinutes],
  )
  // 기업별 "불가" 슬롯(신청 때 지정) — 자동채움·Forced 후보에서 제외. 일정에 "불가"로 표시.
  const unavailable = useMemo(() => unavailableSets(data.unavailableByOrgId), [data])
  const oppositeLabel = org.role === "exhibitor" ? "바이어" : "참가사"
  const myMeetingCount = meetingCountFor(org.id, merged)

  function buildInput(): SaturationInput {
    return {
      exhibitors: data.exhibitors,
      buyers: data.buyers,
      fit,
      applicationOrder: data.applicationOrder,
      allSlotIds,
      // 병합·멀티슬롯 점유를 펼쳐 빈슬롯 보충이 겹치지 않게 한다. 자동채움 엔진에는 **죽은 이력까지**
      // 넣는다(위 expanded와 다르다) — 슬롯 점유 판정은 살아있는 건만 보지만, "이미 짝지은 상대"
      // (alreadyPaired) 판정은 거절·취소된 이력도 세어 같은 쌍을 AI가 다시 제안하지 않게 한다.
      // 운영자가 그 칸에 직접 배정하는 길은 [빈 슬롯 +]로 열려 있다(QA A/B6). 텀도 넘긴다(위 H1 주석) —
      // 빠뜨리면 멀티슬롯 미팅의 뒤 칸이 엉뚱한 시각으로 펼쳐져 자동채움이 막힌 칸을 빈 칸으로 본다.
      existing: expandOccupancy(merged, slotMinutes, slotGapMinutes),
      unavailable, // 이 기업·상대의 불가 슬롯은 배정 제외
    }
  }
  // 한 칸에 걸린 미팅 **전부**(표시 순서: 활성 위 / 죽은 이력 아래) — 배정 그리드와 같은 유틸.
  function meetingsAt(slot: string) {
    return slotMeetingsFor(merged, org.id, slot)
  }
  // 그 칸을 실제로 막고 있는 건. 없으면(빈 칸이거나 죽은 이력만) 다시 배정할 수 있다.
  function occupierAt(slot: string) {
    return occupyingSlotMeeting(meetingsAt(slot))
  }
  function counterpartOf(m: AssignmentMeeting) {
    return org.role === "exhibitor" ? byId[m.buyerId] : byId[m.exhibitorId]
  }
  function slotLabel(slot: string) {
    const [d, t] = slot.split("T")
    return `${data.dates.find((x) => x.id === d)?.label ?? d} ${t}`
  }

  // 저장이 끝난 뒤 화면들을 서버 진실로 맞춘다 — 배정 탭(assignment-hub)과 동일 원칙(QA 3차 #2).
  //  · router.refresh() — 이 화면을 서버에서 다시 그려 낙관적 목록을 실제 미팅으로 교체.
  //  · refreshAssignmentViews() — 배정 탭·참가자 화면의 Client Cache 무효화(여기서 만든 배정이
  //    배정 탭에 즉시 보이지 않던 것이 바로 이 호출 누락 때문이었다).
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

  // 모드② 추천→선택(Forced) — 빈 슬롯에서 상대를 직접 고른다. "저장 중"으로 먼저 반영(그 칸은 잠긴다) →
  // POST 저장(배정 탭과 같은 submitForcedAssignment 공용 함수) → 서버 2xx 뒤에만 성공 토스트, 실패 시
  // 롤백 + 원인별 토스트. 예전엔 여기서 setMeetings만 하고 서버에 저장하지 않아 배정 탭에 반영되지 않는
  // 사고가 났고(QA 3차 #2), 그 뒤에도 응답 전에 성공 토스트가 먼저 떴다(2026-10-01).
  function assignForced(candidate: Organization, slot: string) {
    const buyer = org.role === "buyer" ? org : candidate
    const exhibitor = org.role === "exhibitor" ? org : candidate
    try {
      const m = createForcedMeeting(buyer, exhibitor, slot, `forced-${buyer.id}-${exhibitor.id}-${slot}`)
      // 같은 상대·같은 시각이 이미 저장 중이면 다시 보내지 않는다(중복 제출 차단).
      if (inFlightIds.current.has(m.id)) return
      inFlightIds.current.add(m.id)
      setSaving((prev) => [...prev, m])
      setSlotTarget(null)
      setCounterpartQuery("")
      startTransition(async () => {
        const ok = await submitForcedAssignment(m, setSaving, () => router.push("/login"), {
          partiesOf: () => ({ exhibitorName: exhibitor.name, buyerName: buyer.name }),
          onResync: syncAfterWrite,
        })
        inFlightIds.current.delete(m.id)
        if (!ok) return
        promoteSaved([m])
        toast(`${candidate.name} 배정`, { description: "운영자 배정 — 즉시 확정" })
        syncAfterWrite()
      })
    } catch (e) {
      toast("배정할 수 없어요", { description: e instanceof Error ? e.message : String(e) })
    }
  }

  // 모드① 자동채움(AI 재트리거) — 이 기업 빈 슬롯만, 미리보기 후 확정. 다른 기업·기존 미팅 불변.
  function openAutoFill() {
    const drafts = proposeSingleOrgFill(org.id, buildInput(), data.settings, 1)
    if (drafts.length === 0) {
      toast("채울 빈 슬롯이 없어요", { description: "이미 다 찼거나 가능한 상대가 없습니다" })
      return
    }
    setFillPreview(drafts)
  }
  // 확정 — 배정 그리드의 ⚡ 확정(assignment-hub confirmSingleFill)과 같은 저장 경로·규칙이다(POST →
  // /retrigger-assignments). 예전엔 화면 목록에만 넣고 "N건 보충" 성공 토스트를 띄웠을 뿐 서버에 저장하지
  // 않았다 — 새로고침하면 사라지고 배정 탭·참가자 화면엔 반영되지 않았다(2026-10-01, QA 3차 #2와 같은 류).
  function confirmAutoFill() {
    if (!fillPreview) return
    fillBatchSeq.current += 1
    const batch = fillBatchSeq.current
    const withIds = fillPreview.map((d, i) => ({ ...d, id: `fill-${batch}-${i}` }))
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
          r.savedCount ? `빈 슬롯 ${withIds.length}건 중 ${r.savedCount}건만 보충됐어요` : undefined,
        onResync: syncAfterWrite,
      })
      if (!ok) return
      promoteSaved(withIds)
      toast(`빈 슬롯 ${withIds.length}건 보충`, { description: "출처: AI 매칭" })
      syncAfterWrite()
    })
  }

  const candidates = useMemo(() => {
    if (!slotTarget) return []
    const q = counterpartQuery.trim().toLowerCase()
    return oppositeCandidates(data, org.role)
      .filter((r) => isFreeAt(r.org.id, slotTarget.slot, expanded))
      .filter((r) => isAvailableAt(r.org.id, slotTarget.slot, unavailable)) // 상대도 그 슬롯 가능해야
      .filter((r) => !q || r.org.name.toLowerCase().includes(q))
  }, [slotTarget, counterpartQuery, data, expanded, unavailable, org.role])

  const profileChips = org.keywords ?? []

  return (
    <div className="flex w-full flex-col gap-6">
      {/* 1. 프로필 (조회) */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-xl">{org.name}</CardTitle>
            <Badge variant="secondary">{org.role === "exhibitor" ? "참가사" : "바이어"}</Badge>
            {org.buyerType && <Badge variant="outline">{BUYER_TYPE_LABELS[org.buyerType]}</Badge>}
            {member && (
              <Badge variant={isParticipant(member) ? "default" : "outline"}>
                {APPLICATION_STATUS_LABELS[member.applicationStatus]}
              </Badge>
            )}
          </div>
          {org.description && <CardDescription>{org.description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {profileChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profileChips.map((kw) => (
                <Badge key={kw} variant="secondary" className="font-normal">{kw}</Badge>
              ))}
            </div>
          )}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {boothLabel(org.booth) && <Field label="부스" value={boothLabel(org.booth)} />}
            {org.strength && <Field label="강점" value={org.strength} />}
            {org.exhibits?.length ? <Field label="사업분야" value={org.exhibits.join(", ")} /> : null}
            {org.budgetRange && <Field label="예산 범위" value={org.budgetRange} />}
            {org.adoptionTimeline && <Field label="도입 시기" value={org.adoptionTimeline} />}
            {org.founded && <Field label="설립" value={org.founded} />}
            {org.employees && <Field label="규모" value={org.employees} />}
          </dl>
        </CardContent>
      </Card>

      {/* 2. 미팅 일정 (조회) + 3. 단일 기업 빈슬롯 보충 (액션) */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle>미팅 일정</CardTitle>
              <CardDescription>
                {readOnly
                  ? "이 기업의 슬롯별 미팅 상태(조회 전용). 내가 관리하는 바이어와의 미팅만 표시됩니다."
                  : "이 기업의 슬롯별 배정 상태와 빈 슬롯. 빈 슬롯을 눌러 상대를 직접 배정(Forced)합니다."}
              </CardDescription>
            </div>
            {!readOnly && (
              <Button
                size="sm"
                onClick={openAutoFill}
                // 이 기업이 낀 저장이 끝날 때까지 잠근다 — 서버 확정 전 상태로 보충안을 만들면 저장이
                // 실패·되돌려질 때 엇갈린다(배정 그리드 ⚡와 같은 규칙).
                disabled={savingIds.size > 0}
                title={
                  savingIds.size > 0
                    ? "이 기업 배정을 저장하는 중이에요"
                    : "이 기업 빈 슬롯을 채울 상대를 미리 보여주고, 확정하면 실제로 배정해요(재트리거)"
                }
              >
                <Zap data-icon="inline-start" />
                자동채움
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
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
            <span className="ml-auto text-xs text-muted-foreground">총 {myMeetingCount}건 배정</span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {(() => {
              // 멀티슬롯(연속) 미팅: 시작칸만 보여주고 가려진 뒤 칸은 건너뛴다. 시작칸은 더 넓게(col-span) 표시.
              // 뒤 칸을 먹는 건 "점유하는" 건뿐이다 — 90분짜리 거절 이력이 뒤의 빈 칸을 삼키지 않게(#10).
              const stride = data.settings.slotMinutes + data.settings.slotGapMinutes
              const covered = new Set<string>()
              for (const t of data.slotTimes) {
                const m = occupierAt(slotId(dateId, t))
                if (!m) continue
                const sp = spanOf(m.durationMinutes, data.settings.slotMinutes, data.settings.slotGapMinutes)
                for (let i = 1; i < sp; i++) covered.add(addMinutes(t, i * stride))
              }
              return data.slotTimes.map((t) => {
                if (covered.has(t)) return null
                const slot = slotId(dateId, t)
                const list = meetingsAt(slot)
                const occupier = occupyingSlotMeeting(list)
                const span = occupier
                  ? spanOf(occupier.durationMinutes, data.settings.slotMinutes, data.settings.slotGapMinutes)
                  : 1
                const endTime =
                  span > 1 ? addMinutes(t, (span - 1) * stride + data.settings.slotMinutes) : null
                const past = isPastSlot(t)
                const blocked = !occupier && !isAvailableAt(org.id, slot, unavailable) // 신청 불가 슬롯
                // 매칭 이력(거절·취소)만 남은 칸도 다시 배정할 수 있다 — 이력은 지우지 않고 그
                // **아래**에 [+ 빈 슬롯]을 둔다(발주자 QA: "히스토리 유지하며 매칭 추가").
                const addable = !readOnly && !occupier && !blocked && !past
                return (
                  <div
                    key={t}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border px-2.5 py-2",
                      span > 1 && "sm:col-span-2",
                      occupier && "bg-muted/40", // 채워진 칸은 면을 채워 빈 칸과 구분
                      blocked && "bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_4px,transparent_4px,transparent_8px)]",
                      past && !occupier && "opacity-50", // 지난 빈 슬롯은 흐리게(배정 불가)
                      past && occupier && "opacity-60",
                    )}
                  >
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {endTime ? `${t}–${endTime}` : t}
                    </span>
                    {list.map((m) => (
                      <MeetingChip
                        key={m.id}
                        meeting={m}
                        name={counterpartOf(m)?.name ?? "—"}
                        compact={isDeadSlotMeeting(m.status)}
                        // 서버 확정 전 — "확정"을 미리 보이지 않는다(그 칸은 이 칩이 점유해 [빈 슬롯]이 없다).
                        saving={savingIds.has(m.id)}
                      />
                    ))}
                    {list.length === 0 && blocked && (
                      <span className="text-sm text-muted-foreground/60" title="신청 시 배정 불가로 지정한 시간">
                        불가
                      </span>
                    )}
                    {list.length === 0 && !blocked && past && (
                      <span className="text-sm text-muted-foreground/50" title="지난 시간">
                        지난 시간
                      </span>
                    )}
                    {addable && (
                      <button
                        type="button"
                        onClick={() => setSlotTarget({ slot })}
                        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="size-3.5" />빈 슬롯
                      </button>
                    )}
                  </div>
                )
              })
            })()}
          </div>
        </CardContent>
      </Card>

      {/* 모드② 빈 슬롯 → 상대 탐색 시트 */}
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
            <SheetTitle>{slotTarget ? `${slotLabel(slotTarget.slot)} · ${org.name}` : ""}</SheetTitle>
            <SheetDescription>
              그 시간에 비어 있는 {oppositeLabel}를 이름순으로. AI 추천은 아직 제공되지 않아요 — 목록에서 직접 선택하세요. 고르면 받는 쪽 유형대로 즉시 확정/수락대기로 처리됩니다.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
                    <EmptyDescription>그 시간에 비어 있는 {oppositeLabel}가 없거나 검색 결과가 없어요.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                candidates.map((rec) => (
                  <CandidateRow
                    key={rec.org.id}
                    candidate={rec.org}
                    score={rec.aiScore}
                    onAssign={() => assignForced(rec.org, slotTarget!.slot)}
                  />
                ))
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* 모드① 자동채움 미리보기 */}
      <Dialog open={!!fillPreview} onOpenChange={(open) => !open && setFillPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{org.name} 빈 슬롯 자동채움</DialogTitle>
            {/* 확정 = 실제 배정 + 알림 발송(예전 문구 "제안·비파괴"는 저장되지 않던 시절의 것, 리뷰 M2).
                고른 기준은 엔진과 같은 규칙으로 — 점수가 없으면 신청 순이라고 사실대로 말한다. */}
            <DialogDescription>
              {singleFillConfirmNotice(fillPreview?.length ?? 0, singleFillOrderLabel(org.id, fit))}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-5">
            {fillPreview?.length ? (
              fillPreview.map((d) => {
                const c = org.role === "exhibitor" ? byId[d.buyerId] : byId[d.exhibitorId]
                return (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{slotLabel(d.slotId)}</span>
                      <span className="min-w-0 truncate text-sm font-medium">{c?.name ?? d.buyerId}</span>
                      <StatusTag meeting={d} />
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="제외"
                      onClick={() => setFillPreview((prev) => (prev ? prev.filter((x) => x.id !== d.id) : prev))}
                    >
                      ✕
                    </Button>
                  </div>
                )
              })
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">제안이 비었습니다.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFillPreview(null)}>폐기</Button>
            <Button onClick={confirmAutoFill} disabled={!fillPreview?.length}>확정</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{value}</dd>
    </div>
  )
}
