// 미팅 리뷰 mock 클라이언트 — 백엔드(#42 FastAPI) 계약을 그대로 흉내낸다.
// TODO(실연동): 아래 메서드를 FastAPI 호출로 교체. 엔드포인트는 이미 백엔드에 구현됨:
//   POST /meetings/{id}/review/step1
//   POST /meetings/{id}/review/step2/structure   (텍스트 폴백)
//   POST /meetings/{id}/review/step2/transcribe   (녹음 업로드, multipart)
//   POST /meetings/{id}/review/step2              (저장)
//   GET  /meetings/{id}/review                    (본인 열람)
//   GET  /meetings/{id}/review/export?fmt=pdf|docx
// (예전엔 여기에 POST /meetings/{id}/love-call 껍데기 신호 엔드포인트도 있었으나, 실제로 아무
//  이메일도 나가지 않는 껍데기 UI였어서 삭제했다 — 실 발송은 love-call/mail/* 경로로 한다.)
// 키(Claude/Whisper)는 backend 한정(ADR-0008) — FE 는 절대 직접 호출하지 않는다.

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
import { normalizeStep1 } from "./review-step"

const STORE = new Map<string, StoredReview>()
const LOVE_CALLS = new Map<string, Set<string>>() // meetingId -> who-sent
// 러브콜 메일(#13) 발송 이력 — meetingId → 발송본. 백엔드 love_calls.email_* 를 흉내낸다.
const LOVE_CALL_MAILS = new Map<string, { subject: string; body: string; sentAt: string; recipientCount: number }>()
const MOCK_RECIPIENT_COUNT = 2
// mock 은 미팅 상대를 모른다(백엔드가 meetings 에서 해석) — 데모 표시용 고정 이름.
const MOCK_COUNTERPART = "상대 기업"
// 데모 전사 작업 — jobId → {준비 완료 시각, 초안}. 실제론 백엔드 인메모리 JobStore 가 담당.
const JOBS = new Map<string, { readyAt: number; draft: StructureDraft }>()
let jobSeq = 0

function delay<T>(value: T, ms = 700): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

// 데모 전사본 — 실제로는 Whisper 가 녹음을 전사. 텍스트 폴백 시엔 사용자가 직접 입력.
const DEMO_TRANSCRIPT =
  "글로벌 OTT향 라이선싱 기간을 기존 2년에서 3년으로 늘리는 게 핵심 논의사항이었음. " +
  "캐릭터 IP 확장 라이선스도 함께 검토했고, 로열티 정산 방식과 2027년 1분기 방영 일정도 논의함. " +
  "8월 중순까지 라이선스 계약서 초안을 보내주기로 했고, 우리 쪽 내부 검토 결과를 8월 말까지 회신하기로 함."

