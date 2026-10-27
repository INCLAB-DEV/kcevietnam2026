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
import { LoveCallMailApiError, ReviewApiError, detailCode } from "./api-error"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"

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
  // 행사 메일 스위치. 필드가 없으면(이 값을 모르는 구 백엔드 — 롤아웃 중) 켜짐으로 읽는다: 구 백엔드는 러브콜
  // 메일을 스위치와 무관하게 보낸다. 막는 곳은 백엔드 발송 API다(꺼져 있으면 409) — 여기 값은 화면 안내용이다.
  participant_email_enabled?: boolean | null
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
    emailEnabled: typeof s.participant_email_enabled === "boolean" ? s.participant_email_enabled : true,
  }
}

// FastAPI의 {detail} 을 사람이 읽을 메시지로 꺼낸다 — 러브콜 실패는 "API 502" 로 뭉개지 않고 백엔드가 준
// 문구를 그대로 보여준다. 백엔드는 이제 원인(공급자 오류 본문·SMTP 응답 등)을 싣지 않고 사용자용 **고정 문구**만
// 보낸다(원인은 서버 로그에만 — backend/app/api/love_call.py) — 그래서 그대로 띄워도 내부 정보가 새지 않는다.
// 그 문구의 언어는 요청에 실어 보낸 locale을 따른다(아래 createHttpReviewClient의 localeQuery).
// 코드가 붙은 거절(detail = {code, message} — 행사 메일 스위치 꺼짐 409)은 message를 꺼낸다.
function errorMessageOf(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === "string") return parsed.detail
    const detail = parsed.detail as { message?: unknown } | null | undefined
    if (detail && typeof detail === "object" && typeof detail.message === "string") return detail.message
  } catch {
    // JSON이 아니면 원문을 그대로 쓴다.
  }
  return text || `API ${status}`
}

async function errorMessage(res: Response): Promise<string> {
  return errorMessageOf(await res.text(), res.status)
}

// locale은 **백엔드가 문장을 만들어 주는** 호출에만 싣는다 — 러브콜 메일(상대 기업명·실패 사유 문구)과
// 보고서 내보내기(문서 안의 항목 이름). 백엔드가 그 값을 보고 ko/en 문구를 고른다(탐색·가용성 API의
// `?locale=`과 같은 방식). 나머지 호출은 코드·데이터만 오가고 문구는 화면이 카탈로그에서 뽑는다.
export function createHttpReviewClient(locale: Locale = DEFAULT_LOCALE): ReviewClient {
  const jsonHeaders = { "Content-Type": "application/json" }
  const localeQuery = `locale=${locale}`

  // 상대경로 = 같은 출처 BFF(app/api/reviews/[...path]/route.ts). BFF가 `/api/reviews/{나머지}`를
  // 백엔드 `/meetings/{나머지}`로 그대로 넘긴다(무접두사) — 그래서 여기 경로는 "meetings/" 세그먼트
  // 없이 바로 `{meetingId}/review...`로 시작한다. 같은 출처 요청이라 세션 쿠키는 자동 첨부된다.
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api/reviews/${path}`, init)
    if (!res.ok) {
      // 상태·detail.code 를 실어 던진다 — 화면이 "AI 바쁨(503)·파일 초과(413)·그 밖"을 구분해 안내한다.
      const body = await res.text()
      throw new ReviewApiError(res.status, detailCode(body), body)
    }
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
      // 202 접수 — 전사는 백엔드 전사 전용 풀에서 진행. 여기선 jobId 만 받는다(블로킹 금지).
      const d = await req<{ job_id: string; status: string }>(`${meetingId}/review/step2/transcribe`, {
        method: "POST",
        body: form,
      })
      return { jobId: d.job_id }
    },

    async getTranscriptionStatus(meetingId, jobId, options): Promise<TranscriptionStatus> {
      // error(사람이 읽는 문구)는 한국어 고정이라 화면에 쓰지 않는다 — 실패 종류는 error_code로 받는다
      // (backend/app/schemas.py TranscribeStatusResponse). 코드가 없거나 모르는 값이면 일반 실패로 본다.
      const d = await req<{
        status: "pending" | "done" | "error"
        draft: ApiDraft | null
        error: string | null
        error_code?: string | null
      }>(`${meetingId}/review/step2/transcribe/${jobId}`, { signal: options?.signal })
      if (d.status === "done" && d.draft) return { status: "done", draft: toDraft(d.draft) }
      if (d.status === "error") {
        return { status: "error", failure: d.error_code === "audio_too_long" ? "audioTooLong" : "failed" }
      }
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
      const res = await fetch(`/api/reviews/${meetingId}/review/export?fmt=${fmt}&${localeQuery}`)
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
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail?${localeQuery}`)
      if (!res.ok) throw new Error(await errorMessage(res))
      return toLoveCallMailState((await res.json()) as ApiLoveCallMailState)
    },

    async draftLoveCallMail(meetingId): Promise<LoveCallMailDraft> {
      // 백엔드는 AI 실패도 200 + ai_generated=false 로 준다(수동 작성 경로 보존). 여기서 200이
      // 아니면 그건 권한·중복 발송 같은 진짜 거절이라 그대로 throw 한다.
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail/draft?${localeQuery}`, {
        method: "POST",
      })
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
      const res = await fetch(`/api/reviews/${meetingId}/love-call/mail/send?${localeQuery}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ subject: input.subject, body: input.body }),
      })
      if (!res.ok) {
        // 거절 종류(detail.code)를 함께 싣는다 — 행사 메일 스위치가 꺼진 409(PARTICIPANT_EMAIL_DISABLED)면 화면이
        // '발송하기'를 잠근다. 메시지는 예전과 같은 화면용 문구다.
        const text = await res.text()
        throw new LoveCallMailApiError(res.status, detailCode(text), errorMessageOf(text, res.status))
      }
      return toLoveCallMailState((await res.json()) as ApiLoveCallMailState)
    },
  }
}
