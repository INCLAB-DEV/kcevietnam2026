// F-MY-002 미팅 리뷰(Step1 intake + Step2 AI 보고문서/Fit)의 클라이언트 계약.
// 백엔드(FastAPI) /meetings/{id}/review/* 응답 형태를 그대로 미러링한다 — mock→실연동 교체 시 1:1.
// 비공개 항목(Follow-up Intent·Fit·만족도·전사)은 상대 응답에 절대 포함되지 않는다(노출 규칙).

export type MeetingProceeded = "proceeded" | "counterpart_noshow" | "self_noshow"
export type FollowUpIntent = "none" | "reviewing" | "yes"
export type FitRating = "good" | "normal" | "bad"

// Step1 — 미팅 후기(intake). proceeded만 필수.
export interface Step1Input {
  proceeded: MeetingProceeded
  satisfaction: number | null // 1~5 별점 (비공개)
  followUpIntent: FollowUpIntent | null // 비공개
}

// AI 구조화 보고문서 본문 — 내보내기 대상(공개 가능).
export interface ReportSections {
  discussion: string[] // 핵심 논의사항
  agreements: string[] // 합의 사항
  actions: string[] // 후속 액션
}

// 화자별 전사 한 발화 — who 는 AI 텍스트 추정(us=우리 기업/them=상대). 비공개(본인 열람 전용).
export type TranscriptSpeaker = "us" | "them"
export interface TranscriptTurn {
  who: TranscriptSpeaker
  text: string
}

// AI 초안(사용자 검수 전) — 보고 본문 + Fit 제안(비공개) + 화자별 전사(비공개).
export interface StructureDraft {
  report: ReportSections
  fitSuggestion: FitRating | null
  fitReasonSeed: string
  fitReasonTags: string[]
  transcript: string
  transcriptTurns: TranscriptTurn[]
  audioS3Key?: string
}

// Step2 저장 입력 — 검수·수정한 보고문서 + Fit. 전사는 직접 편집하지 않고 초안값을 그대로 보존.
export interface Step2Input {
  report: ReportSections
  fitRating: FitRating | null
  fitReason: string
  fitReasonTags: string[]
  transcript?: string
  transcriptTurns?: TranscriptTurn[]
  audioS3Key?: string
  finalize: boolean
}

// 저장된 본인 리뷰(전체 필드 — 본인 열람용).
export interface StoredReview {
  isNoshow: boolean
  counterpartNoshow: boolean
  satisfaction: number | null
  followUpIntent: FollowUpIntent | null
  report: ReportSections | null
  fitRating: FitRating | null
  fitReason: string
  fitReasonTags: string[]
  transcriptTurns: TranscriptTurn[]
  reportConfirmed: boolean
}

// 러브콜 메일(#13) 화면 상태. sent=true 면 무엇을 언제 보냈는지 그대로 되돌려받아 표시한다.
export interface LoveCallMailState {
  recipientOrgName: string
  // 발송 전에는 지금 받을 수 있는 담당자 수, 발송 후에는 그때 실제로 받은 수(발송 당시 사실 보존).
  recipientCount: number
  reportReady: boolean // 확정된 회의록이 있는지 — 없으면 AI가 쓸 재료가 없다
  sent: boolean
  sentAt: string | null
  subject: string | null
  body: string | null
  // 이 미팅 행사의 메일 스위치(운영 콘솔 행사 설정 "참가사·바이어 알림 메일"). false면 백엔드가 발송을 409
  // (PARTICIPANT_EMAIL_DISABLED)로 막는다 — 화면은 '발송하기'를 잠그고 안내한다. 초안 작성·확인은 그대로 된다.
  emailEnabled: boolean
}

// AI 초안. aiGenerated=false 는 **실패를 드러낸 상태**다 — error를 화면에 띄우고 빈 body로
// 직접 쓰게 연다(조용히 템플릿으로 때우지 않는다).
export interface LoveCallMailDraft {
  subject: string
  body: string
  aiGenerated: boolean
  error: string | null
  recipientOrgName: string
  recipientCount: number
}

// 전사 작업이 실패한 이유의 종류 — 화면은 이 값으로 messages의 review.toast.transcription* 문구를 고른다
// (화면 로케일). 백엔드가 주는 실패 문구(error)는 한국어 고정이라 그대로 띄우지 않는다.
//   audioTooLong : 녹음 길이 상한 초과(다시 올려도 또 실패 — 나눠서 올리라고 안내)
//   failed       : 그 밖의 실패(대기열 만료·전사/구조화 오류 등 — 잠시 후 다시)
//   delayed      : 서버 결과가 아니라 화면 폴링이 상한(30분)을 넘겼다(transcription-tracker)
export type TranscriptionFailure = "audioTooLong" | "failed" | "delayed"

// 비동기 전사 작업 폴링 결과. 30분 분량은 동기로 못 받아 접수→폴링한다(백엔드 202 + GET status 미러).
export type TranscriptionStatus =
  | { status: "pending" }
  | { status: "done"; draft: StructureDraft }
  | { status: "error"; failure: Exclude<TranscriptionFailure, "delayed"> }

export interface ReviewClient {
  getReview(meetingId: string): Promise<StoredReview | null>
  saveStep1(meetingId: string, input: Step1Input): Promise<StoredReview>
  structureText(meetingId: string, text: string): Promise<StructureDraft>
  // 녹음 전사는 비동기 — 접수만 하고 jobId 를 받는다(블로킹 금지). 완료는 getTranscriptionStatus 폴링.
  startTranscription(meetingId: string, audio: File): Promise<{ jobId: string }>
  // options.signal — 폴링 1회 시간 초과 시 요청을 취소한다(transcription-tracker). 목업은 무시해도 된다.
  getTranscriptionStatus(
    meetingId: string,
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptionStatus>
  saveStep2(meetingId: string, input: Step2Input): Promise<StoredReview>
  // 인증 헤더가 필요해 <a href>로는 안 됨 → blob 받아 브라우저 다운로드까지 수행.
  downloadReport(meetingId: string, fmt: "pdf" | "docx"): Promise<void>
  // 러브콜 메일(#13) — 상태 조회 → AI 초안 → (사용자 수정) → 발송. 실패는 throw로 드러낸다.
  getLoveCallMailState(meetingId: string): Promise<LoveCallMailState>
  draftLoveCallMail(meetingId: string): Promise<LoveCallMailDraft>
  sendLoveCallMail(
    meetingId: string,
    input: { subject: string; body: string },
  ): Promise<LoveCallMailState>
}
