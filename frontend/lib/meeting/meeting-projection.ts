// Schedule Table 투영 공유 커널 — home(HM-001)과 timeline(F-MY-001)이 함께 쓰는
// (1) viewer 권한 경계 필터, (2) KST 날짜/시각 투영, (3) 상태 tone/label을 한 곳에 둔다.
// 두 소비처가 같은 규칙을 따로 정의하던 locality friction을 제거한다(#85).
//
// MeetingRecord에 의존하지 않고 구조적 최소 타입만 받는다 — home-dashboard-data가 이 모듈을
// 쓰면서도 MeetingRecord를 계속 소유할 수 있게(import cycle 방지) 하고, 재사용성도 넓힌다.

import type { ScheduleStatus, RequestDirection } from "@/lib/home/meeting-status-rollup"
import type { ViewerRole } from "@/lib/types"

// t는 next-intl getTranslations()/useTranslations()가 반환하는 t를 그대로 넘길 수 있는 최소 형태
// (lib/notifications/inbox.ts와 동일 패턴). labelFor 호출부가 "meeting.status" 네임스페이스 t를 주입한다.
export type Translator = (key: string, values?: Record<string, string | number>) => string

// 슬롯 색(F-MY-001 D2) — "상태색"이 아니라 끝난 미팅의 "다음 할 일" 관점:
//   green=예정/진행(accepted, 아직 안 끝남), red=응답 필요(proposed),
//   orange=회의록 작성 필요(완료·미작성 + accepted 종료경과), blue=회의록 작성 완료(보관),
//   gray=할 것 없음(노쇼·거절·취소·만료·빈).
export type SlotTone = "green" | "red" | "orange" | "blue" | "gray"

// viewer 측 org 식별자를 뽑는 데 필요한 최소 형태.
interface ViewerSidedMeeting {
  buyerOrgId: string
  exhibitorOrgId: string
}

// 미팅의 viewer 측 org 식별자(권한 경계 판정). exhibitor면 자기 부스측, 그 외(buyer)는 바이어측.
export function viewerSideOrgId(m: ViewerSidedMeeting, role: ViewerRole): string {
  return role === "exhibitor" ? m.exhibitorOrgId : m.buyerOrgId
}

// requestedByOrgId(신청 org, null=운영자 배정) → viewer 기준 방향. home/timeline/action-strip/
// meeting-panel 네 곳이 같은 규칙을 쓰도록 단일화(#85와 같은 이유) — null 처리가 갈리면 화면마다
// "운영자 배정" 취급이 어긋난다.
export function resolveDirection(
  requestedByOrgId: string | null,
  viewerOrgId: string
): RequestDirection {
  if (requestedByOrgId === null) return "organizer"
  return requestedByOrgId === viewerOrgId ? "sent" : "received"
}

// 권한 경계: 내 기업이 당사자인 미팅만. FastAPI가 1차로 거르지만(ADR-0008) 읽기 측에서 한 번 더.
export function filterViewerMeetings<T extends ViewerSidedMeeting>(
  meetings: T[],
  role: ViewerRole,
  viewerOrgId: string
): T[] {
  return meetings.filter((m) => viewerSideOrgId(m, role) === viewerOrgId)
}

// scheduledAt(ISO, KST offset) → KST 날짜(YYYY-MM-DD). Date.now()는 쓰지 않고 입력만 변환.
export function kstDate(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
}

// scheduledAt(ISO, KST offset) → KST 시각(HH:MM, 24h).
export function kstTime(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// 폴백 톤(proposed/rejected/cancelled용). accepted·completed는 toneFor에서 종료경과·참석·회의록으로 파생.
// ADR-0010: noshow는 상태가 아니라 completed의 결과 속성(attended=false)이라 여기 키에 없다.
const STATUS_TONE: Record<ScheduleStatus, SlotTone> = {
  accepted: "green",
  completed: "green",
  proposed: "red",
  rejected: "gray",
  cancelled: "gray",
}

// proposed 라벨은 방향으로 갈린다(받은=내가 응답 / 보낸=상대 응답 대기). accepted/completed는 opts
// (ended·attended·hasReview)로 갈려 labelFor에서 직접 분기한다 — 여기 맵은 상태 고정인 rejected/
// cancelled만 다룬다. t("meeting.status.*") 키로 조립.
const STATUS_LABEL_KEY: Record<"rejected" | "cancelled", string> = {
  rejected: "rejected",
  cancelled: "cancelled",
}

// 슬롯 색/라벨은 순수 함수로 노출(단위 테스트 대상). 색·라벨 모두 "다음 할 일" 관점(F-MY-001 재정의).
// 톤: accepted+ended(종료경과)→orange / completed 미참석(노쇼)→gray / 참석+미작성→orange / 참석+작성완료→blue.
// attended/hasReview/ended는 해당 상태에서만 의미. 그 외(proposed/rejected/cancelled)는 STATUS_TONE 폴백.
export function toneFor(
  status: ScheduleStatus,
  opts: { attended?: boolean; hasReview?: boolean; ended?: boolean } = {}
): SlotTone {
  const attended = opts.attended ?? true
  if (status === "accepted") return opts.ended ? "orange" : "green"
  if (status === "completed") {
    if (!attended) return "gray" // 노쇼 — 회의록 대상 아님
    return opts.hasReview ? "blue" : "orange"
  }
  return STATUS_TONE[status]
}

// 라벨: proposed 받은→"수락 필요"/보낸→"수락 대기중", accepted 예정→"미팅 예정"/종료경과→"회의록 작성",
//   completed 참석+미작성→"회의록 작성"/참석+작성완료→"회의록 보기"/노쇼→"불참", rejected/cancelled→상태 고정.
// t는 "meeting.status" 네임스페이스(messages/{ko,en}.json) — 호출부(timeline.ts·meeting-panel.ts)가 주입.
// **필수 인자다**(한국어 폴백 없음): 참가자 화면이 t를 빠뜨려 EN 화면에 한국어가 남는 일을 타입으로
// 막는다. 한국어 고정 화면(운영자 콘솔)·단위 테스트는 lib/i18n/ko-translator를 명시적으로 넘긴다.
export function labelFor(
  status: ScheduleStatus,
  direction: RequestDirection,
  opts: { attended?: boolean; hasReview?: boolean; ended?: boolean },
  t: Translator
): string {
  const attended = opts.attended ?? true
  if (status === "proposed") return direction === "received" ? t("acceptNeeded") : t("acceptWaiting")
  if (status === "accepted") return opts.ended ? t("writeReview") : t("upcoming")
  if (status === "completed") {
    if (!attended) return t("noShow") // 노쇼
    return opts.hasReview ? t("viewReview") : t("writeReview")
  }
  return t(STATUS_LABEL_KEY[status]) // rejected→거절됨, cancelled→취소됨
}
