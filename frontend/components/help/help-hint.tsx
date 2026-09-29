"use client"

// 호버 툴팁(보조 힌트) — 주요 요소(지표카드·주요 액션 버튼·필터 등)에 마우스를 올리면 짧은 힌트를 띄운다(F-HELP).
// shadcn/Radix Tooltip(components/ui/tooltip.tsx)을 그대로 재사용한다. 자기완결형(자체 Provider 포함)이라
// 감쌀 요소에 <HelpHint hint="...">{child}</HelpHint> 만 두면 되고, 셸에 Provider 를 추가할 필요가 없다.
//
// 접근성·모바일: TooltipTrigger asChild 로 자식 요소를 그대로 트리거로 쓰므로 DOM 래퍼가 추가되지 않는다
// (자식은 ref·props 를 전달하는 요소여야 한다 — Button·Card 등 shadcn 프리미티브는 모두 충족).
// 툴팁은 어디까지나 "보조" 힌트다 — 모바일(호버 없음)에서 필수 정보가 숨지 않도록, 핵심 안내는 투어·패널이 담는다.

import type { ReactNode } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface HelpHintProps {
  // 감쌀 요소 — Radix asChild 로 트리거가 된다(ref/props 전달 가능한 단일 요소여야 함).
  children: ReactNode
  // 로케일 처리된 힌트 문구(호출부에서 next-intl 로 뽑아 넘긴다).
  hint: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  // 호버 후 표시까지 지연(ms). 기본 300ms — 스치는 마우스에 즉시 뜨지 않게.
  delayMs?: number
}

export function HelpHint({
  children,
  hint,
  side = "top",
  align = "center",
  delayMs = 300,
}: HelpHintProps) {
  return (
    <TooltipProvider delayDuration={delayMs}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          className="max-w-56 text-center leading-snug"
        >
          {hint}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
