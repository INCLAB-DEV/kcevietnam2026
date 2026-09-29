"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications/store"
import { useNotifications } from "@/lib/notifications/use-notifications"
import {
  markAllNotificationsReadHttp,
  markNotificationReadHttp,
  fetchNotificationPageHttp,
} from "@/lib/notifications/inbox-actions"
import {
  Bell,
  CalendarCheck,
  CalendarX,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileCheck2,
  Loader2,
  MailQuestion,
  PenLine,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  filterByType,
  markAllAsRead,
  markAsRead,
  notificationFilters,
  notificationHref,
  notificationMessage,
  notificationTypeLabel,
  pinnedReminders,
  sortByNewest,
  unreadCount,
} from "@/lib/notifications/inbox"
import type {
  NotificationFilter,
  NotificationInboxPage,
  NotificationItem,
  NotificationType,
} from "@/lib/notifications/types"

const TYPE_ICON: Record<NotificationType, React.ElementType> = {
  meeting_requested: MailQuestion,
  meeting_accepted: CalendarCheck,
  meeting_cancelled: CalendarX,
  meeting_rejected: CalendarX, // 거절 — 취소와 같은 아이콘(둘 다 "미팅이 성사되지 않았다" 계열)
  meeting_reminder: Clock,
  review_prompt: PenLine, // 대시보드(HM-001 notification-card)와 동일한 연필 아이콘으로 통일
  review_ready: FileCheck2, // 회의록 정리 완료 — 문서+체크
  application_approved: CheckCircle2, // 신청 승인 완료
}

// KST 기준 날짜·시간. scheduled_*·createdAt 은 +09:00 오프셋을 담고 있어 timeZone 고정으로 드리프트
// 없음. 표기 스타일(월/일 자리·구두점)만 locale에 맡긴다 — 시간대는 항상 Asia/Seoul(행사 현지).
function formatKst(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(new Date(iso))
}

interface NotificationInboxProps {
  orgId: string
  memberName: string
  // 실 세션 초기 페이지(서버 컴포넌트가 SSR로 미리 읽어온다, lib/notifications/http-inbox-client).
  // 있으면 real 모드 — 읽음/전체읽음/더보기를 app/api/notifications BFF로 호출한다. 없으면(undefined)
  // 기존 mock 모드 — 반응형 인메모리 스토어(lib/notifications/store)를 그대로 구독한다
  // (mock 모드 보존 원칙, app/notifications/page.tsx가 세션에 따라 갈라 넘긴다).
  initial?: NotificationInboxPage
}

