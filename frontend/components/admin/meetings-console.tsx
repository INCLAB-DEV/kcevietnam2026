"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Ban, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { pageCount, pageItems, paginate } from "@/lib/organizer/members"
import {
  ADMIN_MEETING_STATUSES,
  ADMIN_MEETING_STATUS_LABELS,
  VENUE_TYPE_LABELS,
  type AdminMeeting,
  type AdminMeetingStatus,
} from "@/lib/admin/types"
import {
  applyCancel,
  canCancelMeeting,
  EMPTY_MEETING_FILTERS,
  filterMeetings,
  meetingDateOptions,
  sortMeetingsBySchedule,
} from "@/lib/admin/meetings"
import { meetingsToCsv, meetingsToXls } from "@/lib/admin/export"
import { cancelMeeting } from "@/lib/admin/admin-actions"
import { formatEventDate } from "@/lib/admin/events"
import {
  EmptyResult,
  FacetFilter,
  MatchingTypeBadge,
  MeetingStatusBadge,
  SearchField,
  download,
  toggleSet,
} from "./shared"

// 미팅 관리 — 전체 미팅 조회 + 운영자 강제 취소.
// 취소는 예정(scheduled) 건에서만 열린다. 사유는 필수 — 양측에 발송되는 meeting_cancelled 알림
// payload에 그대로 실리기 때문이다(ADR-0010, 스냅샷 불변 기록).

