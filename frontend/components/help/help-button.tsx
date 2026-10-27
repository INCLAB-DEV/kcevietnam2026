"use client"

// 상시 떠 있는 도움말(?) 버튼 + 클릭 시 열리는 역할·화면별 가이드 패널(F-HELP).
// 가이드 투어가 아니라 패널형이다 — 현재 화면(usePathname)과 뷰어 역할(role prop)에 맞는
// "이 화면에서 무엇을 / 어떻게" 안내를 shadcn Sheet(사이드 시트)로 보여준다.
//
// 마운트 지점(인증 화면 전역):
//  · components/layout/app-shell.tsx  — 참가자·운영자 사이드바 셸(홈/탐색/미팅/프로필/알림/운영자/*)
//  · components/admin/admin-shell.tsx — 슈퍼어드민 콘솔
//  · app/welcome · app/apply · app/exhibitor/apply — 셸 밖 단독 인증 화면
// login/signup 등 비인증 화면에는 마운트하지 않는다(아래 방어 가드로 이중 안전).
//
// 접근성: Sheet(Radix Dialog)가 ESC·바깥클릭 닫기, 포커스 트랩, 트리거로의 포커스 복귀를 기본 제공한다.
// 콘텐츠 문구는 messages/{ko,en}.json "help" 네임스페이스, 라우팅 규칙은 lib/help/content.ts.

import { useState } from "react"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { CircleHelp, PlayCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  applyHelpOverride,
  helpOverrideKey,
  resolveHelpTopicId,
  type HelpTopic,
  type HelpTopicOverride,
} from "@/lib/help/content"
import { resolveTourId } from "@/lib/help/tour"
import { GuidedTour } from "@/components/help/guided-tour"
import { useParticipantMenu } from "@/components/layout/participant-menu-provider"
import type { UserRole } from "@/components/layout/nav"
import type { ParticipantMenu } from "@/lib/event/participant-menu"

// 비인증 화면 — 여기선 렌더하지 않는다(마운트 지점 자체가 이미 인증 한정이라 방어선 성격).
const UNAUTHENTICATED_PREFIXES = ["/login", "/signup"]

interface HelpButtonProps {
  role: UserRole
  className?: string
  // 이 행사의 참가자 메뉴(F-NV-001 D15). 셸 안에서는 생략한다 — 셸이 내려준 값(useParticipantMenu)을 쓴다.
  // 셸 밖 단독 화면(/welcome)은 컨텍스트가 없어 직접 넘긴다. "미팅만"이면 메뉴에 없는 화면을 안내하는
  // 항목이 대체 문구로 바뀐다(lib/help/content.ts).
  participantMenu?: ParticipantMenu
}

export function HelpButton({ role, className, participantMenu: participantMenuProp }: HelpButtonProps) {
  const pathname = usePathname() ?? "/"
  const t = useTranslations("help")
  const shellParticipantMenu = useParticipantMenu()
  const participantMenu = participantMenuProp ?? shellParticipantMenu
  // Sheet 를 제어형으로 — "가이드 다시 보기"가 패널을 닫은 뒤 투어를 띄워야 하기 때문(닫지 않으면 시트
  // 오버레이가 투어를 가린다). replayNonce 증가 = GuidedTour 강제 재생 신호.
  const [open, setOpen] = useState(false)
  const [replayNonce, setReplayNonce] = useState(0)

  const unauthenticated = UNAUTHENTICATED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
  if (unauthenticated) return null

  const topicId = resolveHelpTopicId(pathname, role)
  const overrideKey = helpOverrideKey(topicId, participantMenu)
  const topic = applyHelpOverride(
    t.raw(topicId) as HelpTopic,
    overrideKey ? (t.raw(overrideKey) as HelpTopicOverride) : null
  )
  // 이 화면에 요소 앵커드 투어가 있으면 "가이드 다시 보기" 액션을 노출한다(없으면 패널만 — 폴백).
  const hasTour = resolveTourId(pathname, role) !== null

  function replayTour() {
    setOpen(false)
    // 시트 닫힘 애니메이션이 끝난 뒤 투어를 띄운다(오버레이·포커스 트랩 충돌 방지).
    window.setTimeout(() => setReplayNonce((n) => n + 1), 180)
  }

  return (
    <>
      {/* 요소 앵커드 가이드 투어 구동기 — DOM 을 렌더하지 않고 effect 로만 동작(최초 1회 자동 + 재생). */}
      <GuidedTour role={role} replayNonce={replayNonce} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            aria-label={t("buttonLabel")}
            className={cn(
              // 우하단 고정 FAB — 44px 터치 타깃, 사이드바/콘텐츠와 안 겹치게 뷰포트 기준 fixed.
              "fixed right-4 bottom-4 z-40 size-11 rounded-full shadow-lg md:right-6 md:bottom-6",
              className
            )}
          >
            <CircleHelp className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="gap-0 overflow-y-auto">
          <SheetHeader className="gap-2 border-b">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("panelEyebrow")}
            </p>
            <SheetTitle className="text-lg leading-snug">
              {topic.title}
            </SheetTitle>
            <SheetDescription className="leading-relaxed">
              {topic.intro}
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-6 p-4">
            {/* 요소 앵커드 가이드 투어 재생 — 이 화면에 투어가 있을 때만. 패널을 닫고 화면 위에서 단계별 안내. */}
            {hasTour ? (
              <Button
                type="button"
                variant="secondary"
                className="w-full justify-start gap-2"
                onClick={replayTour}
              >
                <PlayCircle className="size-4" />
                {t("tour.replay")}
              </Button>
            ) : null}

            <section
              aria-labelledby="help-steps-heading"
              className="flex flex-col gap-3"
            >
              <h3
                id="help-steps-heading"
                className="font-heading text-sm font-medium text-foreground"
              >
                {t("stepsHeading")}
              </h3>
              <ol className="flex flex-col gap-3">
                {topic.steps.map((step, index) => (
                  <li key={index} className="flex gap-3">
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
                    >
                      {index + 1}
                    </span>
                    <span className="pt-0.5 text-sm leading-relaxed text-foreground">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {topic.tips.length > 0 ? (
              <section
                aria-labelledby="help-tips-heading"
                className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3"
              >
                <h3
                  id="help-tips-heading"
                  className="font-heading text-sm font-medium text-foreground"
                >
                  {t("tipsHeading")}
                </h3>
                <ul className="flex list-disc flex-col gap-1.5 pl-4">
                  {topic.tips.map((tip, index) => (
                    <li
                      key={index}
                      className="text-sm leading-relaxed text-muted-foreground"
                    >
                      {tip}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
