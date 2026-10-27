"use client"

// OP-005 배정 허브와 OP-003 기업 상세가 공유하는 표현 컴포넌트.
// 진입 상태 뱃지 + "상대 후보 한 줄"(매칭률·유형·예상 결과). 휴리스틱은 없고 표시만 한다.

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { boothLabel, type Organization } from "@/lib/types"
import { BUYER_TYPE_LABELS } from "@/lib/organizer/participant-labels"
import type { AssignmentMeeting, MatchingType } from "@/lib/organizer/forced-assignment"
import { toneFor, type SlotTone } from "@/lib/meeting/meeting-projection"
import type { PanelCounterpart } from "@/lib/meeting/meeting-panel"

// 셀 상태색은 MY-001 내 미팅과 동일한 규칙(near-mono + 좌측 4px 틱에만 상태색).
// green=확정/예정 · red=수락대기 · orange=회의록 작성 필요 · blue=회의록 완료(보관) · gray=노쇼/거절/취소.
// 토큰은 내 미팅 타임라인(meeting-timeline TICK_BG)과 같은 status-* 디자인 토큰을 쓴다.
const TONE_TICK: Record<SlotTone, string> = {
  green: "bg-status-confirmed",
  red: "bg-status-pending",
  orange: "bg-status-review",
  blue: "bg-status-archived",
  gray: "bg-status-muted",
}

// 미팅 → 톤. toneFor(meeting-projection)를 그대로 써서 내 미팅과 색이 정확히 일치한다.
// 운영자 그리드엔 진행시각(now) 개념이 없어 ended는 넘기지 않는다(accepted=green 고정).
export function cellTone(m: Pick<AssignmentMeeting, "status" | "attended" | "hasReview">): SlotTone {
  return toneFor(m.status, { attended: m.attended, hasReview: m.hasReview })
}

// 셀 라벨 — 운영자 관점 상태어. noshow=completed의 attended=false(ADR-0010).
export function cellLabel(m: Pick<AssignmentMeeting, "status" | "attended" | "hasReview">): string {
  switch (m.status) {
    case "proposed":
      return "수락대기"
    case "accepted":
      return "확정"
    case "completed":
      return m.attended === false ? "노쇼" : m.hasReview ? "완료·보관" : "완료"
    case "rejected":
      return "거절"
    case "cancelled":
      return "취소"
    default:
      return ""
  }
}

// 서버 확정(2xx) 전 낙관적 미팅의 라벨 — "확정"을 미리 보여주지 않는다(2026-10-01: 저장이 실패해도
// 화면엔 먼저 확정처럼 보였다). 저장 중인 칸은 이 라벨로 잠긴다(같은 칸 중복 배정 방지).
export const SAVING_LABEL = "저장 중"

// ⚡ 단일 기업 자동채움 확인창 안내 — 배정 그리드(⚡)·기업 상세([자동채움])가 같은 문구를 쓴다. 확정은
// "제안 반영"이 아니라 **실제 배정 + 알림 발송**이다(POST /retrigger-assignments → 받는 쪽 바이어 유형대로
// 즉시 확정 또는 수락대기, 백엔드가 알림을 보낸다). 고른 기준(orderLabel)은 lib/organizer/saturation의
// singleFillOrderLabel이 엔진과 같은 규칙으로 정한다 — 점수가 없으면 "AI 적합도 순"이라고 하지 않는다.
export function singleFillConfirmNotice(count: number, orderLabel: string): string {
  return (
    `${orderLabel}으로 고른 상대예요. 확정하면 아래 ${count}건이 실제로 배정되고 상대 기업에 알림이 ` +
    "발송됩니다(받는 쪽 유형에 따라 즉시 확정 또는 수락대기). 빼고 싶은 건 ✕로 제외하세요."
  )
}

