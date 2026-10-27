"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { Clock, MapPin, Sparkles, ArrowUpRight, Users, CalendarSearch, CalendarX } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { useOrgDetail } from "@/components/discover/org-detail-modal"
import { useParticipantMenu } from "@/components/layout/participant-menu-provider"
import { MeetingReasonDialog } from "@/components/meeting/meeting-reason-dialog"
import {
  acceptMeeting,
  cancelMeeting,
  isMeetingHttpMode,
  rejectMeeting,
  type MeetingActionResult,
} from "@/lib/meeting/meeting-actions"
import { meetingActionErrorMessage } from "@/lib/meeting/action-error"
import { resolveLocale } from "@/lib/i18n/config"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { MeetingPanelView, PanelEmptyKind, PanelMember } from "@/lib/meeting/meeting-panel"
import type { SlotAction, SlotTone } from "@/lib/meeting/timeline"

// 상태 뱃지 색 — 케이스 구분(subtle 톤).
const TONE_BADGE: Record<SlotTone, string> = {
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  red: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  orange: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-500",
  blue: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400", // 회의록 완료(보관)
  gray: "bg-muted text-muted-foreground",
}

// 라벨은 t("meeting.detailPanel.action*")로 조립(호출부 PanelActionButton) — 액션→키 매핑만 여기 둔다.
const ACTION_LABEL_KEY: Record<SlotAction, string> = {
  accept: "actionAccept",
  reject: "actionReject",
  cancel: "actionCancel",
  review: "actionReview", // 미팅 후 산출물의 사용자 노출 라벨은 "회의록"으로 통일(CONTEXT.md "미팅 후 마무리")
  attendance: "actionAttendance", // 노쇼↔참석 정정. 노쇼를 참석으로 바꾸면 회의록 작성이 열린다.
}

