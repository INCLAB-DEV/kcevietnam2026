// OP-005 배정 API 요청 검증 스키마 — assignments·saturation·saturation/confirm 라우트가 공유한다.
// 도메인 타입(AssignmentMeeting·ScheduleSettings)의 저장/전송에 필요한 최소 형태만 본다.

import { z } from "zod"

// AssignmentMeeting 미러. 미지의 확장 필드는 통과(passthrough) — 도메인 타입이 늘어나도
// 라우트가 먼저 깨지지 않게.
export const AssignmentMeetingSchema = z
  .object({
    id: z.string().min(1),
    exhibitorId: z.string().min(1),
    buyerId: z.string().min(1),
    slotId: z.string().min(1),
    status: z.enum(["proposed", "accepted", "completed", "cancelled", "rejected"]),
    matchingType: z.enum(["forced", "ai", "open", "onsite"]),
    durationMinutes: z.number().int().positive().optional(),
  })
  .passthrough()

// ScheduleSettings 미러 — 일괄배정 실행 창(startTime~endTime)·최소 보장 N 등.
// slotGapMinutes/maxMeetingMinutes는 Phase 1 계약서 §1/§2 추가 필드 — 기본값을 둬 이 필드를 아직
// 안 보내는 옛 클라(캐시된 번들 등)와도 호환된다(zod 기본 object는 알 수 없는 키를 조용히 버리므로
// 여기 선언이 없으면 settings echo(saturation route)에서 값이 통째로 사라진다).
export const ScheduleSettingsSchema = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  slotMinutes: z.number().int().positive(),
  slotGapMinutes: z.number().int().min(0).default(0),
  lunchStart: z.string().regex(/^\d{2}:\d{2}$/),
  lunchEnd: z.string().regex(/^\d{2}:\d{2}$/),
  minSlots: z.number().int().min(0),
  maxMeetingMinutes: z.number().int().positive().default(90),
})

// KST now(페이지가 주입받는 것과 동일 형태) — 과거 슬롯 제외 기준. dev ?now= 오버라이드 정합을
// 위해 클라가 보낸 값을 그대로 쓴다(서버·클라 재계산 결과가 분 단위로 어긋나지 않게).
export const NowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
})
