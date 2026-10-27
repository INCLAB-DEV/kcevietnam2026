// serverApiClient(lib/api-client/server.ts)의 getUser/getMeetings가 돌려주는 목업 픽스처.
// 초기 seam 형상 테스트(lib/api-client/api-client.test.ts)용으로 남아 있는 값이고, 참가자 화면은
// 이 둘을 읽지 않는다(사용자 신원은 /api/me, 미팅은 getMyMeetings — 실 세션이면 FastAPI).
// 전부 가상 데모값이다(실 인물·기업 아님).
import type { Meeting, User } from "@/lib/api-client/types"

export const MOCK_USERS: Record<string, User> = {
  "user-buyer-01": { id: "user-buyer-01", name: "김바이어", role: "buyer", email: "buyer01@example.com" },
  "user-exhibitor-01": { id: "user-exhibitor-01", name: "이참가사", role: "exhibitor", email: "exhibitor01@example.com" },
  "user-organizer-01": { id: "user-organizer-01", name: "정세훈", role: "organizer", email: "organizer01@example.com" },
}

export const MOCK_MEETINGS: Meeting[] = [
  { id: "mtg-001", title: "콘텐츠 유통 상담", status: "confirmed", scheduledAt: "2026-09-03T10:00:00+09:00", buyerId: "user-buyer-01", exhibitorId: "user-exhibitor-01" },
  { id: "mtg-002", title: "OTT 라이선싱 미팅", status: "pending", scheduledAt: "2026-09-03T14:00:00+09:00", buyerId: "user-buyer-01", exhibitorId: "user-exhibitor-01" },
]
