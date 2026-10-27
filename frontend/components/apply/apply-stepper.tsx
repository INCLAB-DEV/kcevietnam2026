"use client"

// 단계 진행 표시 — 완료(체크)·현재·잠금 상태를 보여주고, 진입 가능한 단계로 점프할 수 있게 한다.
// 모바일 우선: 좁은 화면에선 라벨을 숨기고 점만, 넓으면 라벨도 노출.

import { useTranslations } from "next-intl"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  STEPS,
  type StepNumber,
} from "@/lib/apply/form-state"

interface ApplyStepperProps {
  current: StepNumber
  completed: Set<StepNumber>
  furthest: StepNumber
  onJump: (step: StepNumber) => void
}

export function ApplyStepper({ current, completed, furthest, onJump }: ApplyStepperProps) {
  const t = useTranslations("applyBuyer")
  return (
    <nav aria-label={t("stepperAria")} className="flex items-center justify-between gap-1">
      {STEPS.map((step, i) => {
        const isDone = completed.has(step)
        const isCurrent = step === current
        const reachable = step <= furthest
        return (
          <div key={step} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onJump(step)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center gap-1.5 text-center",
                reachable ? "cursor-pointer" : "cursor-not-allowed opacity-50",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  isCurrent && "border-foreground bg-foreground text-background",
                  !isCurrent && isDone && "border-foreground bg-background text-foreground",
                  !isCurrent && !isDone && "border-input bg-background text-muted-foreground",
                )}
              >
                {isDone && !isCurrent ? <Check className="size-3.5" /> : step}
              </span>
              <span
                className={cn(
                  "hidden truncate text-[0.7rem] sm:block",
                  isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {t(`stepTitles.${step}`)}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                className={cn(
                  "mx-1 h-px flex-1",
                  step < furthest ? "bg-foreground/40" : "bg-border",
                )}
              />
            )}
          </div>
        )
      })}
    </nav>
  )
}