export function NotificationInbox({ orgId, memberName, initial }: NotificationInboxProps) {
  const router = useRouter()
  const t = useTranslations("notifications")
  const locale = useLocale()
  const isReal = initial !== undefined

  // mock 모드 데이터 원천 — 반응형 스토어 구독. real 모드에서도 Hooks 규칙상 항상 호출하되 값은
  // 버린다(store는 알 수 없는 orgId엔 빈 배열을 돌려줘 무해하다).
  const storeItems = useNotifications(orgId)

  const [realItems, setRealItems] = useState<NotificationItem[]>(initial?.items ?? [])
  const [realUnread, setRealUnread] = useState<number>(initial?.unreadCount ?? 0)
  const [nextCursor, setNextCursor] = useState<string | null>(initial?.nextCursor ?? null)
  const [loadingMore, setLoadingMore] = useState(false)

  const [filter, setFilter] = useState<NotificationFilter>("all")

  const items = isReal ? realItems : storeItems
  const unread = isReal ? realUnread : unreadCount(items)
  const pinned = useMemo(() => pinnedReminders(items), [items])
  const visible = useMemo(() => sortByNewest(filterByType(items, filter)), [items, filter])
  const filters = notificationFilters(t)

  function openNotification(n: NotificationItem) {
    // org 공유 읽음: 클릭 시 읽음 처리 후 미팅으로 이동(딥링크 from=notifications).
    if (n.readAt === null) {
      if (isReal) {
        const readAt = new Date().toISOString()
        setRealItems((prev) => markAsRead(prev, n.id, memberName, readAt))
        setRealUnread((c) => Math.max(0, c - 1))
        void markNotificationReadHttp(n.id).then((ok) => {
          if (!ok) {
            // 실패 시 낙관적 갱신을 되돌린다 — 다음 새로고침에서 실제 서버 상태로 맞춰진다.
            setRealItems((prev) => prev.map((it) => (it.id === n.id ? { ...it, readAt: null, readByMemberName: null } : it)))
            setRealUnread((c) => c + 1)
          }
        })
      } else {
        markNotificationRead(orgId, n.id, memberName)
      }
    }
    router.push(notificationHref(n))
  }

  function handleMarkAllRead() {
    if (isReal) {
      const readAt = new Date().toISOString()
      const before = realItems
      setRealItems((prev) => markAllAsRead(prev, memberName, readAt))
      setRealUnread(0)
      void markAllNotificationsReadHttp().then((ok) => {
        if (!ok) {
          setRealItems(before)
          setRealUnread(unreadCount(before))
        }
      })
    } else {
      markAllNotificationsRead(orgId, memberName)
    }
  }

  async function handleLoadMore() {
    if (!isReal || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchNotificationPageHttp(orgId, nextCursor)
      if (page) {
        setRealItems((prev) => [...prev, ...page.items])
        setRealUnread(page.unreadCount)
        setNextCursor(page.nextCursor)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("unreadCount", { count: unread })}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleMarkAllRead}
          disabled={unread === 0}
        >
          <CheckCheck className="size-4" />
          {t("markAllRead")}
        </Button>
      </header>

      {/* 모바일 상단 버블업: 안읽은 10분 리마인더(현장 시급). 데스크톱에선 숨김 — 목록에 함께 노출. */}
      {pinned.length > 0 && (
        <section className="flex flex-col gap-2 md:hidden" aria-label={t("pinnedRemindersAria")}>
          {pinned.map((n) => (
            <button
              key={`pinned-${n.id}`}
              type="button"
              onClick={() => openNotification(n)}
              className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-left"
            >
              <Clock className="size-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-sm font-medium">{notificationMessage(n, t)}</span>
            </button>
          ))}
        </section>
      )}

      {/* type 필터 (전체 + 6종). 드롭다운 v1 컷 — 칩 토글. */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("filterAria")}>
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              filter === f.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="flex flex-col gap-2">
        {visible.length === 0 && (
          <li className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-muted-foreground">
            <Bell className="size-6" />
            <span className="text-sm">{t("emptyState")}</span>
          </li>
        )}
        {visible.map((n) => {
          const Icon = TYPE_ICON[n.type]
          const isUnread = n.readAt === null
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openNotification(n)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                  isUnread ? "border-border bg-card" : "border-transparent bg-muted/40",
                )}
              >
                {/* 좌측 칼럼: (1줄) 아이콘 + 생성시간 / (2줄) 타이틀 */}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className={cn("size-4 shrink-0", isUnread ? "text-primary" : "text-muted-foreground")} />
                    <span>{formatKst(n.createdAt, locale)}</span>
                    {isUnread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t("unreadAria")} />}
                    {n.readAt && (
                      <span className="truncate">
                        {n.readByMemberName
                          ? t("readByNamed", { name: n.readByMemberName, time: formatKst(n.readAt, locale) })
                          : t("readByAnon", { time: formatKst(n.readAt, locale) })}
                      </span>
                    )}
                  </div>
                  <p
                    className={cn(
                      "text-sm",
                      isUnread ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {notificationMessage(n, t)}
                  </p>
                </div>
                {/* 우측 트레일링: 유형 + 꺽쇠 (행 전체 기준 세로 중앙·우측정렬) */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="secondary" className="text-xs font-normal">
                    {notificationTypeLabel(n.type, t)}
                  </Badge>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      {/* 더보기 — 실 세션 커서 페이지네이션. mock 모드는 스토어 전량을 이미 보유해 해당 없음. */}
      {isReal && nextCursor && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="size-4 animate-spin" />}
            {loadingMore ? t("loadingMore") : t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}
