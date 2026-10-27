// 비동기 전사 작업 추적 (F-MY-002, #42 후속).
// 백엔드가 30분 분량 녹음을 전사 전용 풀에서 전사하는 동안, FE 는 이 모듈이 끝까지 폴링한다.
// 핵심: 폴링은 컴포넌트 수명과 분리된 모듈 전역 — 사용자가 회의록 화면을 떠나도 계속 돌아가
// 완료되면 "회의록 정리 완료" 알림을 인박스에 띄운다("다 되면 알림 보내준다"는 약속을 화면에 반영).
// detach() 는 인페이지 핸들러(초안 채우기)만 떼고, 폴링/알림 발송은 멈추지 않는다.
// TODO(#44/#45): 알림은 백엔드가 직접 생성하는 게 최종형 — 지금은 FE-mock 인박스로 발송한다.

import { pushNotification } from "@/lib/notifications/store"
import type { NotificationItem } from "@/lib/notifications/types"
import type { ReviewClient, StructureDraft, TranscriptionFailure, TranscriptionStatus } from "./types"

// 폴링 일정 — 처음 2분은 2.5초 간격(대개 이 안에 끝난다), 그 뒤는 5초로 늦춰 대기열에서 기다리는 작업들이
// 서버를 덜 두드리게 한다. 전체 상한은 30분: 백엔드 전사 풀(동시 3건)이 밀리면 뒤쪽 작업은 앞 작업들이
// 끝날 때까지 pending으로 기다린다 — 예전 5분 상한은 그런 작업을 "지연"으로 끊어, 서버에선 결국 끝나는데
// 화면은 결과를 못 받고 사용자는 다시 올려 대기열을 더 늘렸다.
// ⚠ 백엔드는 "대기열 만료(600초) + 작업 최악 실행(1140초) = 1740초 ≤ 이 상한(1800초)"으로 맞춰 둔다
// (backend/app/config.py transcription_job_max_age_seconds 주석) — 이 값을 줄이면 거기도 다시 계산한다.
const FAST_POLL_MS = 2500
const SLOW_POLL_MS = 5000
const FAST_PHASE_MS = 2 * 60 * 1000
const MAX_WAIT_MS = 30 * 60 * 1000 // 무한 폴링 방지(초과 시 지연 안내)
// 폴링 요청 1회 상한 — 응답이 안 오는 요청 하나에 폴링 루프 전체가 매달리지 않게 끊고 다음 차례로 넘어간다.
export const POLL_TIMEOUT_MS = 15 * 1000
// 연속 실패 시 간격을 두 배씩 늘린다(상한 30초) — 서버·네트워크가 흔들릴 때 모든 화면이 2.5초마다 두드려
// 회복을 늦추지 않게. 한 번이라도 응답을 받으면 원래 간격으로 돌아간다.
export const MAX_ERROR_BACKOFF_MS = 30 * 1000

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
  // 실패의 **종류**만 알린다 — 문구는 화면이 로케일 카탈로그(review.toast.transcription*)에서 고른다.
  // 이 모듈은 컴포넌트 밖(모듈 전역 폴링)이라 번역 훅을 쓸 수 없다.
  onError?: (failure: TranscriptionFailure) => void
  // 처음 2분이 지나도 pending이면 한 번 — 화면이 "조금 더 걸릴 수 있어요" 안내를 띄운다(지연 오류가 아니다).
  onWaiting?: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 다음 폴링까지 기다릴 시간 — 평소엔 단계별 간격, 연속 실패 n회면 그 간격 × 2^n(상한 MAX_ERROR_BACKOFF_MS).
export function nextPollDelay(elapsedMs: number, consecutiveErrors: number): number {
  const base = elapsedMs < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS
  if (consecutiveErrors <= 0) return base
  return Math.min(base * 2 ** consecutiveErrors, MAX_ERROR_BACKOFF_MS)
}

// 상태 조회 1회 — POLL_TIMEOUT_MS 안에 답이 없으면 요청을 취소하고(signal) 실패로 넘긴다. 클라이언트가 signal을
// 무시해도(목업 등) 시간 초과로 끝나게 경쟁(race)시킨다.
async function pollOnce(args: TrackArgs): Promise<TranscriptionStatus> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("transcription status poll timed out"))
    }, POLL_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      args.client.getTranscriptionStatus(args.meetingId, args.jobId, { signal: controller.signal }),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
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
    // 경과 시간은 실제 시계로 잰다 — 폴링 요청 자체가 걸린 시간(최대 POLL_TIMEOUT_MS)까지 상한에 넣는다.
    const startedAt = Date.now()
    const elapsed = () => Date.now() - startedAt
    let waitingNotified = false
    let consecutiveErrors = 0
    while (elapsed() < MAX_WAIT_MS) {
      await sleep(nextPollDelay(elapsed(), consecutiveErrors))
      let res
      try {
        res = await pollOnce(args)
        consecutiveErrors = 0
      } catch {
        consecutiveErrors += 1 // 일시적 네트워크 오류·시간 초과는 간격을 늘려 다음 폴링에서 재시도
        continue
      }
      if (res.status === "done") {
        completedDrafts.set(args.meetingId, res.draft)
        pushReviewReady(args) // 화면을 떠나도 알림은 발송된다
        if (!detached) handlers.onDone?.(res.draft)
        return
      }
      if (res.status === "error") {
        if (!detached) handlers.onError?.(res.failure)
        return
      }
      // 아직 pending. 백엔드는 '대기열에서 기다림'과 '전사 중'을 구분해 주지 않는다 — 처음 2분 안에 안
      // 끝났으면 어느 쪽이든 맞는 중립 안내("정리 중, 요청이 많으면 더 걸릴 수 있음")를 오류 대신 한 번 알린다.
      if (!waitingNotified && elapsed() >= FAST_PHASE_MS) {
        waitingNotified = true
        if (!detached) handlers.onWaiting?.()
      }
    }
    if (!detached) handlers.onError?.("delayed")
  })()

  return () => {
    detached = true
  }
}