export function MeetingsConsole({
  meetings,
  eventId,
  readOnly,
  actorName,
}: {
  meetings: AdminMeeting[]
  eventId: string
  readOnly: boolean
  actorName: string
}) {
  const [rows, setRows] = useState<AdminMeeting[]>(meetings)
  const [query, setQuery] = useState("")
  const [dates, setDates] = useState<Set<string>>(new Set())
  const [statuses, setStatuses] = useState<Set<AdminMeetingStatus>>(new Set())
  const [page, setPage] = useState(1)
  const [cancelling, setCancelling] = useState<AdminMeeting | null>(null)

  const dateOptions = useMemo(() => meetingDateOptions(rows), [rows])
  const dateLabels = useMemo(
    () => Object.fromEntries(dateOptions.map((d) => [d, formatEventDate(d)])) as Record<string, string>,
    [dateOptions],
  )

  const sorted = useMemo(() => {
    const filtered = filterMeetings(rows, {
      ...EMPTY_MEETING_FILTERS,
      query,
      dates: [...dates],
      statuses: [...statuses],
    })
    return sortMeetingsBySchedule(filtered)
  }, [rows, query, dates, statuses])

  const totalPages = pageCount(sorted.length)
  const safePage = Math.min(page, totalPages)
  const pageRows = paginate(sorted, safePage)

  function confirmCancel(reason: string) {
    if (!cancelling) return
    const target = cancelling
    setRows((prev) => prev.map((m) => (m.id === target.id ? applyCancel(m, reason, actorName) : m)))
    setCancelling(null)
    toast(`'${target.exhibitor_name} × ${target.buyer_name}' 미팅을 취소했어요`, {
      description: "양측에 취소 알림이 발송됩니다",
    })
    void cancelMeeting(eventId, target.id, reason).then((r) => {
      if (!r.success) {
        toast.error("서버 취소 처리에 실패했어요", {
          description: "새로고침 시 이전 상태로 보일 수 있어요",
        })
      }
    })
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {!readOnly && (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download data-icon="inline-start" />
                엑셀 내보내기
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  download(`sales-ai-${eventId}-미팅.csv`, meetingsToCsv(sorted), "text/csv;charset=utf-8")
                }
              >
                CSV로 내보내기
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  download(
                    `sales-ai-${eventId}-미팅.xls`,
                    meetingsToXls(sorted),
                    "application/vnd.ms-excel",
                  )
                }
              >
                Excel로 내보내기
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <SearchField
        placeholder="참가사·바이어 기업명으로 검색"
        onChange={(v) => { setQuery(v); setPage(1) }}
      />

      <div className="flex flex-wrap items-center gap-2">
        {dateOptions.length > 0 && (
          <FacetFilter
            label="날짜"
            options={dateOptions}
            labels={dateLabels}
            selected={dates}
            onToggle={(v) => { setDates((p) => toggleSet(p, v)); setPage(1) }}
          />
        )}
        <FacetFilter
          label="상태"
          options={ADMIN_MEETING_STATUSES}
          labels={ADMIN_MEETING_STATUS_LABELS}
          selected={statuses}
          onToggle={(v) => { setStatuses((p) => toggleSet(p, v)); setPage(1) }}
        />
        {(dates.size > 0 || statuses.size > 0) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => { setDates(new Set()); setStatuses(new Set()); setPage(1) }}
          >
            초기화
          </Button>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyResult
          title="미팅이 없습니다"
          description="다른 날짜나 상태 필터를 시도해보세요."
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            {sorted.length}건{totalPages > 1 && ` · ${safePage}/${totalPages} 페이지`}
          </span>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                  <TableHead>일시</TableHead>
                  <TableHead>참가사</TableHead>
                  <TableHead>바이어</TableHead>
                  <TableHead>장소</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead className="w-20" aria-label="작업" />
                </TableRow>
              </TableHeader>
              <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
                {pageRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={row.status === "cancelled" ? "opacity-60" : undefined}
                  >
                    <TableCell className="tabular-nums">
                      <span className="font-medium text-foreground">
                        {formatEventDate(row.date)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {row.start_time} · {row.slot_minutes}분
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.exhibitor_name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.buyer_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <Badge variant="outline">{VENUE_TYPE_LABELS[row.venue_type]}</Badge>
                      {row.venue_label && (
                        <span className="block text-xs">{row.venue_label}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <MeetingStatusBadge status={row.status} />
                        <MatchingTypeBadge matchingType={row.matching_type} />
                      </span>
                      {row.cancelled_reason && (
                        <span className="block max-w-48 truncate text-xs text-muted-foreground">
                          {row.cancelled_reason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {!readOnly && canCancelMeeting(row) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => setCancelling(row)}
                        >
                          <Ban data-icon="inline-start" />
                          취소
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text="이전"
                    href="#"
                    aria-disabled={safePage === 1}
                    className={safePage === 1 ? "pointer-events-none opacity-50" : undefined}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)) }}
                  />
                </PaginationItem>
                {pageItems(safePage, totalPages).map((item, i) =>
                  item === "ellipsis" ? (
                    <PaginationItem key={`e-${i}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        href="#"
                        isActive={item === safePage}
                        onClick={(e) => { e.preventDefault(); setPage(item) }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    text="다음"
                    href="#"
                    aria-disabled={safePage === totalPages}
                    className={safePage === totalPages ? "pointer-events-none opacity-50" : undefined}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(totalPages, p + 1)) }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}

      <CancelDialog
        meeting={cancelling}
        onOpenChange={(open) => !open && setCancelling(null)}
        onConfirm={confirmCancel}
      />
    </div>
  )
}

function CancelDialog({
  meeting,
  onOpenChange,
  onConfirm,
}: {
  meeting: AdminMeeting | null
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")

  return (
    <Dialog
      open={!!meeting}
      onOpenChange={(open) => {
        if (!open) setReason("")
        onOpenChange(open)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>미팅 취소</DialogTitle>
          <DialogDescription>
            {meeting
              ? `${formatEventDate(meeting.date)} ${meeting.start_time} · ${meeting.exhibitor_name} × ${meeting.buyer_name}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 px-5">
          <Label htmlFor="cancel-reason">취소 사유</Label>
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="예: 전시장 사정으로 슬롯 회수"
          />
          <p className="text-xs text-muted-foreground">
            사유는 양측에 발송되는 취소 알림에 그대로 실립니다.
          </p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">닫기</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            onClick={() => {
              onConfirm(reason.trim())
              setReason("")
            }}
          >
            미팅 취소
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
