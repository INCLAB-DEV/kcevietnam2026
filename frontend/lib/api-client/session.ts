import type { SessionApiClient } from "./types"
import { cloneNotification } from "@/lib/notifications/inbox"
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications/store"

// 세션/뮤테이션 클라이언트 — client component(app-sidebar·discover-tabs 등)가 직접 호출한다.
// 정적 import는 클라 안전 모듈(notifications/store·inbox)만 끌어온다 → read 어댑터의 mock
// 픽스처·점수 휴리스틱은 이 그래프에 없다(frontend ADR-0001). 따라서 클라 번들로 안전.
// 읽기가 필요한 호출처는 서버 컴포넌트에서 `@/lib/api-client/server`의 serverApiClient를 쓴다.

export const sessionApiClient: SessionApiClient = {
  // TODO(슬라이스 2+): Cognito 사인아웃 + 토큰 폐기로 교체.
  // 실 세션 쿠키(nabi_session 등, session-cookie.ts) 4종은 httpOnly라 document.cookie로 못
  // 지운다 — 서버 라우트(app/api/auth/logout)에 위임해 Set-Cookie(Max-Age=0)로 폐기시킨다.
  // 이어서 dev: proxy가 심은 세션 컨텍스트 쿠키(lib/mock/session.ts의 DEV_AS/STATUS/PERIOD_COOKIE)를
  // 비워 실제 로그아웃 상태로 되돌린다 — 안 비우면 /login으로 가도 같은 dev 계정으로 남는다. prod엔 없어 무해.
  async logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
    } catch {
      // 네트워크 실패해도 아래 dev 쿠키 클리어는 계속 진행 — 로그아웃 자체를 막지 않는다.
    }
    if (typeof document !== "undefined") {
      for (const name of ["nabi_dev_as", "nabi_dev_status", "nabi_dev_period"]) {
        document.cookie = `${name}=; path=/; max-age=0; samesite=lax`
      }
    }
  },

  // TODO(#14): FastAPI로 POST 교체. 지금은 콘솔 기록 스텁.
  async recordRecommendationFeedback(input) {
    if (process.env.NODE_ENV !== "production") {
      console.info("[recommendation-feedback]", input)
    }
  },

  // 알림 인박스는 반응형 스토어(lib/notifications/store)를 단일 소스로 위임 — 벨 배지·인박스 동시 갱신.
  // TODO(#44/#45): GET /notifications(org-scoped) + PATCH read / POST read-all 로 교체.
  async listNotifications(orgId) {
    return getNotifications(orgId).map(cloneNotification)
  },

  async markNotificationRead(orgId, notificationId, memberName) {
    markNotificationRead(orgId, notificationId, memberName)
    return getNotifications(orgId).map(cloneNotification)
  },

  async markAllNotificationsRead(orgId, memberName) {
    markAllNotificationsRead(orgId, memberName)
    return getNotifications(orgId).map(cloneNotification)
  },
}
