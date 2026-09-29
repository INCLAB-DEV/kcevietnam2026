// 실 백엔드(FastAPI) 호출 클라이언트 — 실 로그인 세션(review/client.ts의 realSession)일 때 mock
// 대신 쓴다. 같은 출처 BFF(app/api/reviews/[...path]/route.ts)를 상대경로로 호출한다 — 세션은
// httpOnly 쿠키(브라우저가 same-origin 요청에 자동 첨부)라 이 클라 코드는 토큰을 직접 만지지 않는다.
// ⚠ 예전엔 X-Org-Id 헤더로 현재 org를 자기신고했는데(누구나 위조 가능), 백엔드가 이미 제거·금지했다
// (backend/app/api/deps.py "다시 만들지 말 것") — 이제 org는 BFF가 붙인 Bearer에서 백엔드
// principal이 도출한다(get_current_principal). 키(Claude/Whisper)는 백엔드에만. FE 는 이 HTTP
// 경계만 호출한다.

import type {
  LoveCallMailDraft,
  LoveCallMailState,
  ReviewClient,
  Step1Input,
  Step2Input,
  StoredReview,
  StructureDraft,
  TranscriptionStatus,
} from "./types"

// 백엔드 전사 초안 응답(snake_case) → StructureDraft. transcribe/structure 양쪽이 같은 형태.
interface ApiDraft {
  report: StructureDraft["report"]
  fit_suggestion: StructureDraft["fitSuggestion"]
  fit_reason_seed: string
  fit_reason_tags: string[]
  transcript: string
  transcript_turns?: StructureDraft["transcriptTurns"] | null
  audio_s3_key?: string | null
}

function toDraft(d: ApiDraft): StructureDraft {
  return {
    report: d.report,
    fitSuggestion: d.fit_suggestion,
    fitReasonSeed: d.fit_reason_seed,
    fitReasonTags: d.fit_reason_tags,
    transcript: d.transcript,
    transcriptTurns: d.transcript_turns ?? [],
    audioS3Key: d.audio_s3_key ?? undefined,
  }
}

interface ApiReview {
  is_noshow: boolean
  counterpart_noshow: boolean
  satisfaction: number | null
  follow_up_intent: StoredReview["followUpIntent"]
  report_sections: StoredReview["report"]
  fit_rating: StoredReview["fitRating"]
  fit_reason: string
  fit_reason_tags: string[]
  transcript_turns?: StoredReview["transcriptTurns"] | null
  report_confirmed: boolean
}

function toStored(r: ApiReview): StoredReview {
  return {
    isNoshow: r.is_noshow,
    counterpartNoshow: r.counterpart_noshow,
    satisfaction: r.satisfaction,
    followUpIntent: r.follow_up_intent,
    report: r.report_sections,
    fitRating: r.fit_rating,
    fitReason: r.fit_reason ?? "",
    fitReasonTags: r.fit_reason_tags ?? [],
    transcriptTurns: r.transcript_turns ?? [],
    reportConfirmed: r.report_confirmed,
  }
}

interface ApiLoveCallMailState {
  recipient_org_name: string
  recipient_count: number
  report_ready: boolean
  sent: boolean
  sent_at: string | null
  subject: string | null
  body: string | null
}

function toLoveCallMailState(s: ApiLoveCallMailState): LoveCallMailState {
  return {
    recipientOrgName: s.recipient_org_name,
    recipientCount: s.recipient_count,
    reportReady: s.report_ready,
    sent: s.sent,
    sentAt: s.sent_at,
    subject: s.subject,
    body: s.body,
  }
}

// FastAPI의 {detail} 을 사람이 읽을 메시지로 꺼낸다 — 러브콜은 실패 사유(크레딧 소진·SMTP 인증
// 실패·수신자 없음)를 **그대로 사용자에게 보여줘야** 하는 흐름이라 "API 502" 로 뭉개면 안 된다.
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === "string") return parsed.detail
  } catch {
    // JSON이 아니면 원문을 그대로 쓴다.
  }
  return text || `API ${res.status}`
}

