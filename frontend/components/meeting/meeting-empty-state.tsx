import { CalendarPlus } from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { MeetingEmptyState } from "@/lib/meeting/empty-state"

// MY-001 미팅 0건 빈 상태(F-MY-001 D13). 역할별 안내·다음행동은 empty-state 모듈이 결정한다.
// 다음행동이 없는 상태("미팅만" 행사 — 보낼 화면이 메뉴에 없다)는 안내만 그리고 버튼 영역을 내지 않는다.
export function MeetingEmptyStateView({ state }: { state: MeetingEmptyState }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarPlus />
        </EmptyMedia>
        <EmptyTitle>{state.title}</EmptyTitle>
        <EmptyDescription className="break-keep">{state.description}</EmptyDescription>
      </EmptyHeader>
      {(state.primary || state.secondary) && (
        <EmptyContent>
          {state.primary && (
            <a href={state.primary.href} className={cn(buttonVariants(), "w-full")}>
              {state.primary.label}
            </a>
          )}
          {state.secondary && (
            <a
              href={state.secondary.href}
              className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
            >
              {state.secondary.label}
            </a>
          )}
        </EmptyContent>
      )}
    </Empty>
  )
}
