"use client"

// 러브콜 메일(#13) — 회의록 화면(완료 단계)에서 "AI 초안 → 검토·수정 → 발송"을 수행하는 카드.
//
// 이 화면의 규약 세 가지:
// 1. **버튼 한 번에 쏘지 않는다.** 초안은 다이얼로그 안에서 보여주고, 사용자가 제목·본문을 고친
//    뒤에야 발송한다. 화면에 보이는 텍스트가 곧 발송본이다(서버가 다시 손대지 않는다).
// 2. **실패를 숨기지 않는다.** AI 실패는 빨간 배너로 띄우고 편집기를 비운 채 열어 직접 쓰게 한다.
//    발송 실패는 다이얼로그 안에 그대로 남겨 작성한 본문을 잃지 않고 재시도하게 한다.
//    (이 코드베이스에서 반복된 사고 — 낙관적 UI 가 실패를 성공처럼 보이게 만든 write 계통 버그.)
// 3. **한 미팅에 한 번.** 이미 보냈으면 발송본을 그대로 보여주고 다시 보낼 수 없다.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2, Mail, Send, Sparkles, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { LoveCallMailState, ReviewClient } from "@/lib/review/types"

function formatSentAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function LoveCallMailCard({
  meetingId,
  api,
}: {
  meetingId: string
  api: ReviewClient
}) {
  const t = useTranslations("review.loveCallMail")

  const [state, setState] = useState<LoveCallMailState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0) // 다시 시도 트리거

  // 로딩 시작 상태(loading=true, 에러 비움)는 effect 본문이 아니라 트리거 쪽에서 만든다 —
  // 최초는 useState 초기값, 재시도는 아래 retry 핸들러. effect는 결과 반영만 한다.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const s = await api.getLoveCallMailState(meetingId)
        if (active) setState(s)
      } catch (e) {
        // 상태 조회 실패도 조용히 넘기지 않는다 — 카드 자리에 사유와 재시도를 띄운다.
        if (active) setLoadError(e instanceof Error ? e.message : String(e))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [api, meetingId, reloadKey])

  function retryLoad() {
    setLoading(true)
    setLoadError(null)
    setReloadKey((k) => k + 1)
  }

  if (loading) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">{t("loading")}</Card>
    )
  }

  if (loadError || !state) {
    return (
      <Card className="p-6">
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t("stateErrorTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={retryLoad}>
              {t("retryDraft")}
            </Button>
          </AlertDescription>
        </Alert>
      </Card>
    )
  }

  if (state.sent) {
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 text-green-600" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t("sentTitle")}</p>
            <p className="text-sm text-muted-foreground">
              {t("sentSummary", { org: state.recipientOrgName, count: state.recipientCount })}
              {state.sentAt ? ` (${formatSentAt(state.sentAt)})` : ""}
            </p>
            <p className="text-xs text-muted-foreground">{t("sentOnlyOnce")}</p>
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold">{t("sentSubjectLabel")}</p>
          <p className="text-sm text-muted-foreground">{state.subject}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold">{t("sentBodyLabel")}</p>
          {/* 긴 본문이 카드를 밖으로 밀지 않도록 내부 스크롤. */}
          <p className="max-h-64 overflow-y-auto rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">
            {state.body}
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="size-4 text-rose-500" /> {t("title")}
        </span>
        <span className="text-sm text-muted-foreground">
          {t("description", { org: state.recipientOrgName })}
        </span>
      </div>

      {!state.reportReady && (
        <p className="text-xs text-muted-foreground">{t("reportRequired")}</p>
      )}

      {state.recipientCount === 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            {t("noRecipients", { org: state.recipientOrgName })}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <LoveCallMailDialog
          meetingId={meetingId}
          api={api}
          disabled={state.recipientCount === 0}
          onSent={(next) => {
            setState(next)
            toast.success(t("toastSent"))
          }}
        />
        <span className="text-xs text-muted-foreground">{t("privacyNote")}</span>
      </div>
    </Card>
  )
}

function LoveCallMailDialog({
  meetingId,
  api,
  disabled,
  onSent,
}: {
  meetingId: string
  api: ReviewClient
  disabled: boolean
  onSent: (state: LoveCallMailState) => void
}) {
  const t = useTranslations("review.loveCallMail")

  const [open, setOpen] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [loaded, setLoaded] = useState(false) // 다이얼로그를 다시 열어도 작성 중이던 내용을 지키기 위한 1회 로드 표시
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [aiError, setAiError] = useState<string | null>(null) // AI가 못 썼다(수동 작성 가능)
  const [draftError, setDraftError] = useState<string | null>(null) // 초안 요청 자체가 실패
  const [recipient, setRecipient] = useState<{ org: string; count: number }>({ org: "", count: 0 })
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const runDraft = useCallback(async () => {
    setDrafting(true)
    setAiError(null)
    setDraftError(null)
    try {
      const d = await api.draftLoveCallMail(meetingId)
      setSubject(d.subject)
      setBody(d.body)
      setRecipient({ org: d.recipientOrgName, count: d.recipientCount })
      // ai_generated=false 는 백엔드가 "AI는 실패했지만 직접 쓸 수 있게 열어둔다"고 말한 것이다.
      // 빈 본문을 성공처럼 보여주지 않고 사유를 그대로 띄운다.
      setAiError(d.aiGenerated ? null : (d.error ?? t("aiFailedTitle")))
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      setDrafting(false)
      setLoaded(true)
    }
  }, [api, meetingId, t])

  // 초안 생성은 **사용자가 다이얼로그를 여는 이벤트**에서 시작한다(effect 아님) — 한 번 받은
  // 초안은 다시 열어도 유지해 작성 중이던 내용을 잃지 않는다.
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && !loaded && !drafting) void runDraft()
  }

  async function send() {
    if (sending) return
    setSending(true)
    setSendError(null)
    try {
      const next = await api.sendLoveCallMail(meetingId, { subject, body })
      setOpen(false)
      onSent(next)
    } catch (e) {
      // 발송 실패 — 다이얼로그를 닫지 않는다. 작성한 본문을 그대로 두고 사유를 보여준다.
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const canSend = subject.trim().length > 0 && body.trim().length > 0 && !sending

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>
          <Sparkles className="size-4" /> {t("openButton")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90svh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        {drafting ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" /> {t("generating")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {draftError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>{t("draftErrorTitle")}</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2">
                  <span>{draftError}</span>
                  <span>{t("aiFailedManualHint")}</span>
                  <Button variant="outline" size="sm" onClick={runDraft}>
                    {t("retryDraft")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {aiError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>{t("aiFailedTitle")}</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2">
                  <span>{aiError}</span>
                  <span>{t("aiFailedManualHint")}</span>
                  <Button variant="outline" size="sm" onClick={runDraft}>
                    {t("retryDraft")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {sendError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>{t("sendFailedTitle")}</AlertTitle>
                <AlertDescription>{sendError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="love-call-subject">{t("subjectLabel")}</Label>
              <Input
                id="love-call-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="love-call-body">{t("bodyLabel")}</Label>
              <Textarea
                id="love-call-body"
                value={body}
                placeholder={t("bodyPlaceholder")}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-64"
              />
            </div>

            <p className="text-xs text-muted-foreground">{t("privacyNote")}</p>
          </div>
        )}

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {recipient.count > 0
              ? t("recipients", { org: recipient.org, count: recipient.count })
              : t("noRecipients", { org: recipient.org })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
              {t("close")}
            </Button>
            <Button onClick={send} disabled={!canSend || recipient.count === 0}>
              <Send className="size-4" /> {sending ? t("sending") : t("send")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
