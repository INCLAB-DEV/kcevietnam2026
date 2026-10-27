import "server-only"

import { redirect } from "next/navigation"

// 홈 대시보드 알림 카드(HM-001 ④)의 **실연동 구현** — FastAPI GET /api/notifications를 서버에서
// 직접 호출한다(미팅·Discover 실연동과 같은 패턴, 인증 헤더는 로그인 BFF의 httpOnly 세션 쿠키).
// org는 principal(Bearer)에서 백엔드가 자동 해석한다 — X-Org-Id 헤더는 더 이상 쓰지 않는다.
//
// ⚠ 범위: 여기서 실연동하는 건 "홈 알림 카드 + nav 안읽음 배지"뿐이다. /notifications 인박스
//   전체(필터·org 공유 읽음 처리)는 lib/notifications/*의 클라 전용 인메모리 스토어가 별도로 맡고
//   있어 이 슬라이스의 스왑 대상이 아니다(더 큰 별도 작업 — app/notifications/page.tsx 참고).

import { cookies } from "next/headers"
import { getLocale, getTranslations } from "next-intl/server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { resolveLocale } from "@/lib/i18n/config"
import { toNotification, type NotificationOutSnake, type Translator } from "./notification-composer"
import type { Notification } from "./notification"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

interface InboxResponseSnake {
  items: NotificationOutSnake[]
  unread_count: number
  next_cursor: string | null
}

async function notificationsFetch<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const res = await fetch(`${BACKEND_URL}/api/notifications${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  })
  // 401(세션 만료)은 500이 아니라 재인증으로 — meetings/organizer read 클라이언트와 동일 원칙.
  if (res.status === 401) redirect("/login")
  if (!res.ok) {
    throw new Error(`notifications read failed: GET ${path} (${res.status})`)
  }
  return (await res.json()) as T
}

// next-intl의 t는 메시지 카탈로그 리터럴 키에 물린 제네릭·조건부 타입이라, composer(순수 함수,
// next-intl 비의존)가 기대하는 단순 Translator 형태와 구조적으로 안 맞는다. 여기 경계 한 곳에서만
// 넓혀 캐스팅한다 — 실제 키 존재 여부는 messages/{ko,en}.json 키 무결성 테스트가 잡아준다.
async function loadTranslator(): Promise<Translator> {
  const t = await getTranslations("home.notificationMessages")
  return t as unknown as Translator
}

// HM-001 알림 카드 — 최신 항목(홈에서 latestNotifications가 5개로 추린다). limit은 넉넉히 잡아
// 최신 카탈로그가 항상 포함되게 한다.
export async function fetchHomeNotifications(): Promise<Notification[]> {
  // locale — 문구에 끼워 넣는 기업명을 화면 언어로 받는다(백엔드가 읽을 때 영문명으로 옮긴다).
  const locale = resolveLocale(await getLocale())
  const [data, t] = await Promise.all([
    notificationsFetch<InboxResponseSnake>(`?limit=20&locale=${locale}`),
    loadTranslator(),
  ])
  return data.items.map((item) => toNotification(item, t))
}

// nav 벨 배지(components/app-sidebar.tsx) — 목록 없이 개수만 필요해 limit=1로 가볍게 조회한다
// (unread_count는 items 페이지 크기와 무관하게 전체 기준).
export async function fetchUnreadNotificationCount(): Promise<number> {
  const data = await notificationsFetch<InboxResponseSnake>("?limit=1")
  return data.unread_count
}
