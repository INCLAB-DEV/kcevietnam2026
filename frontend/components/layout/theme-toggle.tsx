"use client"

// 화면 밝기 토글(라이트/다크/시스템) — nav 푸터·로그인 브랜드 패널·어드민 사이드바 푸터에 배치.
// next-themes가 <html>에 .dark 클래스를 붙이고(attribute="class") 선택값을 localStorage에 저장하므로
// 여기서는 setTheme만 호출하면 된다. 선택하지 않은 동안의 기본값은 "system"이고, theme-provider.tsx의
// 숨은 단축키(d)도 그대로 살아 있다(그쪽은 라이트/다크만 왕복).
//
// 디자인은 LocaleToggle(components/layout/locale-toggle.tsx)의 세그먼트 컨트롤을 그대로 미러한다 —
// 두 토글이 나란히 놓이므로 테두리·패딩·active 규칙이 어긋나면 한 세트로 안 보인다. 라벨은 공간
// 절약을 위해 아이콘만 노출하고 aria-label/title로 읽힌다.
import { useSyncExternalStore } from "react"
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

type ThemeOption = "light" | "dark" | "system"

const OPTIONS: { value: ThemeOption; icon: LucideIcon; labelKey: string }[] = [
  { value: "light", icon: Sun, labelKey: "themeLight" },
  { value: "dark", icon: Moon, labelKey: "themeDark" },
  { value: "system", icon: Monitor, labelKey: "themeSystem" },
]

// 하이드레이션 가드 — 서버 스냅샷은 false, 클라 스냅샷은 true. React가 하이드레이션까지는 서버
// 스냅샷을 쓰고 끝난 뒤 클라 값으로 다시 그리므로, useState+useEffect(cascading render로 lint에
// 걸린다) 없이 "마운트됐는가"를 안전하게 얻는다. subscribe는 구독할 외부 소스가 없어 no-op.
const NOOP_UNSUBSCRIBE = () => {}
const subscribeNothing = () => NOOP_UNSUBSCRIBE
const getClientSnapshot = () => true
const getServerSnapshot = () => false

interface ThemeToggleProps {
  className?: string
  // inverted: EventBrandPanel처럼 어두운 배경 위에 올릴 때 — 밝은 배경 전제인 기본 톤 대신 쓴다.
  tone?: "default" | "inverted"
}

export function ThemeToggle({ className, tone = "default" }: ThemeToggleProps) {
  // active 판정은 resolvedTheme이 아니라 theme(사용자가 고른 값) — "시스템"을 고른 상태가 보여야 한다.
  const { theme, setTheme } = useTheme()
  const t = useTranslations("common")
  const inverted = tone === "inverted"

  // 서버 렌더 시엔 저장된 테마를 알 수 없다. 마운트 전에는 어느 버튼도 active로 칠하지 않고 비활성
  // 상태로 같은 크기의 자리만 잡아, hydration mismatch와 레이아웃 점프를 동시에 피한다.
  const mounted = useSyncExternalStore(subscribeNothing, getClientSnapshot, getServerSnapshot)

  return (
    <div
      role="group"
      aria-label={t("themeToggleLabel")}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border p-0.5 text-xs font-semibold",
        inverted ? "border-background/25" : "border-border bg-background",
        className
      )}
    >
      {OPTIONS.map(({ value, icon: Icon, labelKey }) => {
        const label = t(labelKey)
        const active = mounted && theme === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={label}
            title={label}
            aria-pressed={active}
            disabled={!mounted}
            className={cn(
              "inline-flex items-center justify-center rounded px-2 py-1 transition-colors disabled:opacity-60",
              inverted
                ? active
                  ? "bg-background text-foreground"
                  : "text-background/70 hover:bg-background/10 hover:text-background"
                : active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {/* size-4 = text-xs 줄높이와 동일 → LocaleToggle(KO/EN 텍스트) 버튼과 높이가 딱 맞는다. */}
            <Icon className="size-4" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
