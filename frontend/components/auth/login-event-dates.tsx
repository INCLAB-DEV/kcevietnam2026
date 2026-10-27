// /login 카드 아래 날짜 안내 2행(시안: 캘린더 아이콘 + 빨간 라벨 + 기간). 로그인 전용이다.
//
// 값은 하드코딩하지 않고 행사 상수(CURRENT_EVENT)에서 온다 — 공용 브랜드 패널이 쓰던 것과 같은
// 출처라 행사가 바뀌면 두 화면이 함께 따라간다.
//
// 2행 "비즈매칭 신청기간"은 표시 전용 안내다 — 신청 게이트는 날짜로 막지 않는다(2026-09-11 결정
// 유지). 시안대로 기간을 보여달라는 발주자 지시(2026-09-18)에 따라 CURRENT_EVENT의
// applicationPeriodDateLabel(표시 전용 상수)을 라벨과 함께 노출한다.

import { CalendarClock, CalendarDays } from "lucide-react"
import { getLocale, getTranslations } from "next-intl/server"

import { CURRENT_EVENT } from "@/lib/event/current-event"
import { resolveLocale } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"
import { LOGIN_ACCENT_TEXT_CLASS } from "@/components/auth/login-visual"

export async function LoginEventDates() {
  const t = await getTranslations("login")
  const event = CURRENT_EVENT[resolveLocale(await getLocale())]
  return (
    <ul className="flex flex-col gap-2 px-1 text-sm sm:px-2">
      <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <CalendarDays className={cn("size-4 shrink-0", LOGIN_ACCENT_TEXT_CLASS)} aria-hidden />
        <span className={cn("font-bold", LOGIN_ACCENT_TEXT_CLASS)}>{t("periodExhibition")}</span>
        <span className="text-foreground">{event.dateLabel}</span>
      </li>
      <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <CalendarClock className={cn("size-4 shrink-0", LOGIN_ACCENT_TEXT_CLASS)} aria-hidden />
        <span className={cn("font-bold", LOGIN_ACCENT_TEXT_CLASS)}>{t("periodApplication")}</span>
        <span className="text-foreground">{event.applicationPeriodDateLabel}</span>
      </li>
    </ul>
  )
}
