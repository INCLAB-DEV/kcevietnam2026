// 비동기 전사 작업 추적 (F-MY-002, #42 후속).
// 백엔드가 30분 분량 녹음을 BackgroundTask 로 전사하는 동안, FE 는 이 모듈이 끝까지 폴링한다.
// 핵심: 폴링은 컴포넌트 수명과 분리된 모듈 전역 — 사용자가 회의록 화면을 떠나도 계속 돌아가
// 완료되면 "회의록 정리 완료" 알림을 인박스에 띄운다("다 되면 알림 보내준다"는 약속을 화면에 반영).
// detach() 는 인페이지 핸들러(초안 채우기)만 떼고, 폴링/알림 발송은 멈추지 않는다.
// TODO(#44/#45): 알림은 백엔드가 직접 생성하는 게 최종형 — 지금은 FE-mock 인박스로 발송한다.

import { pushNotification } from "@/lib/notifications/store"
import type { NotificationItem } from "@/lib/notifications/types"
import type { ReviewClient, StructureDraft } from "./types"

const POLL_MS = 2500
const MAX_ATTEMPTS = 120 // ~5분 — 무한 폴링 방지(초과 시 지연 안내)

// 사용자가 화면을 떠난 뒤 완료된 초안을 캐시 — 알림 클릭으로 회의록 화면에 재진입하면 복원한다.
const completedDrafts = new Map<string, StructureDraft>()

export function takeCompletedDraft(meetingId: string): StructureDraft | null {
  const draft = completedDrafts.get(meetingId) ?? null
  if (draft) completedDrafts.delete(meetingId)
  return draft
}

// 선택했지만 아직 AI 정리를 안 돌린 녹음 파일을 세션 동안 보관 — 다른 메뉴 갔다 뒤로가기로
// 돌아와도 다시 고르지 않게. File 은 직렬화 불가라 모듈 전역 메모리에만 둔다(소프트 네비 한정;
// 하드 리로드 시엔 브라우저 보안상 복원 불가 → 재선택 필요).
const selectedFiles = new Map<string, File>()

export function rememberSelectedFile(meetingId: string, file: File | null): void {
  if (file) selectedFiles.set(meetingId, file)
  else selectedFiles.delete(meetingId)
}

export function recallSelectedFile(meetingId: string): File | null {
  return selectedFiles.get(meetingId) ?? null
}

interface TrackArgs {
  client: ReviewClient
  meetingId: string
  jobId: string
  orgId: string
  counterpartOrg: string
}
interface TrackHandlers {
  onDone?: (draft: StructureDraft) => void
  onError?: (message: string) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pushReviewReady(args: TrackArgs): void {
  const item: NotificationItem = {
    id: `review-ready-${args.meetingId}-${args.jobId}`, // jobId 로 dedup — 재폴링·재진입에도 1건
    recipientOrgId: args.orgId,
    meetingId: args.meetingId,
    createdAt: new Date().toISOString(),
    readAt: null,
    readByMemberName: null,
    type: "review_ready",
    payload: { counterpartOrgName: args.counterpartOrg },
  }
  pushNotification(args.orgId, item)
}

// 작업을 완료/실패까지 폴링한다. 완료 시 알림 발송(화면을 떠나도) + 초안 캐시.
// 반환된 detach() 는 인페이지 콜백만 분리한다(언마운트 시 setState 경고 방지).
export function trackTranscription(args: TrackArgs, handlers: TrackHandlers): () => void {
  let detached = false

  void (async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_MS)
      let res
      try {
        res = await args.client.getTranscriptionStatus(args.meetingId, args.jobId)
      } catch {
        continue // 일시적 네트워크 오류는 다음 폴링에서 재시도
      }
      if (res.status === "done") {
        completedDrafts.set(args.meetingId, res.draft)
        pushReviewReady(args) // 화면을 떠나도 알림은 발송된다
        if (!detached) handlers.onDone?.(res.draft)
        return
      }
      if (res.status === "error") {
        if (!detached) handlers.onError?.(res.error)
        return
      }
    }
    if (!detached) handlers.onError?.("전사가 지연되고 있어요. 잠시 후 다시 시도해 주세요.")
  })()

  return () => {
    detached = true
  }
}
