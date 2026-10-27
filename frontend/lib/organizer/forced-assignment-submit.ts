// 강제 배정 저장(POST) 공용 seam — 낙관적으로 이미 화면에 추가된 미팅을 서버에 영속하고, 실패하면
// 롤백 + 에러 토스트를 낸다. 배정 그리드(assignment-hub, OP-005)와 기업 상세(member-detail, OP-003)
// 양쪽에서 강제 배정을 만들 수 있는데, 예전엔 각자 이 저장 로직을 따로 구현하다가 기업 상세 쪽이
// postAssignments 호출 자체를 빠뜨린 로컬 전용 구현으로 남아 "저장한 것처럼 보이지만 배정 탭에는
// 반영 안 됨" 사고가 났다(발주자 QA 3차 지적 #2). 이제 두 화면이 이 함수 하나를 쓴다 — 낙관적
// 반영·성공 후 동기화(router.refresh + refreshAssignmentViews)·성공 토스트는 호출부 책임으로 남긴다
// (화면마다 토스트 문구·전환 방식이 달라 그 부분까지 강제로 묶지 않는다).
//
// ⚠ 실패 문구는 **원인별**이다(2026-10-01 고객 신고 "배정 저장에 실패했어요"). 예전엔 이유와 무관하게
// "네트워크 확인 후 다시 시도해 주세요"를 띄워, 백엔드가 이유를 들고 거절한 경우(장소 사용 중·같은
// 시각 미팅 있음…)까지 네트워크 탓으로 오도했다 — 운영자는 같은 버튼을 계속 눌렀다. 네트워크 문구는
// 브라우저→서버 fetch가 실제로 던졌을 때(NETWORK_ERROR)만 쓴다.

import { toast } from "sonner"
import type { Dispatch, SetStateAction } from "react"
import { isDeadSlotMeeting } from "@/lib/meeting/slot-pick"
import { postAssignments, type AssignmentActionResult } from "./assignment-actions"
import type { AssignmentMeeting } from "./forced-assignment"

// 세션 만료 에러 코드 — write 프록시 라우트(assignments·saturation·saturation/confirm)가 upstream
// 401을 이 코드로 통일해 내려준다(app/api/organizer/{assignments,saturation,saturation/confirm}/
// route.ts). 화면들이 문구를 각자 복제하지 않도록 상수 + 알림 헬퍼를 여기서 export한다.
export const SESSION_EXPIRED_ERROR = "session_expired"

// 브라우저→서버 fetch 자체가 실패했을 때의 코드(assignment-actions.ts post) — "네트워크 확인"은 이때만.
export const NETWORK_ERROR = "network"

// 세션 만료를 일반 저장 실패와 다르게 표면화한다 — "네트워크 확인 후 다시 시도"는 오도한다
// (재시도해도 401이 반복될 뿐이다). redirect가 없으면(호출부가 useRouter를 못 쓰는 컨텍스트 등)
// 브라우저 환경에서 안전하게 /login으로 이동한다.
export function notifySessionExpired(redirect?: () => void): void {
  toast.error("세션이 만료됐어요", { description: "다시 로그인해 주세요." })
  if (redirect) {
    redirect()
  } else if (typeof window !== "undefined") {
    window.location.assign("/login")
  }
}

// 실패 토스트에 실을 당사자 이름 — SLOT_TAKEN이 "누가" 그 시각에 바쁜지 이름으로 말한다.
export interface AssignmentParties {
  exhibitorName?: string
  buyerName?: string
}

export interface AssignmentErrorCopy {
  title: string
  description: string
}

// 그 사이 서버 상태가 화면과 달라져 거절된 코드 — 낙관적·오래된 목록이 서버와 어긋났다는 뜻이라
// 호출부가 서버 진실로 다시 그린다(지금 그 칸을 누가 잡고 있는지 보여야 다음 행동을 고를 수 있다).
const STALE_CONFLICT_ERRORS = new Set(["SLOT_TAKEN", "VENUE_TAKEN", "DUPLICATE_APPLICATION"])

export function isStaleConflict(result: AssignmentActionResult): boolean {
  return STALE_CONFLICT_ERRORS.has(result.error ?? "")
}

