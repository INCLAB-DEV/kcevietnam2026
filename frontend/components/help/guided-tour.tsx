"use client"

// 요소 앵커드 가이드 투어(coach marks) — driver.js(vanilla DOM) 를 client effect 로 구동한다(F-HELP 투어).
// 현재 화면(usePathname)·역할(role)에 맞는 투어를 resolveTourId 로 정하고, TOURS[id]의 data-tour 앵커와
// next-intl(help.tour) 로케일 문구를 zip 하여 driver 스텝을 만든다.
//
// 두 가지 트리거:
//  ① 최초 방문 1회 자동 시작 — hasSeenTour/markTourSeen(localStorage) 로 화면×역할별 딱 한 번.
//  ② "가이드 다시 보기"(HelpButton) — replayNonce 증가로 플래그 무시하고 강제 재생.
//
// 화면과 무관하게 항상 마운트되지만, 투어가 없는 화면(tourId=null)에서는 아무 것도 하지 않는다.
// DOM(null) 을 렌더하지 않으므로 레이아웃·기존 테스트에 영향이 없다. 오버레이/팝오버 스타일은 app/globals.css
// 의 .nabi-tour 오버라이드(디자인 토큰)로 앱과 이질감 없게 맞췄다(driver.css 는 globals.css 에서 @import).

import { useCallback, useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { driver, type Driver } from "driver.js"

import {
  resolveTourId,
  TOURS,
  hasSeenTour,
  markTourSeen,
  type TourId,
} from "@/lib/help/tour"
import type { UserRole } from "@/components/layout/nav"

// 앵커가 아직 마운트되지 않았을 수 있어(SSR 하이드레이션·차트 지연 렌더) 자동시작 전 약간 기다린다.
const AUTO_START_DELAY_MS = 500

interface GuidedTourProps {
  role: UserRole
  // HelpButton 의 "가이드 다시 보기"가 증가시키는 카운터. 0 초과로 바뀌면 seen 플래그와 무관하게 강제 시작.
  replayNonce?: number
}

export function GuidedTour({ role, replayNonce = 0 }: GuidedTourProps) {
  const pathname = usePathname() ?? "/"
  const t = useTranslations("help.tour")
  const tourId = resolveTourId(pathname, role)

  // 살아있는 driver 인스턴스 — 라우트 이동·언마운트 시 정리한다(오버레이 누수 방지).
  const driverRef = useRef<Driver | null>(null)

  const startTour = useCallback(
    (id: TourId) => {
      // 이미 떠 있던 투어가 있으면 먼저 걷어낸다(중복 오버레이 방지).
      driverRef.current?.destroy()

      const steps = TOURS[id].map((step, index) => ({
        element: step.element,
        popover: {
          title: t(`${id}.steps.${index}.title`),
          description: t(`${id}.steps.${index}.description`),
        },
      }))

      const instance = driver({
        showProgress: steps.length > 1,
        // "1 / 5" — 로케일 무관(숫자·슬래시)이라 번역 대상 아님. driver.js 가 {{current}}/{{total}} 치환.
        progressText: "{{current}} / {{total}}",
        allowClose: true, // 코너 X + ESC 로 종료(건너뛰기)
        overlayOpacity: 0.55,
        stagePadding: 6,
        stageRadius: 10,
        popoverClass: "nabi-tour",
        nextBtnText: t("controls.next"),
        prevBtnText: t("controls.prev"),
        doneBtnText: t("controls.done"),
        onDestroyed: () => {
          driverRef.current = null
        },
        steps,
      })

      driverRef.current = instance
      instance.drive()
    },
    [t]
  )

  // ① 최초 1회 자동 시작 — 화면(tourId)이 바뀔 때마다 판정. 앵커 마운트를 기다렸다 시작한다.
  useEffect(() => {
    if (!tourId) return
    if (hasSeenTour(tourId)) return
    markTourSeen(tourId) // 시작 전에 찍어 이중 실행(빠른 재마운트)에도 한 번만 뜨게.
    const timer = window.setTimeout(
      () => startTour(tourId),
      AUTO_START_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [tourId, startTour])

  // ② "가이드 다시 보기" — replayNonce 가 증가하면 seen 여부와 무관하게 즉시 재생(초기값 0은 무시).
  useEffect(() => {
    if (replayNonce <= 0) return
    if (!tourId) return
    startTour(tourId)
  }, [replayNonce, tourId, startTour])

  // 라우트 이동/언마운트 시 살아있는 투어 정리.
  useEffect(() => {
    return () => {
      driverRef.current?.destroy()
      driverRef.current = null
    }
  }, [pathname])

  return null
}
