// NT-001/HM-001 알림 payload → 표시 문구 조립기 (F-NT-001). 백엔드는 타입별 payload 스냅샷만
// 내려준다(app/notifications/schemas.py의 6개 Payload 모델, 통지 당시 데이터 박제) — 문구 자체는
// FE가 next-intl 메시지(ko/en)로 조립한다. 순수 함수라 next-intl 런타임 없이도 테스트한다
// (Translator는 next-intl getTranslations()가 반환하는 t를 그대로 넘길 수 있는 최소 형태).

import type { Notification, NotificationType } from "./notification"
import type { NotificationItem } from "@/lib/notifications/types"

export type CounterpartRole = "exhibitor" | "buyer" | "organizer"

// GET /api/notifications가 내려주는 NotificationOut(snake_case). payload는 계약상
// additionalProperties(타입별로 형상이 다르다) — 6종 Payload 모델의 필드 합집합으로 느슨하게 잡는다.
export interface NotificationOutSnake {
  id: string
  type: NotificationType
  meeting_id: string | null
  due_at: string | null
  payload: {
    counterpart_org_name?: string
    requested_by_role?: CounterpartRole
    scheduled_start?: string | null
    venue_label?: string | null
    cancelled_by_role?: CounterpartRole
    // application_approved 전용(다른 타입과 달리 상대 기업이 아니라 내 기업 정보).
    org_name?: string
    role?: CounterpartRole
  } | null
  created_at: string
  read_at: string | null
  read_by_member_id: string | null
  // 읽은 멤버의 표시 이름 — 백엔드 롤아웃 중(옵셔널). 없으면 인박스는 읽은 시각만 보여준다
  // (lib/notifications/inbox.tsx의 readBy/readAt 문구 분기).
  read_by_member_name?: string | null
}

export type Translator = (key: string, values?: Record<string, string | number | Date>) => string

// payload 스냅샷 → 화면 문구. 메시지 카탈로그는 messages/{ko,en}.json의 home.notificationMessages
// 네임스페이스(키 무결성 테스트: lib/i18n/messages.test.ts). payload가 계약 밖(빈 값)이어도 빈
// 기업명으로 조용히 렌더한다 — 알림 자체를 숨기는 것보다 낫다.
export function composeNotificationMessage(item: NotificationOutSnake, t: Translator): string {
  const org = item.payload?.counterpart_org_name ?? ""
  switch (item.type) {
    case "meeting_requested":
      return t("meetingRequested", { org })
    case "meeting_accepted":
      return t("meetingAccepted", { org })
    case "meeting_cancelled":
      return item.payload?.cancelled_by_role === "organizer"
        ? t("meetingCancelledByOrganizer", { org })
        : t("meetingCancelled", { org })
    case "meeting_reminder":
      return t("meetingReminder", { org })
    case "review_prompt":
      return t("reviewPrompt", { org })
    case "review_ready":
      return t("reviewReady", { org })
    case "application_approved":
      return t("applicationApproved", { org: item.payload?.org_name ?? "" })
    case "meeting_rejected":
      return t("meetingRejected", { org })
  }
}

// NotificationOut(snake) → Notification(camel, HM-001 카드 계약). meeting_id는 null일 수 있다
// (운영자 직접 발송 등 미팅 비연계) — notificationHref가 이미 null을 /notifications로 폴백한다.
export function toNotification(item: NotificationOutSnake, t: Translator): Notification {
  return {
    id: item.id,
    type: item.type,
    meetingId: item.meeting_id,
    message: composeNotificationMessage(item, t),
    createdAt: item.created_at,
  }
}

// NotificationOut(snake) → NotificationItem(camel, /notifications 인박스 도메인 타입,
// lib/notifications/types.ts). toNotification(홈 카드용)과 달리 문구를 미리 조립하지 않는다 — 인박스는
// lib/notifications/inbox.ts의 notificationMessage(item, t)가 필터·정렬과 같은 계층(순수 로직)에서
// 렌더 시점에 조립한다. recipientOrgId는 응답 계약에 없다(org는 principal에서 이미 스코프됨) — 호출부의
// 현재 세션 org를 그대로 채운다(렌더 로직은 이 필드를 읽지 않는 메타값).
export function toInboxItem(item: NotificationOutSnake, recipientOrgId: string): NotificationItem {
  const p = item.payload ?? {}
  const base = {
    id: item.id,
    recipientOrgId,
    meetingId: item.meeting_id,
    createdAt: item.created_at,
    readAt: item.read_at,
    readByMemberName: item.read_by_member_name ?? null,
  }
  switch (item.type) {
    case "meeting_requested":
      return {
        ...base,
        type: "meeting_requested",
        payload: {
          counterpartOrgName: p.counterpart_org_name ?? "",
          requestedByRole: p.requested_by_role ?? "organizer",
        },
      }
    case "meeting_accepted":
      return {
        ...base,
        type: "meeting_accepted",
        payload: {
          counterpartOrgName: p.counterpart_org_name ?? "",
          scheduledStart: p.scheduled_start ?? "",
          venueLabel: p.venue_label ?? null,
        },
      }
    case "meeting_cancelled":
      return {
        ...base,
        type: "meeting_cancelled",
        payload: {
          counterpartOrgName: p.counterpart_org_name ?? "",
          scheduledStart: p.scheduled_start ?? null,
          cancelledByRole: p.cancelled_by_role ?? "organizer",
        },
      }
    case "meeting_reminder":
      return {
        ...base,
        type: "meeting_reminder",
        payload: {
          counterpartOrgName: p.counterpart_org_name ?? "",
          scheduledStart: p.scheduled_start ?? "",
          venueLabel: p.venue_label ?? null,
        },
      }
    case "review_prompt":
      return { ...base, type: "review_prompt", payload: { counterpartOrgName: p.counterpart_org_name ?? "" } }
    case "review_ready":
      return { ...base, type: "review_ready", payload: { counterpartOrgName: p.counterpart_org_name ?? "" } }
    case "application_approved":
      return {
        ...base,
        type: "application_approved",
        payload: { orgName: p.org_name ?? "", role: p.role ?? "exhibitor" },
      }
    case "meeting_rejected":
      return {
        ...base,
        type: "meeting_rejected",
        payload: {
          counterpartOrgName: p.counterpart_org_name ?? "",
          scheduledStart: p.scheduled_start ?? null,
        },
      }
  }
}