// SLOT_TAKEN — 백엔드가 busyRoles로 막힌 쪽을 알려준다(meeting_booking.slot_taken_error). 조사(은/는·
// 이/가)가 이름 받침에 따라 갈리지 않도록 "~에게 … 있어요" 꼴로 쓴다.
function slotTakenDescription(result: AssignmentActionResult, parties: AssignmentParties): string {
  const roles = new Set(result.busyRoles ?? [])
  const exhibitor = parties.exhibitorName ? `참가사 ${parties.exhibitorName}` : "참가사"
  const buyer = parties.buyerName ? `바이어 ${parties.buyerName}` : "바이어"
  if (roles.has("exhibitor") && roles.has("buyer")) {
    return `${exhibitor}, ${buyer} 모두 그 시각에 이미 확정된 미팅이 있어요. 다른 시간을 골라 주세요.`
  }
  if (roles.has("exhibitor")) {
    return `${exhibitor}에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.`
  }
  if (roles.has("buyer")) {
    return `${buyer}에게 그 시각에 이미 확정된 미팅이 있어요. 다른 시간이나 상대를 골라 주세요.`
  }
  return "그 시각에 이미 확정된 미팅이 있어요. 화면을 새로 고쳐 최신 배정을 확인해 주세요."
}

// 실패 결과 → 화면 문구(제목 + 설명). 운영자가 "다시 누르면 되는지 / 다른 시간·상대를 골라야 하는지 /
// 설정을 고쳐야 하는지"를 바로 알 수 있게 원인별로 나눈다. 백엔드 message가 구체적이면(장소 이름·
// 슬롯 검증 사유) 설명으로 그대로 쓴다.
export function describeAssignmentError(
  result: AssignmentActionResult,
  parties: AssignmentParties = {},
): AssignmentErrorCopy {
  switch (result.error) {
    case NETWORK_ERROR:
      return { title: "배정 저장에 실패했어요", description: "네트워크 확인 후 다시 시도해 주세요." }
    case "SLOT_TAKEN":
      return { title: "같은 시각에 이미 미팅이 있어요", description: slotTakenDescription(result, parties) }
    case "VENUE_TAKEN":
      return {
        title: "미팅 장소가 이미 사용 중이에요",
        description: result.message ?? "그 시각에 비어 있는 미팅 장소가 없어요. 다른 시간을 골라 주세요.",
      }
    case "VENUE_TYPE_DISABLED":
      return {
        title: "배정할 미팅 장소가 없어요",
        description: result.message ?? "행사 설정에서 미팅 장소를 확인해 주세요.",
      }
    case "SLOT_INVALID":
    case "invalid_slot":
      return {
        title: "배정할 수 없는 시간이에요",
        description: result.message ?? "운영시간·점심시간·미팅 최대 길이를 확인해 주세요.",
      }
    case "EVENT_SCHEDULE_UNSET":
      return {
        title: "행사 일정이 설정되지 않았어요",
        description: result.message ?? "행사 설정에서 운영시간과 전시 기간을 먼저 저장해 주세요.",
      }
    case "DUPLICATE_APPLICATION":
      return {
        title: "같은 시각에 이미 신청된 미팅이 있어요",
        description: "두 기업 사이에 같은 시각 신청이 이미 있어요. 화면을 새로 고쳐 확인해 주세요.",
      }
    case "no_event":
      return { title: "선택된 행사를 찾지 못했어요", description: "행사를 다시 선택한 뒤 시도해 주세요." }
    default:
      return {
        title: "배정 저장에 실패했어요",
        description: result.message ?? "서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
      }
  }
}

// 실패를 화면에 알린다 — 세션 만료는 재로그인 안내로, 나머지는 원인별 문구로. title을 주면 제목만
// 화면 맥락으로 바꾼다(예: "포화배정 실행에 실패했어요") — 설명은 언제나 원인별이다.
export function notifyAssignmentFailure(
  result: AssignmentActionResult,
  options: { onSessionExpired?: () => void; parties?: AssignmentParties; title?: string } = {},
): void {
  if (result.error === SESSION_EXPIRED_ERROR) {
    notifySessionExpired(options.onSessionExpired)
    return
  }
  const copy = describeAssignmentError(result, options.parties)
  toast.error(options.title ?? copy.title, { description: copy.description })
}

