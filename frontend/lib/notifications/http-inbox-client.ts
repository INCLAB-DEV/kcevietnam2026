import "server-only"

// /notifications 인박스의 **서버 초기 페이지 조회** — FastAPI GET /api/notifications를 서버에서
// 직접 호출한다(미팅·홈 알림 카드 실연동과 같은 패턴, 인증 헤더는 로그인 BFF의 httpOnly 세션 쿠키).
// org는 principal(Bearer)에서 백엔드가 자동 해석한다.
//
// lib/home/http-notifications-client.ts(홈 대시보드 카드 + nav 배지)와 의도적으로 분리한다 — 그
// 모듈 상단 주석이 명시하듯 인박스 전체(필터·더보기·org 공유 읽음)는 범위 밖의 별도 작업이었다.
// 클라이언트 쪽 뮤테이션·페이지네이션(더보기)은 app/api/notifications/[[...path]] BFF 경유
// (lib/notifications/inbox-actions.ts)로 별도 처리한다 — 이 파일은 최초 SSR 페이지만 담당.

import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { toInboxItem, type NotificationOutSnake } from "@/lib/home/notification-composer"
import type { NotificationInboxPage } from "./types"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

interface InboxResponseSnake {
  items: NotificationOutSnake[]
  unread_count: number
  next_cursor: string | null
}

// 세션 쿠키가 없거나 백엔드가 죽어 있으면 조용히 null — 호출부(app/notifications/page.tsx)가
// mock 인박스로 폴백한다(mock 모드 보존).
export async function fetchNotificationInboxPage(
  recipientOrgId: string,
  limit = 30,
): Promise<NotificationInboxPage | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const res = await fetch(`${BACKEND_URL}/api/notifications?limit=${limit}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as InboxResponseSnake
    return {
      items: data.items.map((item) => toInboxItem(item, recipientOrgId)),
      unreadCount: data.unread_count,
      nextCursor: data.next_cursor,
    }
  } catch {
    return null
  }
}
