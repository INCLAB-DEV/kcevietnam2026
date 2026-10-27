"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronsUpDown, MapPin } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { writeSelectedEvent } from "@/lib/admin/events"
import type { AdminEvent } from "@/lib/admin/types"

// 행사 스위처 — 슈퍼어드민 콘솔은 멀티 행사 운영 콘솔이라, 여기서 고른 행사가 모든 섹션의
// 데이터 스코프가 된다(기업·미팅·알림·설정·통역사).
//
// 선택을 쿠키에 박고 router.refresh()로 서버 컴포넌트를 다시 그린다 — 셸과 각 페이지가 같은 쿠키
// 하나를 읽으므로 헤더가 가리키는 행사와 표에 뜬 데이터가 어긋날 수 없다(dev 세션 쿠키와 동일 패턴).
// 클라 상태로 들고 있지 않는 이유: 서버에서 이미 스코프해 내려보내야 다른 행사 데이터가 애초에
// 클라 페이로드에 실리지 않는다.
export function EventSwitcher({
  events,
  selected,
}: {
  events: AdminEvent[]
  selected: AdminEvent
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function select(eventId: string) {
    if (eventId === selected.id) return
    // 쿠키에 기록(1년 유지 — 마지막에 보던 행사로 돌아오게) 후 서버 컴포넌트를 다시 그린다.
    writeSelectedEvent(eventId)
    startTransition(() => router.refresh())
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-auto min-w-0 max-w-full justify-start gap-2 py-1.5 text-left"
          aria-label="행사 선택"
          data-pending={pending ? "" : undefined}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium leading-tight">{selected.name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {selected.venue_name}
            </span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          관리할 행사 선택
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {events.map((event) => (
          <DropdownMenuItem
            key={event.id}
            onSelect={() => select(event.id)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{event.name}</span>
              {event.id === selected.id && <Check className="size-4 shrink-0" />}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{event.venue_name}</span>
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {event.exhibition_start} ~ {event.exhibition_end}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
