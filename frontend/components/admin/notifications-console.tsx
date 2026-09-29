"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
  ADMIN_NOTIFICATION_CHANNEL_LABELS,
  ADMIN_NOTIFICATION_CHANNELS,
  ADMIN_NOTIFICATION_TYPE_LABELS,
  ADMIN_NOTIFICATION_TYPES,
  type AdminNotificationChannel,
  type AdminNotificationLog,
  type AdminNotificationType,
} from "@/lib/admin/types"
import {
  applyResend,
  EMPTY_NOTIFICATION_FILTERS,
  filterNotifications,
  sortNotificationsByRecent,
} from "@/lib/admin/notifications"
import { resendNotification } from "@/lib/admin/admin-actions"
import { EmptyResult, FacetFilter, SearchField, formatDateTime, toggleSet } from "./shared"

// 알림 관리 — 발송 이력 조회 + 수동 재발송.
// ADMIN_NOTIFICATION_TYPES × 2채널(인앱/이메일)이 한 표에 섞인다. 미전달 건이 재발송 대상이라 필터로 바로 추린다.

export function NotificationsConsole({
  logs,
  eventId,
  timeZone,
  readOnly,
}: {
  logs: AdminNotificationLog[]
  eventId: string
  timeZone: string
  readOnly: boolean
}) {
  const [rows, setRows] = useState<AdminNotificationLog[]>(logs)
  const [query, setQuery] = useState("")
  const [types, setTypes] = useState<Set<AdminNotificationType>>(new Set())
  const [channels, setChannels] = useState<Set<AdminNotificationChannel>>(new Set())
  const [failedOnly, setFailedOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const sorted = useMemo(() => {
    const filtered = filterNotifications(rows, {
      ...EMPTY_NOTIFICATION_FILTERS,
      query,
      types: [...types],
      channels: [...channels],
      failedOnly,
    })
    return sortNotificationsByRecent(filtered)
  }, [rows, query, types, channels, failedOnly])

  const totalPages = pageCount(sorted.length)
  const safePage = Math.min(page, totalPages)
  const pageRows = paginate(sorted, safePage)
  const failedCount = rows.filter((r) => !r.delivered).length

  function resend(log: AdminNotificationLog) {
    setPendingId(log.id)
    const at = new Date().toISOString()
    setRows((prev) => prev.map((r) => (r.id === log.id ? applyResend(r, at) : r)))
    toast(`'${log.recipient_org_name}'에 ${ADMIN_NOTIFICATION_TYPE_LABELS[log.type]} 알림을 재발송했어요`, {
      description: ADMIN_NOTIFICATION_CHANNEL_LABELS[log.channel],
    })
    void resendNotification(eventId, log.id).then((r) => {
      setPendingId(null)
      if (!r.success) {
        toast.error("재발송에 실패했어요", { description: "잠시 후 다시 시도해 주세요" })
      }
    })
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <SearchField
        placeholder="수신 조직명으로 검색"
        onChange={(v) => { setQuery(v); setPage(1) }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <FacetFilter
          label="알림 타입"
          options={ADMIN_NOTIFICATION_TYPES}
          labels={ADMIN_NOTIFICATION_TYPE_LABELS}
          selected={types}
          onToggle={(v) => { setTypes((p) => toggleSet(p, v)); setPage(1) }}
        />
        <FacetFilter
          label="채널"
          options={ADMIN_NOTIFICATION_CHANNELS}
          labels={ADMIN_NOTIFICATION_CHANNEL_LABELS}
          selected={channels}
          onToggle={(v) => { setChannels((p) => toggleSet(p, v)); setPage(1) }}
        />
        <Button
          type="button"
          size="sm"
          variant={failedOnly ? "default" : "outline"}
          aria-pressed={failedOnly}
          onClick={() => { setFailedOnly((v) => !v); setPage(1) }}
        >
          미전달만
          {failedCount > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {failedCount}
            </Badge>
          )}
        </Button>
        {(types.size > 0 || channels.size > 0 || failedOnly) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              setTypes(new Set())
              setChannels(new Set())
              setFailedOnly(false)
              setPage(1)
            }}
          >
            초기화
          </Button>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyResult
          title="발송 이력이 없습니다"
          description="다른 타입이나 채널 필터를 시도해보세요."
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            {sorted.length}건{totalPages > 1 && ` · ${safePage}/${totalPages} 페이지`}
          </span>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[850px]">
              <TableHeader>
                <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                  <TableHead>발송 시각</TableHead>
                  <TableHead>타입</TableHead>
                  <TableHead>채널</TableHead>
                  <TableHead>수신 조직</TableHead>
                  <TableHead>전달</TableHead>
                  <TableHead className="text-right">재발송</TableHead>
                  <TableHead className="w-24" aria-label="작업" />
                </TableRow>
              </TableHeader>
              <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
                {pageRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular-nums">{formatDateTime(row.sent_at, timeZone)}</TableCell>
                    <TableCell>
                      <span className="font-medium text-foreground">
                        {ADMIN_NOTIFICATION_TYPE_LABELS[row.type]}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Badge variant="outline">
                        {ADMIN_NOTIFICATION_CHANNEL_LABELS[row.channel]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.recipient_org_name}</TableCell>
                    <TableCell>
                      <Badge variant={row.delivered ? "secondary" : "destructive"}>
                        {row.delivered ? "전달됨" : "미전달"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.resend_count > 0 ? `${row.resend_count}회` : "-"}
                    </TableCell>
                    <TableCell>
                      {readOnly ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          disabled={pendingId === row.id}
                          onClick={() => resend(row)}
                        >
                          <RotateCw data-icon="inline-start" />
                          재발송
                        </Button>
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
    </div>
  )
}
