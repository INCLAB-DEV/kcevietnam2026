"use client"

// 언어 토글(KO/EN) — nav 하단(사무국 문의 근처)·로그인/웰컴 우상단(EventBrandPanel)에 배치.
// 쿠키(NEXT_LOCALE)를 갱신하는 Server Function을 호출한 뒤 router.refresh()로 Server Component
// (nav 라벨·페이지 텍스트 등)까지 새 locale로 다시 그린다. i18n 라우팅이 아니므로 URL은 그대로다.
import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { setLocaleCookie } from "@/lib/i18n/actions"
import { SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/config"

const LABELS: Record<Locale, string> = { ko: "KO", en: "EN" }

interface LocaleToggleProps {
  className?: string
  // inverted: EventBrandPanel처럼 어두운 배경 위에 올릴 때 — 밝은 배경 전제인 기본 톤 대신 쓴다.
  tone?: "default" | "inverted"
}

export function LocaleToggle({ className, tone = "default" }: LocaleToggleProps) {
  const locale = useLocale() as Locale
  const t = useTranslations("common")
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const inverted = tone === "inverted"

  function switchTo(next: Locale) {
    if (next === locale || pending) return
    startTransition(async () => {
      await setLocaleCookie(next)
      router.refresh()
    })
  }

  return (
    <div
      role="group"
      aria-label={t("languageToggleLabel")}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border p-0.5 text-xs font-semibold",
        inverted ? "border-background/25" : "border-border bg-background",
        className
      )}
    >
      {SUPPORTED_LOCALES.map((value) => {
        const active = locale === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => switchTo(value)}
            aria-pressed={active}
            disabled={pending}
            className={cn(
              "rounded px-2 py-1 transition-colors disabled:opacity-60",
              inverted
                ? active
                  ? "bg-background text-foreground"
                  : "text-background/70 hover:bg-background/10 hover:text-background"
                : active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {LABELS[value]}
          </button>
        )
      })}
    </div>
  )
}
