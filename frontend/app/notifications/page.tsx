import { redirect } from "next/navigation"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { NotificationInbox } from "@/components/notifications/notification-inbox"
import { resolveRequestSession, resolveRequestGuard } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { fetchNotificationInboxPage } from "@/lib/notifications/http-inbox-client"

export const dynamic = "force-dynamic"

// 세션은 쿠키 단일 소스에서 읽는다(dev 전환은 proxy가 ?as→쿠키로 처리).
export default async function NotificationsPage() {
  const guard = await resolveRequestGuard()

  // 미인증: 알림 표면 비노출 — 로그인으로 (nav 벨도 숨김). F-NT-001 US15.
  if (!guard.authenticated) redirect("/login")

  const session = await resolveRequestSession()

  // 실 세션이면 그 역할·org를, 아니면 기존 mock/dev 세션(?as=)을 쓴다
  // (app/meetings/page.tsx·app/page.tsx와 동일 패턴, lib/auth/http-session.ts).
  const realSession = await resolveHttpSession()
  if (realSession) {
    const orgId = realSession.orgId ?? session.orgId
    const me = await fetchMe()
    const initial = await fetchNotificationInboxPage(orgId)
    // 백엔드가 죽어 있는 등 초기 페이지를 못 읽으면 mock 인박스로 안전 폴백(mock 모드 보존 원칙).
    if (initial) {
      return (
        <AppShellForRequest>
          <NotificationInbox orgId={orgId} memberName={me?.member_name ?? session.user.name} initial={initial} />
        </AppShellForRequest>
      )
    }
  }

  // 인박스는 반응형 스토어(orgId 시드)를 구독한다(mock 모드).
  return (
    <AppShellForRequest>
      <NotificationInbox orgId={session.orgId} memberName={session.user.name} />
    </AppShellForRequest>
  )
}