export interface SubmitAssignmentOptions {
  onSessionExpired?: () => void
  // 실패한 그 미팅의 당사자 이름 — ⚡ 배치는 앞에서부터 저장하다 멈추므로 savedCount번째가 실패 건이다.
  partiesOf?: (meeting: AssignmentMeeting) => AssignmentParties
  // 실패 토스트 제목을 화면 맥락으로 바꿀 때(예: ⚡ 부분 저장 "빈 슬롯 3건 중 1건만 배정됐어요").
  failureTitle?: (result: AssignmentActionResult) => string | undefined
  // 실패했지만 서버 상태가 화면과 달라졌을 때(부분 저장 savedCount>0, 또는 SLOT_TAKEN 같은 경합) —
  // 호출부가 서버 진실로 다시 그린다(저장된 건이 롤백으로 화면에서 사라지거나, 막은 미팅이 안 보이지 않게).
  onResync?: () => void
}

// 저장 중(낙관적) 미팅들을 서버에 영속한다 — 성공(2xx)이면 true. 실패면 그 미팅들을 setPending에서
// 걷어내고(롤백) 원인별 토스트를 낸다. 성공 토스트·확정 목록으로 옮기기는 호출부 몫이다 — 성공 문구는
// 서버가 2xx로 확정한 **뒤에만** 띄운다(예전엔 응답 전에 "배정" 토스트가 먼저 떴다).
export async function submitAssignments(
  meetings: AssignmentMeeting[],
  setPending: Dispatch<SetStateAction<AssignmentMeeting[]>>,
  options: SubmitAssignmentOptions = {},
): Promise<boolean> {
  const result = await postAssignments(meetings)
  if (result.success) return true

  const ids = new Set(meetings.map((m) => m.id))
  setPending((prev) => prev.filter((m) => !ids.has(m.id)))
  const failed = meetings[Math.min(result.savedCount ?? 0, meetings.length - 1)]
  notifyAssignmentFailure(result, {
    onSessionExpired: options.onSessionExpired,
    parties: failed && options.partiesOf ? options.partiesOf(failed) : undefined,
    title: options.failureTitle?.(result),
  })
  if (result.error !== SESSION_EXPIRED_ERROR && ((result.savedCount ?? 0) > 0 || isStaleConflict(result))) {
    options.onResync?.()
  }
  return false
}

// 같은 배정인가 — 같은 참가사·바이어·시작 칸(서버 id와 낙관적 id는 다르므로 내용으로 비교).
function sameAssignment(a: AssignmentMeeting, b: AssignmentMeeting): boolean {
  return a.exhibitorId === b.exhibitorId && a.buyerId === b.buyerId && a.slotId === b.slotId
}

// 저장 중(낙관적) 목록에서 **서버 목록에 이미 들어온 건**을 뺀다. 저장은 수 초 걸리고 운영자는 그 사이
// 다른 칸을 계속 배정한다 — 먼저 끝난 저장의 router.refresh가 서버 목록을 다시 내려줄 때, 아직 응답을
// 못 받은 이 건이 이미 커밋돼 그 목록에 들어 있을 수 있다. 둘 다 그리면 한 칸에 같은 미팅이 두 번 보인다.
export function pendingNotYetListed(
  pending: AssignmentMeeting[],
  listed: AssignmentMeeting[],
): AssignmentMeeting[] {
  if (pending.length === 0) return pending
  const alive = listed.filter((m) => !isDeadSlotMeeting(m.status))
  return pending.filter((p) => !alive.some((m) => sameAssignment(m, p)))
}

// 저장이 확정된 건을 확정 목록에 더한다 — 서버 목록 갱신이 먼저 도착해 이미 들어 있으면 다시 넣지 않는다.
export function addConfirmed(
  listed: AssignmentMeeting[],
  confirmed: AssignmentMeeting[],
): AssignmentMeeting[] {
  const fresh = pendingNotYetListed(confirmed, listed)
  return fresh.length === 0 ? listed : [...listed, ...fresh]
}

// 강제 배정 1건 — submitAssignments의 단건 형태(배정 그리드·기업 상세 공용). 실패 시 setMeetings에서
// 그 미팅을 제거(롤백)하고 false를 돌려준다 — 호출부는 true일 때만 성공 토스트·동기화를 이어간다.
// 세션 만료(onSessionExpired)는 낙관적 반영 롤백은 그대로 수행하되(유령 미팅을 남기지 않는다) 일반
// 에러 토스트 대신 세션 만료 안내로 간다.
export function submitForcedAssignment(
  meeting: AssignmentMeeting,
  setMeetings: Dispatch<SetStateAction<AssignmentMeeting[]>>,
  onSessionExpired?: () => void,
  options: Omit<SubmitAssignmentOptions, "onSessionExpired"> = {},
): Promise<boolean> {
  return submitAssignments([meeting], setMeetings, { ...options, onSessionExpired })
}