// 그리드/일정 셀 본문 — 좌측 상태 틱 + 상대 기업명 + 상태 라벨(내 미팅과 동일한 색 언어).
export function MeetingChip({
  meeting,
  name,
  compact = false,
  saving = false,
}: {
  meeting: AssignmentMeeting
  name: string
  // 죽은 이력(거절·취소)을 한 칸에 함께 보일 때(#10) — 기업명·상태를 한 줄로 접어 활성 건을 안 가린다.
  compact?: boolean
  // 서버 확정 대기 중(낙관적 반영) — 상태 대신 "저장 중"을 보이고 틱을 흐리게 깜빡인다.
  saving?: boolean
}) {
  const label = saving ? SAVING_LABEL : cellLabel(meeting)
  const tick = saving ? "animate-pulse bg-status-muted" : TONE_TICK[cellTone(meeting)]
  if (compact) {
    return (
      <div
        className="flex min-w-0 flex-1 items-stretch gap-1.5 text-left"
        title={`${name} · ${label}`}
      >
        <span aria-hidden className={cn("w-1 shrink-0 self-stretch rounded-full", tick)} />
        <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">{name}</span>
        <span className="shrink-0 self-center text-[10px] leading-tight text-muted-foreground">{label}</span>
      </div>
    )
  }
  return (
    <div className="flex items-stretch gap-1.5 text-left" title={`${name} · ${label}`}>
      <span aria-hidden className={cn("w-1 shrink-0 self-stretch rounded-full", tick)} />
      <span className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-xs font-medium leading-tight">{name}</span>
        <span className="text-[10px] leading-tight text-muted-foreground">{label}</span>
      </span>
    </div>
  )
}

// provenance(출처) 라벨 — 슬라이드 패널에서 "누가 만든 배정인가"를 표시(참가자 direction 자리 대체).
export const PROVENANCE_LABEL: Record<MatchingType, string> = {
  forced: "Forced 배정",
  ai: "AI 매칭",
  open: "공개 신청",
  onsite: "현장",
}

// Organization → 슬라이드 패널 상대 기업 정보(MY-001 meeting-panel.toCounterpart의 클라 안전 미러).
// meeting-panel.ts의 값을 직접 import하면 거기 묶인 점수 휴리스틱이 클라 번들로 새므로(ADR-0001) 복제한다.
export function toPanelCounterpart(org: Organization): PanelCounterpart {
  const isExhibitor = org.role === "exhibitor"
  return {
    id: org.id,
    name: org.name,
    role: org.role,
    typeLabel: isExhibitor ? "참가사" : org.buyerType ? `${BUYER_TYPE_LABELS[org.buyerType]} 바이어` : "바이어",
    oneLiner: isExhibitor ? org.strength : org.description,
  }
}

// 한 줄 목록(Draft 미리보기 등)용 작은 상태 태그 — 톤 점 + 라벨.
export function StatusTag({ meeting }: { meeting: AssignmentMeeting }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_TICK[cellTone(meeting)])} />
      {cellLabel(meeting)}
    </span>
  )
}

// 상대 후보 한 줄 — 기업명 + 매칭률 + 유형 + 예상 결과 + [배정].
// 이 줄은 **운영자 강제 배정 시트에서만** 쓰인다(OP-005 그리드 / OP-003 기업 상세). 강제 배정은
// 받는 쪽 유형과 무관하게 즉시 확정이므로(ADR-0005 2026-09-15 정정, 발주자 QA B3 — 백엔드
// acceptance_rule._OPERATOR_OVERRIDE_CHANNELS) 예상 결과도 언제나 "즉시 확정"이다. 예전엔 여기서
// 바이어 유형으로 "수락대기"를 예고해, 배정하면 확정으로 저장되는 실제 결과와 어긋났다.
export function CandidateRow({
  candidate,
  score,
  onAssign,
}: {
  candidate: Organization
  // null = AI 추천 미제공(#6 비-AI 폴백 후보) — 점수를 지어내지 않고 매칭률 표시를 생략한다.
  score: number | null
  onAssign: () => void
}) {
  const typeLabel = candidate.buyerType
    ? BUYER_TYPE_LABELS[candidate.buyerType]
    : (boothLabel(candidate.booth) ?? "참가사")
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{candidate.name}</span>
          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">{typeLabel}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          {score !== null && <>매칭 {score}% · </>}
          <span className="text-foreground">즉시 확정</span>
        </span>
      </div>
      <Button size="sm" className="shrink-0" onClick={onAssign}>배정</Button>
    </div>
  )
}