// MY-001 우측 상세 패널(F-MY-001 D10) — shadcn Card로 구성.
// 헤더(상대 기업) → 매칭근거 → 미팅 컨텍스트 → 액션 → 푸터("기업 상세 보기" → 공유 모달).
// 기업 전시제품·실적 등 상세 필드는 이 패널에서 재정의하지 않는다 — "기업 상세 보기"가 공통
// OrgDetailBody를 모달로 띄운다(기업 탐색과 동일 본문 재사용, 정의 중복 제거).
// embedded: 좁은 폭에서 하단 바텀시트로 띄울 때. 카드 frame(ring/rounded/bg)과
// footer의 muted 채움·둥근모서리를 제거해 시트와 한 몸으로 흐르게 한다(카드-인-시트
// 중첩 제거). footer의 border-t 구분선과 패딩은 액션 영역 구분용으로 의도적으로 유지.
export function MeetingDetailPanel({
  view,
  embedded = false,
  hideDetailLink = false,
  cancelAction,
}: {
  view: MeetingPanelView
  embedded?: boolean
  // 운영자 배정 슬라이드는 하단에 별도 "비즈매칭 신청서"를 인라인으로 붙이므로 "기업 상세 보기"
  // 모달 푸터를 숨긴다(중복 회피, #131 의도 보존). 내 미팅(MY-001)은 기본값(false)이라 그대로 노출.
  hideDetailLink?: boolean
  // 취소 뮤테이션 오버라이드 — 기본은 참가자 취소(lib/meeting/meeting-actions.cancelMeeting,
  // /api/meetings/{id}/cancel)인데, 그 엔드포인트는 미팅 당사자(exhibitor/buyer org)만 통과한다
  // (backend _assert_cancel_allowed). 운영자 배정 슬라이드(assignment-hub)처럼 운영자가 당사자가
  // 아닌 관점에서 이 패널을 재사용하는 호출부는 운영자 전용 취소 경로(lib/organizer/meeting-actions
  // .cancelAssignedMeeting → require_event_master)를 주입한다(QA 3차 #1 — "슈퍼관리자 미팅취소
  // 권한없음"의 원인이 바로 이 경로 불일치였다).
  cancelAction?: (
    meetingId: string,
    reasonCode: string,
    reasonText?: string
  ) => Promise<MeetingActionResult>
}) {
  const t = useTranslations("meeting.detailPanel")
  const cp = view.counterpart
  const org = view.org
  const { open: openOrgDetail, enabled: orgDetailEnabled } = useOrgDetail()

  return (
    <Card
      aria-label={t("aria", { name: cp.name })}
      className={cn(embedded && "rounded-none bg-transparent ring-0")}
    >
      <CardHeader>
        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-base font-bold"
          >
            {cp.name.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="truncate">{cp.name}</span>
              <Badge variant="secondary" className="font-normal">
                {cp.typeLabel}
              </Badge>
            </CardTitle>
            {cp.oneLiner && (
              <CardDescription className="mt-0.5 line-clamp-2 break-keep">
                {cp.oneLiner}
              </CardDescription>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* 매칭 근거 */}
        {view.match && (
          <div className="rounded-lg bg-accent/40 p-3">
            <div className="flex items-center gap-2.5">
              <span className="flex items-baseline gap-0.5 text-primary">
                <span className="text-2xl font-extrabold leading-none tabular-nums">
                  {view.match.score}
                </span>
                <span className="text-sm font-bold">%</span>
              </span>
              <span className="flex items-center gap-1 text-xs font-semibold text-primary">
                <Sparkles className="size-3" />
                {t("aiMatchTitle")}
              </span>
            </div>
            {view.match.reasons.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {view.match.reasons.map((reason) => (
                  <li key={reason} className="text-xs leading-relaxed text-foreground/75 break-keep">
                    · {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* 미팅 컨텍스트 */}
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className={cn("border-transparent", TONE_BADGE[view.tone])}
            >
              {view.statusLabel}
            </Badge>
            <span className="text-xs text-muted-foreground">{view.directionLabel}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="size-3.5 shrink-0" />
            <span className="tabular-nums">
              {view.time}
              {view.endTime !== view.time && <span> – {view.endTime}</span>}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" />
            <span className="truncate">{view.venue}</span>
          </div>
          {view.members.length > 0 && <MemberList members={view.members} />}
        </div>

        {/* 신청 메시지(H-03) — 신청 당시 적은 사유. 수신측(응답 대기)이 수락/거절을 판단하는
            핵심 정보라 상대가 신청한 경우 특히 중요하지만, 내가 적은 사유를 다시 확인하고
            싶을 수도 있어 direction과 무관하게 값이 있으면 늘 보여준다. */}
        {view.requestReason && (
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/20 p-3 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("requestReasonLabel")}
            </span>
            <p className="whitespace-pre-wrap break-keep text-sm leading-relaxed">
              {view.requestReason}
            </p>
          </div>
        )}

        {/* 액션 */}
        {view.actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {view.actions.map((action) => (
              <PanelActionButton key={action} action={action} view={view} cancelAction={cancelAction} />
            ))}
          </div>
        )}
      </CardContent>

      {/* 운영자 슬라이드(hideDetailLink)는 하단 신청서 인라인과 중복이라 이 푸터를 숨긴다.
          view.org가 null(탐색 목록에 없는 상대 — 승인 전 바이어)이면 상세 모달에 넘길 원본도,
          열릴 Discover 상세(미승인 기업은 404)도 없어 링크를 숨긴다. */}
      {!hideDetailLink && org && (
        <CardFooter className={cn(embedded && "rounded-none bg-transparent")}>
          <Button asChild variant="outline" className="w-full">
            {/* 평범한 좌클릭 → 공유 상세 모달, 수식키 클릭/우클릭 → detailHref 풀페이지(딥링크 폴백). */}
            <a
              href={view.detailHref}
              onClick={(e) => {
                // provider 없으면(폴백) 또는 수식키/보조클릭이면 preventDefault 하지 않고 detailHref 풀페이지로 흘려보낸다.
                if (!orgDetailEnabled || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                e.preventDefault()
                openOrgDetail(org, {
                  viewerRole: view.viewerRole,
                  match: view.match ?? undefined,
                })
              }}
            >
              {t("detailLink")}
              <ArrowUpRight className="size-4" />
            </a>
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function MemberList({ members }: { members: PanelMember[] }) {
  const t = useTranslations("meeting.detailPanel")
  return (
    <div className="flex items-start gap-1.5 text-muted-foreground">
      <Users className="mt-0.5 size-3.5 shrink-0" />
      <ul className="flex min-w-0 flex-col gap-0.5">
        {members.map((m) => (
          <li key={`${m.side}-${m.name}`} className="truncate text-xs">
            <span className="font-medium text-foreground/80">{m.name}</span>
            <span> · {m.title}</span>
            <span className="ml-1 text-[10px] text-muted-foreground/70">
              {m.side === "us" ? t("memberUs") : t("memberThem")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// 수락/거절/취소 결과 안내. 실패 문구는 로케일에 맞춰 고른다(lib/meeting/action-error.ts):
// ko는 백엔드 message(SLOT_TAKEN/VENUE_TAKEN/INVALID_TRANSITION 등 이미 충분히 구체적인 한국어 문장)를
// 그대로, en은 에러 코드를 번역 문구로 옮기고, 둘 다 없으면 카탈로그의 일반 실패 문구로 폴백한다.
function reportResult(
  result: MeetingActionResult,
  copy: { success: string; error: string },
  onSuccess: () => void,
  describeFailure: (result: MeetingActionResult, fallback: string) => string
) {
  if (result.success) {
    toast(copy.success)
    onSuccess()
    return
  }
  toast(describeFailure(result, copy.error))
}

function PanelActionButton({
  action,
  view,
  cancelAction,
}: {
  action: SlotAction
  view: MeetingPanelView
  cancelAction?: (
    meetingId: string,
    reasonCode: string,
    reasonText?: string
  ) => Promise<MeetingActionResult>
}) {
  const router = useRouter()
  const t = useTranslations("meeting.toast")
  const tPanel = useTranslations("meeting.detailPanel")
  const tErrors = useTranslations("meeting.errors")
  const locale = resolveLocale(useLocale())
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const describeFailure = (result: MeetingActionResult, fallback: string) =>
    meetingActionErrorMessage(result, locale, tErrors, fallback)

  // 리뷰는 MY-002 상세로 이동(F-MY-001 D14). 이미 작성된 회의록이면 "회의록 보기"(케이스 9),
  // 미작성이면 "회의록 작성"(케이스 8).
  if (action === "review") {
    return (
      <Button asChild size="lg" className="flex-1 font-semibold">
        <a href={`/meetings/${view.meetingId}`}>{view.reviewDone ? tPanel("actionReviewDone") : tPanel(ACTION_LABEL_KEY.review)}</a>
      </Button>
    )
  }

  // 노쇼↔참석 정정(F-MY-001)은 이 슬라이스의 범위 밖 — 자리만 유지(안내 토스트).
  if (action === "attendance") {
    return (
      <Button
        size="lg"
        variant="outline"
        className="flex-1 font-semibold"
        onClick={() => toast(tPanel("comingSoon", { action: tPanel(ACTION_LABEL_KEY[action]) }))}
      >
        {tPanel(ACTION_LABEL_KEY[action])}
      </Button>
    )
  }

  async function handleAccept() {
    // 실 세션(NEXT_PUBLIC_AUTH_CLIENT==="http")이 아니면 실제 백엔드가 없다 — 기존 목업 자리표시
    // 그대로(어드민과 동일 스위치, lib/meeting/meeting-actions.ts 참고).
    if (!isMeetingHttpMode()) {
      toast(tPanel("comingSoon", { action: tPanel(ACTION_LABEL_KEY.accept) }))
      return
    }
    setBusy(true)
    const result = await acceptMeeting(view.meetingId)
    setBusy(false)
    reportResult(
      result,
      { success: t("acceptSuccess"), error: t("acceptError") },
      () => router.refresh(),
      describeFailure
    )
  }

  async function handleReasonSubmit(reasonCode: string, reasonText?: string) {
    setBusy(true)
    const result =
      action === "reject"
        ? await rejectMeeting(view.meetingId, reasonCode, reasonText)
        : await (cancelAction ?? cancelMeeting)(view.meetingId, reasonCode, reasonText)
    setBusy(false)
    const copy =
      action === "reject"
        ? { success: t("rejectSuccess"), error: t("rejectError") }
        : { success: t("cancelSuccess"), error: t("cancelError") }
    reportResult(
      result,
      copy,
      () => {
        setDialogOpen(false)
        router.refresh()
      },
      describeFailure
    )
  }

  if (action === "accept") {
    return (
      <Button size="lg" className="flex-1 font-semibold" onClick={handleAccept} disabled={busy}>
        {tPanel(ACTION_LABEL_KEY.accept)}
      </Button>
    )
  }

  // reject / cancel — 키워드 라디오 + 자유입력('other'면 필수) 다이얼로그를 거친다(F-MY-001).
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        className="flex-1 font-semibold"
        onClick={() => {
          if (!isMeetingHttpMode()) {
            toast(tPanel("comingSoon", { action: tPanel(ACTION_LABEL_KEY[action]) }))
            return
          }
          setDialogOpen(true)
        }}
      >
        {tPanel(ACTION_LABEL_KEY[action])}
      </Button>
      <MeetingReasonDialog
        mode={action}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleReasonSubmit}
        busy={busy}
      />
    </>
  )
}

// 빈 상태 A/B/슬롯(F-MY-001). A=아직 잡을 수 있음(파트너 찾기 유도), B=잡을 수 없음(담백한 안내),
// empty-slot=빈 시간대를 직접 선택했을 때(그 시간을 채울 기업 탐색 유도).
//
// 행사의 참가자 메뉴가 "미팅만"이면(F-NV-001 D15) 기업 탐색이 메뉴에 없다 — A·empty-slot에서 탐색으로
// 보내는 버튼을 내지 않고, 설명도 탐색을 권하지 않는 중립 문구로 바꾼다. 제목은 원래 중립이라 그대로 쓴다.
export function MeetingPanelEmpty({ kind }: { kind: PanelEmptyKind }) {
  const t = useTranslations("meeting.detailPanel")
  const meetingsOnly = useParticipantMenu() === "meetings_only"
  if (kind === "empty-slot") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarSearch />
          </EmptyMedia>
          <EmptyTitle>{t("emptySlotTitle")}</EmptyTitle>
          <EmptyDescription className="break-keep">
            {meetingsOnly ? t("emptySlotMeetingsOnlyDescription") : t("emptySlotDescription")}
          </EmptyDescription>
        </EmptyHeader>
        {!meetingsOnly && (
          <EmptyContent>
            <Link href="/discover" className={cn(buttonVariants({ size: "lg" }), "w-full font-semibold")}>
              {t("emptySlotCta")}
            </Link>
          </EmptyContent>
        )}
      </Empty>
    )
  }
  if (kind === "find-partner") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarSearch />
          </EmptyMedia>
          <EmptyTitle>{t("findPartnerTitle")}</EmptyTitle>
          <EmptyDescription className="break-keep">
            {meetingsOnly ? t("findPartnerMeetingsOnlyDescription") : t("findPartnerDescription")}
          </EmptyDescription>
        </EmptyHeader>
        {!meetingsOnly && (
          <EmptyContent>
            <Link href="/discover" className={cn(buttonVariants({ size: "lg" }), "w-full font-semibold")}>
              {t("findPartnerCta")}
            </Link>
          </EmptyContent>
        )}
      </Empty>
    )
  }
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarX />
        </EmptyMedia>
        <EmptyTitle>{t("noMeetingsTitle")}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}