function draftFromText(text: string): StructureDraft {
  // 데모 구조화 — 실제로는 Claude 가 3섹션 + Fit 제안 + 화자추정. 줄/문장 단위로 단순 분배.
  const lines = text
    .split(/[.\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    report: {
      discussion: lines.slice(0, 2),
      agreements: lines.slice(2, 3),
      actions: lines.slice(3, 5),
    },
    fitSuggestion: "good",
    fitReasonSeed: "기술 성숙도가 높고 납품 일정에 대한 구체적 합의가 있었음",
    fitReasonTags: ["기술 성숙도", "도입 시기"],
    transcript: text,
    // 데모 화자 추정 — 문장 단위로 us/them 교대(실제론 Claude 가 맥락 기반 추정).
    transcriptTurns: lines.map((t, i) => ({ who: i % 2 === 0 ? "us" : "them", text: t })),
  }
}

export const mockReviewClient: ReviewClient = {
  async getReview(meetingId) {
    return delay(STORE.get(meetingId) ?? null, 200)
  },

  async saveStep1(meetingId, input: Step1Input) {
    const n = normalizeStep1(input)
    const prev = STORE.get(meetingId)
    const stored: StoredReview = {
      isNoshow: n.proceeded !== "proceeded",
      counterpartNoshow: n.proceeded === "counterpart_noshow",
      satisfaction: n.satisfaction,
      followUpIntent: n.followUpIntent,
      report: prev?.report ?? null,
      fitRating: prev?.fitRating ?? null,
      fitReason: prev?.fitReason ?? "",
      fitReasonTags: prev?.fitReasonTags ?? [],
      transcriptTurns: prev?.transcriptTurns ?? [],
      reportConfirmed: prev?.reportConfirmed ?? false,
    }
    STORE.set(meetingId, stored)
    return delay(stored, 400)
  },

  async structureText(meetingId, text) {
    return delay(draftFromText(text || DEMO_TRANSCRIPT), 900)
  },

  async startTranscription(meetingId, audio) {
    // 데모: 녹음 바이트를 받아 전사한 것처럼 접수. ~4초 뒤 완료되도록 작업을 등록(블로킹 금지).
    void audio
    jobSeq += 1
    const jobId = `mock-job-${jobSeq}`
    JOBS.set(jobId, {
      readyAt: Date.now() + 4000,
      draft: { ...draftFromText(DEMO_TRANSCRIPT), audioS3Key: `mock/${meetingId}` },
    })
    return delay({ jobId }, 300)
  },

  async getTranscriptionStatus(meetingId, jobId): Promise<TranscriptionStatus> {
    void meetingId
    const job = JOBS.get(jobId)
    if (!job) return delay({ status: "error", error: "전사 작업을 찾을 수 없어요" }, 150)
    if (Date.now() < job.readyAt) return delay({ status: "pending" }, 150)
    return delay({ status: "done", draft: job.draft }, 150)
  },

  async saveStep2(meetingId, input: Step2Input) {
    const prev = STORE.get(meetingId)
    const stored: StoredReview = {
      isNoshow: false,
      counterpartNoshow: false,
      satisfaction: prev?.satisfaction ?? null,
      followUpIntent: prev?.followUpIntent ?? null,
      report: input.report,
      fitRating: input.fitRating,
      fitReason: input.fitReason,
      fitReasonTags: input.fitReasonTags,
      // 전사는 직접 편집 없음 — 초안값(input)을 우선 보존하되, 없으면 기존 저장본 유지.
      transcriptTurns: input.transcriptTurns ?? prev?.transcriptTurns ?? [],
      reportConfirmed: input.finalize,
    }
    STORE.set(meetingId, stored)
    return delay(stored, 500)
  },

  async downloadReport(meetingId, fmt) {
    // mock 은 실제 PDF/DOCX 를 만들 수 없어 본문을 텍스트로 내려준다(백엔드 연동 시 진짜 파일).
    const r = STORE.get(meetingId)
    const sec = (title: string, items?: string[]) =>
      `# ${title}\n${(items ?? []).map((i) => `- ${i}`).join("\n")}\n`
    const text =
      `미팅 보고서 (mock · ${fmt})\n\n` +
      sec("핵심 논의사항", r?.report?.discussion) +
      sec("합의 사항", r?.report?.agreements) +
      sec("후속 액션", r?.report?.actions) +
      `\n※ 비공개 항목(적합도·후속의향)은 포함되지 않습니다. 실제 ${fmt.toUpperCase()} 파일은 백엔드 연동 시 생성됩니다.`
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `meeting-report-mock.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },

  async getLoveCallMailState(meetingId): Promise<LoveCallMailState> {
    const r = STORE.get(meetingId)
    const sent = LOVE_CALL_MAILS.get(meetingId)
    return delay(
      {
        recipientOrgName: MOCK_COUNTERPART,
        recipientCount: sent?.recipientCount ?? MOCK_RECIPIENT_COUNT,
        reportReady: !!r?.report && (r.report.discussion.length + r.report.agreements.length + r.report.actions.length) > 0,
        sent: !!sent,
        sentAt: sent?.sentAt ?? null,
        subject: sent?.subject ?? null,
        body: sent?.body ?? null,
      },
      200,
    )
  },

  async draftLoveCallMail(meetingId): Promise<LoveCallMailDraft> {
    const r = STORE.get(meetingId)
    const report = r?.report
    const lines = [...(report?.discussion ?? []), ...(report?.agreements ?? []), ...(report?.actions ?? [])]
    if (lines.length === 0) {
      // 백엔드와 같은 계약: 재료가 없으면 실패를 드러내고 빈 편집기를 연다(조용히 때우지 않는다).
      return delay(
        {
          subject: `[NABI] ${MOCK_COUNTERPART} 담당자님께 드리는 미팅 후속 제안`,
          body: "",
          aiGenerated: false,
          error: "확정된 회의록이 없어 AI 초안을 만들 수 없어요. 직접 작성해 주세요.",
          recipientOrgName: MOCK_COUNTERPART,
          recipientCount: MOCK_RECIPIENT_COUNT,
        },
        400,
      )
    }
    const ko = [
      `${MOCK_COUNTERPART} 담당자님, 안녕하세요.`,
      "지난 미팅에서 나눠 주신 이야기에 감사드립니다.",
      lines.map((l) => `- ${l}`).join("\n"),
      "논의한 내용을 바탕으로 다음 단계를 함께 이어가고 싶습니다.",
    ].join("\n\n")
    const en = [
      `Dear ${MOCK_COUNTERPART} team,`,
      "Thank you for the time you gave us at our recent meeting.",
      lines.map((l) => `- ${l}`).join("\n"),
      "We would be glad to take the next step together.",
    ].join("\n\n")
    return delay(
      {
        subject: `[NABI] ${MOCK_COUNTERPART} 담당자님께 — 미팅 후속 제안 드립니다`,
        body: `${ko}\n\n─────────────────────────\n\n${en}`,
        aiGenerated: true,
        error: null,
        recipientOrgName: MOCK_COUNTERPART,
        recipientCount: MOCK_RECIPIENT_COUNT,
      },
      600,
    )
  },

  async sendLoveCallMail(meetingId, input): Promise<LoveCallMailState> {
    if (LOVE_CALL_MAILS.has(meetingId)) throw new Error("이 미팅의 러브콜 메일은 이미 발송했습니다")
    const subject = input.subject.trim()
    const body = input.body.trim()
    if (!subject || !body) throw new Error("메일 제목과 본문을 모두 입력하세요")
    const record = {
      subject,
      body,
      sentAt: new Date().toISOString(),
      recipientCount: MOCK_RECIPIENT_COUNT,
    }
    LOVE_CALL_MAILS.set(meetingId, record)
    const set = LOVE_CALLS.get(meetingId) ?? new Set()
    set.add("me")
    LOVE_CALLS.set(meetingId, set)
    const r = STORE.get(meetingId)
    return delay(
      {
        recipientOrgName: MOCK_COUNTERPART,
        recipientCount: record.recipientCount,
        reportReady: !!r?.report,
        sent: true,
        sentAt: record.sentAt,
        subject: record.subject,
        body: record.body,
      },
      400,
    )
  },
}