export function createHttpReviewClient(): ReviewClient {
  const jsonHeaders = { "Content-Type": "application/json" }

  // 상대경로 = 같은 출처 BFF(app/api/reviews/[...path]/route.ts). BFF가 `/api/reviews/{나머지}`를
  // 백엔드 `/meetings/{나머지}`로 그대로 넘긴다(무접두사) — 그래서 여기 경로는 "meetings/" 세그먼트
  // 없이 바로 `{meetingId}/review...`로 시작한다. 같은 출처 요청이라 세션 쿠키는 자동 첨부된다.
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api/reviews/${path}`, init)
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }

  return {
    async getReview(meetingId) {
      // 15초 타임아웃 — 백엔드 무응답 시 무한 "불러오는 중…" 대신 에러로 떨어뜨려 재시도 UI 노출.
      const res = await fetch(`/api/reviews/${meetingId}/review`, { signal: AbortSignal.timeout(15000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`API ${res.status}`)
      const body = (await res.json()) as { review: ApiReview }
      return toStored(body.review)
    },

    async saveStep1(meetingId, input: Step1Input) {
      const body = await req<{ review: ApiReview }>(`${meetingId}/review/step1`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          proceeded: input.proceeded,
          satisfaction: input.satisfaction,
          follow_up_intent: input.followUpIntent,
        }),
      })
      return toStored(body.review)
    },

    async structureText(meetingId, text): Promise<StructureDraft> {
      const d = await req<ApiDraft>(`${meetingId}/review/step2/structure`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ text }),
      })
      return toDraft(d)
    },

    async startTranscription(meetingId, audio): Promise<{ jobId: string }> {
      const form = new FormData()
      form.append("audio", audio)
      // 202 접수 — 전사는 백엔드 BackgroundTask 에서 진행. 여기선 jobId 만 받는다(블로킹 금지).
      const d = await req<{ job_id: string; status: string }>(`${meetingId}/review/step2/transcribe`, {
        method: "POST",
        body: form,
      })
      return { jobId: d.job_id }
    },

    async getTranscriptionStatus(meetingId, jobId): Promise<TranscriptionStatus> {
      const d = await req<{ status: "pending" | "done" | "error"; draft: ApiDraft | null; error: string | null }>(
        `${meetingId}/review/step2/transcribe/${jobId}`,
      )
      if (d.status === "done" && d.draft) return { status: "done", draft: toDraft(d.draft) }
      if (d.status === "error") return { status: "error", error: d.error ?? "전사 실패" }
      return { status: "pending" }
    },

    async saveStep2(meetingId, input: Step2Input) {
      const body = await req<{ review: ApiReview }>(`${meetingId}/review/step2`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          report: input.report,
          fit_rating: input.fitRating,
          fit_reason: input.fitReason,
          fit_reason_tags: input.fitReasonTags,
          transcript: input.transcript,
          transcript_turns: input.transcriptTurns ?? [],
          audio_s3_key: input.audioS3Key,
          finalize: input.finalize,
        }),
      })
      return toStored(body.review)
    },

    async downloadReport(meetingId, fmt) {
      const res = await fetch(`/api/reviews/${meetingId}/review/export?fmt=${fmt}`)
      if (!res.ok) throw new Error(`export ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `meeting-report.${fmt}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    },

    async getLoveCallMailState(meetingId): Promise<LoveCallMailState> {
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail`)
      if (!res.ok) throw new Error(await errorMessage(res))
      return toLoveCallMailState((await res.json()) as ApiLoveCallMailState)
    },

    async draftLoveCallMail(meetingId): Promise<LoveCallMailDraft> {
      // 백엔드는 AI 실패도 200 + ai_generated=false 로 준다(수동 작성 경로 보존). 여기서 200이
      // 아니면 그건 권한·중복 발송 같은 진짜 거절이라 그대로 throw 한다.
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail/draft`, { method: "POST" })
      if (!res.ok) throw new Error(await errorMessage(res))
      const d = (await res.json()) as {
        subject: string
        body: string
        ai_generated: boolean
        error: string | null
        recipient_org_name: string
        recipient_count: number
      }
      return {
        subject: d.subject,
        body: d.body,
        aiGenerated: d.ai_generated,
        error: d.error,
        recipientOrgName: d.recipient_org_name,
        recipientCount: d.recipient_count,
      }
    },

    async sendLoveCallMail(meetingId, input): Promise<LoveCallMailState> {
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail/send`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ subject: input.subject, body: input.body }),
      })
      if (!res.ok) throw new Error(await errorMessage(res))
      return toLoveCallMailState((await res.json()) as ApiLoveCallMailState)
    },
  }
}
