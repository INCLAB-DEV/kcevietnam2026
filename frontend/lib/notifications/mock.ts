// NT-001 알림 인박스 mock 데이터 (org 공유 인박스). 데모/테스트 픽스처.
// TODO(실연동): GET /notifications(org-scoped) — FastAPI(#44 emitter/스케줄러가 생성한 행) 로 교체.
// orgId 키는 lib/mock/session.ts 의 MOCK_ACCOUNTS.orgId 와 정합.

import { cloneNotification } from "./inbox"
import type { NotificationItem } from "./types"

// 바이어 org(buyer-1) 인박스 — 5종 전부 + 읽음/안읽음 혼재.
const BUYER_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "ntf-b-05",
    recipientOrgId: "buyer-1",
    type: "meeting_requested",
    meetingId: "mtg-005",
    createdAt: "2026-09-02T09:30:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: { counterpartOrgName: "퍼스텍", requestedByRole: "exhibitor" },
  },
  {
    id: "ntf-b-01",
    recipientOrgId: "buyer-1",
    type: "meeting_reminder",
    meetingId: "mtg-001",
    createdAt: "2026-09-03T09:50:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: {
      counterpartOrgName: "픽셀아츠 스튜디오",
      scheduledStart: "2026-09-03T10:00:00+09:00",
      venueLabel: "A홀 B-12 부스",
    },
  },
  {
    id: "ntf-b-02",
    recipientOrgId: "buyer-1",
    type: "meeting_accepted",
    meetingId: "mtg-001",
    createdAt: "2026-09-01T14:20:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: {
      counterpartOrgName: "픽셀아츠 스튜디오",
      scheduledStart: "2026-09-03T10:00:00+09:00",
      venueLabel: "A홀 B-12 부스",
    },
  },
  {
    id: "ntf-b-03",
    recipientOrgId: "buyer-1",
    type: "meeting_cancelled",
    meetingId: "mtg-003",
    createdAt: "2026-08-31T11:05:00+09:00",
    readAt: "2026-08-31T11:30:00+09:00",
    readByMemberName: "김바이어",
    payload: {
      counterpartOrgName: "LIG넥스원",
      scheduledStart: "2026-09-04T13:00:00+09:00",
      cancelledByRole: "exhibitor",
    },
  },
  {
    id: "ntf-b-04",
    recipientOrgId: "buyer-1",
    type: "review_prompt",
    meetingId: "mtg-004",
    createdAt: "2026-08-30T17:40:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: { counterpartOrgName: "현대로템" },
  },
]

// 참가사 org(exh-1) 인박스 — 신청받음 등.
const EXHIBITOR_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "ntf-e-01",
    recipientOrgId: "exh-1",
    type: "meeting_requested",
    meetingId: "mtg-010",
    createdAt: "2026-09-02T10:15:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: { counterpartOrgName: "서울콘텐츠파트너스", requestedByRole: "buyer" },
  },
  {
    id: "ntf-e-02",
    recipientOrgId: "exh-1",
    type: "meeting_reminder",
    meetingId: "mtg-011",
    createdAt: "2026-09-03T13:50:00+09:00",
    readAt: null,
    readByMemberName: null,
    payload: {
      counterpartOrgName: "대한항공",
      scheduledStart: "2026-09-03T14:00:00+09:00",
      venueLabel: "B홀 상담룸 3",
    },
  },
  {
    id: "ntf-e-03",
    recipientOrgId: "exh-1",
    type: "review_prompt",
    meetingId: "mtg-012",
    createdAt: "2026-08-29T16:00:00+09:00",
    readAt: "2026-08-29T16:20:00+09:00",
    readByMemberName: "이참가사",
    payload: { counterpartOrgName: "두산에너빌리티" },
  },
]

const BY_ORG: Record<string, NotificationItem[]> = {
  "buyer-1": BUYER_NOTIFICATIONS,
  "exh-1": EXHIBITOR_NOTIFICATIONS,
}

// org 인박스의 깊은 복사본을 반환(원본 픽스처 불변 — 스토어가 변형해도 시드는 보존).
export function seedNotifications(orgId: string): NotificationItem[] {
  const items = BY_ORG[orgId] ?? []
  return items.map(cloneNotification)
}
