// 로그인 좌측(데스크톱)·상단(모바일) 브랜드 패널. "어느 행사의·무엇을 위한 진입"인지 각인한다.
// 화면 한쪽을 꽉 채워(2분할) 폼이 빈 화면에 떠 있는 옹졸함을 없앤다. Server Component(getTranslations).
//
// login/welcome/signup 세 화면이 이 패널을 공유한다. 문구는 대부분 공용(login 네임스페이스)이지만
// heroDescription만 화면 맥락에 따라 달라진다 — 예) login은 "별도 가입 없이 DX Korea 계정으로
// 시작합니다"라고 못박는데, 그 문구를 그대로 가입 화면에 노출하면 자기모순이 된다. variant로
// signup 네임스페이스의 heroDescription을 갈아끼운다. 기본값 "login"이라 기존 화면은 무변경.
import { CalendarDays, CalendarClock, MapPin } from "lucide-react"
import { getLocale, getTranslations } from "next-intl/server"

import { CURRENT_EVENT } from "@/lib/event/current-event"
import { resolveLocale } from "@/lib/i18n/config"
import { LocaleToggle } from "@/components/layout/locale-toggle"
import { ThemeToggle } from "@/components/layout/theme-toggle"

export interface EventBrandPanelProps {
  variant?: "login" | "signup"
}

export async function EventBrandPanel({ variant = "login" }: EventBrandPanelProps = {}) {
  const t = await getTranslations("login")
  const heroDescription =
    variant === "signup" ? (await getTranslations("signup"))("heroDescription") : t("heroDescription")
  const event = CURRENT_EVENT[resolveLocale(await getLocale())]
  return (
    <aside className="flex flex-col justify-between gap-10 bg-foreground px-6 py-8 text-background md:min-h-svh md:gap-12 md:px-12 md:py-12">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-base font-bold tracking-tight">NABI</span>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <span className="text-xs font-medium text-background/55">{t("brandTagline")}</span>
          {/* 로그인/웰컴 우상단 언어·화면 밝기 토글 — 세 화면 모두 이 패널을 재사용하므로 여기 한 곳에
              둔다. 패널은 라이트/다크 어느 쪽에서도 페이지와 반대 톤(bg-foreground)이라 inverted. */}
          <div className="flex items-center gap-1.5">
            <LocaleToggle tone="inverted" />
            <ThemeToggle tone="inverted" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-background/25 px-3 py-1 text-xs font-semibold tracking-tight">
          <span className="size-1.5 rounded-full bg-background" aria-hidden />
          {event.name}
        </span>
        <h1 className="whitespace-pre-line text-3xl font-bold leading-[1.15] tracking-tight md:text-4xl">
          {t("heroTitle")}
        </h1>
        <p className="max-w-sm text-sm leading-relaxed text-background/70 md:text-base">
          {heroDescription}
        </p>
      </div>

      <dl className="flex flex-col gap-2.5 text-sm text-background/70">
        <div className="flex items-center gap-2.5">
          <CalendarDays className="size-4 shrink-0" />
          <span className="font-medium text-background">{event.dateLabel}</span>
        </div>
        <div className="flex items-start gap-2.5">
          <MapPin className="mt-0.5 size-4 shrink-0" />
          <span className="leading-snug">
            {event.venue}
            <span className="text-background/50"> · {event.venueAddress}</span>
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <CalendarClock className="size-4 shrink-0" />
          <span>{event.applicationPeriodLabel}</span>
        </div>
      </dl>
    </aside>
  )
}
