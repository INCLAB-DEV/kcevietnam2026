"use client"

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2,
  Download,
  FileAudio,
  FileText,
  Lock,
  Mic,
  ScrollText,
  Sparkles,
  Star,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useIsMobile } from "@/hooks/use-mobile"
import { LoveCallMailCard } from "@/components/review/love-call-mail"
import { getReviewClient } from "@/lib/review/client"
import {
  recallSelectedFile,
  rememberSelectedFile,
  takeCompletedDraft,
  trackTranscription,
} from "@/lib/review/transcription-tracker"
import { canSubmitStep1, isNoshow } from "@/lib/review/review-step"
import type {
  FitRating,
  FollowUpIntent,
  MeetingProceeded,
  ReportSections,
  ReviewClient,
  Step1Input,
  StoredReview,
  StructureDraft,
  TranscriptTurn,
} from "@/lib/review/types"

type Mode = "intake" | "compose" | "done"

// 옵션 값 목록 — 라벨은 t("review.proceededOptions.*")로 조립(IntakeStep 호출부).
const PROCEEDED_VALUES: { value: MeetingProceeded; key: string }[] = [
  { value: "proceeded", key: "proceeded" },
  { value: "counterpart_noshow", key: "counterpartNoshow" },
  { value: "self_noshow", key: "selfNoshow" },
]
const FOLLOW_UPS: FollowUpIntent[] = ["none", "reviewing", "yes"]
const FITS: FitRating[] = ["good", "normal", "bad"]

function linesToText(items: string[]): string {
  return items.join("\n")
}
function textToLines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ReviewFlow({
  meetingId,
  counterpartOrg,
  orgId,
  realSession = false,
}: {
  meetingId: string
  counterpartOrg: string
  orgId: string
  // 실 로그인 세션이면 BFF(/api/reviews) 경유 실 백엔드, 아니면 mock(기존 동작 보존).
  realSession?: boolean
}) {
  const t = useTranslations("review")
  const api = useMemo(() => getReviewClient(realSession), [realSession])
  // C3(QA): 1.AI 보고서+적합도 → 2.미팅 후기 → 3.완료 순으로 바뀌었다 — 보고서부터 작성하고
  // 그 다음 후기를 남긴다. 백엔드 저장 순서(Step1 먼저, Step2 는 Step1 존재를 전제)는 그대로 두고
  // (409 가드 유지), 실제 저장은 후기 화면의 최종 제출(finishReview)에서 Step1→Step2 순서로
  // 한 번에 묶어 보낸다 — 그래서 신규 진입 시 기본 모드가 "compose"(보고서)다.
  const [mode, setMode] = useState<Mode>("compose")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0) // 다시 시도 트리거

  // Step1 상태
  const [proceeded, setProceeded] = useState<MeetingProceeded | null>(null)
  const [satisfaction, setSatisfaction] = useState<number | null>(null)
  const [followUp, setFollowUp] = useState<FollowUpIntent | null>(null)

  // Step2 상태
  const [inputMode, setInputMode] = useState<"audio" | "text">("audio")
  const [memo, setMemo] = useState("")
  const [aiBusy, setAiBusy] = useState(false)
  const [draft, setDraft] = useState<StructureDraft | null>(null)
  const [discussion, setDiscussion] = useState("")
  const [agreements, setAgreements] = useState("")
  const [actions, setActions] = useState("")
  const [fit, setFit] = useState<FitRating | null>(null)
  const [fitReason, setFitReason] = useState("")
  const [fitTags, setFitTags] = useState<string[]>([])
  // 화자별 전사 — 직접 편집은 없지만, 재진입 수정(done→compose) 후 재저장 때 덮어쓰지 않도록 상태로 보존.
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[]>([])

  const [stored, setStored] = useState<StoredReview | null>(null)
  // 후기(2단계) 최종 제출 중 — 중복 클릭 방지. 이 자체는 낙관적 처리가 아니다: 성공해야만 done 전환.
  const [submitting, setSubmitting] = useState(false)
  // 진행 중인 전사 추적의 detach — 언마운트 시 인페이지 콜백만 떼고 폴링·알림은 모듈에서 계속된다.
  const trackRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(false)
    // getReview 실패/지연이 무한 "불러오는 중…"으로 굳지 않도록 try/catch/finally 로 감싼다.
    // 성공이든 에러든 loading 은 반드시 풀리고, 에러면 재시도 UI 를 띄운다.
    ;(async () => {
      try {
        const r = await api.getReview(meetingId)
        if (!active) return
        if (r) {
          setStored(r)
          setSatisfaction(r.satisfaction)
          setFollowUp(r.followUpIntent)
          if (r.report) {
            setDiscussion(linesToText(r.report.discussion))
            setAgreements(linesToText(r.report.agreements))
            setActions(linesToText(r.report.actions))
          }
          setFit(r.fitRating)
          setFitReason(r.fitReason)
          setFitTags(r.fitReasonTags)
          setTranscriptTurns(r.transcriptTurns)
          if (r.reportConfirmed || r.isNoshow) setMode("done")
          else {
            setProceeded("proceeded")
            setMode("compose")
          }
        }
        // 화면을 떠난 사이 전사가 끝났으면(알림으로 복귀) 캐시된 초안을 복원해 바로 검수로.
        const pending = takeCompletedDraft(meetingId)
        if (pending && !(r && r.reportConfirmed)) {
          applyDraft(pending)
          setProceeded("proceeded")
          setMode("compose")
        }
      } catch {
        if (active) setLoadError(true)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [meetingId, api, reloadKey])

  // 언마운트 시 인페이지 추적 콜백 분리(폴링·알림 발송은 모듈에서 계속).
  useEffect(() => () => trackRef.current?.(), [])

  function applyReport(report: ReportSections) {
    setDiscussion(linesToText(report.discussion))
    setAgreements(linesToText(report.agreements))
    setActions(linesToText(report.actions))
  }

  function applyDraft(d: StructureDraft) {
    setDraft(d)
    applyReport(d.report)
    setFit(d.fitSuggestion)
    setFitReason(d.fitReasonSeed)
    setFitTags(d.fitReasonTags)
    setTranscriptTurns(d.transcriptTurns)
  }

  function currentReport(): ReportSections {
    return {
      discussion: textToLines(discussion),
      agreements: textToLines(agreements),
      actions: textToLines(actions),
    }
  }

  // 보고서(1단계) 화면 → 후기(2단계) 화면. 여기서는 아무것도 저장하지 않는다 — 실제 저장은
  // finishReview()가 후기 제출 시 Step1→Step2 순서로 한 번에 보낸다(백엔드 409 가드 보존).
  // C1(QA): AI 정리 없이 메모만 적었으면, 메모를 논의사항 기본값으로 채워 넣어 저장 가능하게 한다
  // (핵심 논의사항/합의 사항/후속 액션 세 칸에 나눠 옮기는 건 다음 화면에서 자유롭게 수정 가능).
  function goToIntake() {
    if (!draft && inputMode === "text" && memo.trim() && !discussion.trim() && !agreements.trim() && !actions.trim()) {
      setDiscussion(memo)
    }
    setMode("intake")
  }

  // 후기(2단계) 최종 제출 — Step1 먼저 저장하고(백엔드 가드: Step2 는 Step1 존재를 전제), 노쇼가
  // 아니면 이어서 Step2(보고서+적합도)까지 저장한다. 실패해도 낙관적으로 완료 처리하지 않는다 —
  // 실패 지점까지는 이미 저장돼 있으니 재시도하면 이어서 저장된다.
  async function finishReview() {
    if (!proceeded || submitting) return
    setSubmitting(true)
    try {
      const input: Step1Input = { proceeded, satisfaction, followUpIntent: followUp }
      const r1 = await api.saveStep1(meetingId, input)
      // 방어적 fallback: 사용자가 불참(상대/본인)을 골랐으면 서버 응답의 isNoshow가 무엇이든
      // 노쇼로 취급한다 — SQL round-trip 버그 같은 것으로 서버가 실수로 false를 돌려줘도,
      // 빈 회의록을 "보고서 없음" 에러로 막는 사고(QA)를 화면단에서 한 번 더 막는다. 화면 상태도
      // 함께 맞춰야 완료 화면이 (노쇼가 아니라) "완료됨" + 빈 보고서로 잘못 그려지지 않는다.
      const chosenNoshow = isNoshow(proceeded)
      if (r1.isNoshow || chosenNoshow) {
        setStored(chosenNoshow ? { ...r1, isNoshow: true } : r1)
        toast.success(t("toast.noshowSaved"))
        setMode("done")
        return
      }
      setStored(r1)
      const report = currentReport()
      if (report.discussion.length + report.agreements.length + report.actions.length === 0) {
        toast.error(t("toast.reportEmpty"))
        setMode("compose") // 보고서를 채울 수 있게 되돌아간다
        return
      }
      const r2 = await api.saveStep2(meetingId, {
        report,
        fitRating: fit,
        fitReason,
        fitReasonTags: fitTags,
        transcript: draft?.transcript,
        transcriptTurns,
        audioS3Key: draft?.audioS3Key,
        finalize: true,
      })
      setStored(r2)
      setMode("done")
      rememberSelectedFile(meetingId, null) // 저장 완료 → 세션에 보관한 선택 파일 정리
      toast.success(t("toast.reportSaved"))
    } catch {
      toast.error(t("toast.saveFailed")) // 실패를 숨기지 않는다 — 화면은 그대로, 재시도 가능
    } finally {
      setSubmitting(false)
    }
  }

  async function runAi(file: File | null) {
    // 텍스트 폴백은 짧아 동기 — 그대로 검수로.
    if (inputMode === "text") {
      if (!memo.trim()) return
      setAiBusy(true)
      try {
        const d = await api.structureText(meetingId, memo)
        applyDraft(d)
        toast.success(t("toast.textDraftDone"))
      } finally {
        setAiBusy(false)
      }
      return
    }

    // 녹음: 비동기 접수 → 폴링. 30분 분량이라 블로킹하지 않고, 완료되면 알림으로 알린다.
    if (!file) return
    setAiBusy(true)
    try {
      const { jobId } = await api.startTranscription(meetingId, file)
      toast.success(t("toast.transcriptionStarted"))
      trackRef.current?.() // 직전 추적이 있으면 인페이지 콜백 분리
      trackRef.current = trackTranscription(
        { client: api, meetingId, jobId, orgId, counterpartOrg },
        {
          onDone: (d) => {
            applyDraft(d)
            setAiBusy(false)
            toast.success(t("toast.transcriptionDraftDone"))
          },
          onError: (m) => {
            setAiBusy(false)
            toast.error(m)
          },
        },
      )
    } catch {
      setAiBusy(false)
      toast.error(t("toast.transcriptionStartFailed"))
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-3xl p-8 text-sm text-muted-foreground">{t("loading")}</div>
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t("loadErrorTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{t("loadErrorDescription")}</span>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <Badge variant="secondary">{counterpartOrg}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {mode === "intake" && t("subtitleIntake")}
          {mode === "compose" && t("subtitleCompose")}
          {mode === "done" && t("subtitleDone")}
        </p>
      </header>

      <StepIndicator mode={mode} />

      {mode === "compose" && (
        <ComposeStep
          meetingId={meetingId}
          inputMode={inputMode}
          setInputMode={setInputMode}
          memo={memo}
          setMemo={setMemo}
          aiBusy={aiBusy}
          runAi={runAi}
          hasDraft={!!draft || !!discussion}
          discussion={discussion}
          setDiscussion={setDiscussion}
          agreements={agreements}
          setAgreements={setAgreements}
          actions={actions}
          setActions={setActions}
          fit={fit}
          setFit={setFit}
          fitReason={fitReason}
          setFitReason={setFitReason}
          fitTags={fitTags}
          transcriptTurns={transcriptTurns}
          counterpartOrg={counterpartOrg}
          onNext={goToIntake}
        />
      )}

      {mode === "intake" && (
        <IntakeStep
          proceeded={proceeded}
          setProceeded={setProceeded}
          satisfaction={satisfaction}
          setSatisfaction={setSatisfaction}
          followUp={followUp}
          setFollowUp={setFollowUp}
          submitting={submitting}
          onSubmit={finishReview}
          onBack={() => setMode("compose")}
        />
      )}

      {mode === "done" && stored && (
        <DoneStep
          stored={stored}
          counterpartOrg={counterpartOrg}
          meetingId={meetingId}
          api={api}
          onExport={async (fmt) => {
            try {
              await api.downloadReport(meetingId, fmt)
            } catch {
              toast.error(t("toast.exportFailed"))
            }
          }}
          onEdit={() => setMode(stored.isNoshow ? "intake" : "compose")}
        />
      )}
    </div>
  )
}

function StepIndicator({ mode }: { mode: Mode }) {
  const t = useTranslations("review.steps")
  // C3(QA): 1.AI 보고서+적합도 → 2.미팅 후기 → 3.완료 순(기존엔 후기가 먼저였다).
  const steps = [
    { key: "compose", label: t("compose") },
    { key: "intake", label: t("intake") },
    { key: "done", label: t("done") },
  ]
  const activeIdx = steps.findIndex((s) => s.key === mode)
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <span
            className={
              i <= activeIdx
                ? "rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground"
                : "rounded-full bg-muted px-2.5 py-1 text-muted-foreground"
            }
          >
            {i + 1}. {s.label}
          </span>
          {i < steps.length - 1 && <span className="text-muted-foreground">→</span>}
        </div>
      ))}
    </div>
  )
}

function IntakeStep(props: {
  proceeded: MeetingProceeded | null
  setProceeded: (v: MeetingProceeded) => void
  satisfaction: number | null
  setSatisfaction: (v: number) => void
  followUp: FollowUpIntent | null
  setFollowUp: (v: FollowUpIntent) => void
  submitting: boolean
  onSubmit: () => void
  onBack: () => void
}) {
  const t = useTranslations("review.intake")
  const tOptions = useTranslations("review.proceededOptions")
  const tFollowUp = useTranslations("review.followUp")
  const tCompose = useTranslations("review.compose")
  const {
    proceeded,
    setProceeded,
    satisfaction,
    setSatisfaction,
    followUp,
    setFollowUp,
    submitting,
    onSubmit,
    onBack,
  } = props
  const noshow = proceeded ? isNoshow(proceeded) : false
  const input: Step1Input = {
    proceeded: proceeded ?? "proceeded",
    satisfaction,
    followUpIntent: followUp,
  }
  const canSubmit = proceeded != null && canSubmitStep1(input)

  return (
    <Card className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Label>{t("proceededQuestion")}</Label>
        <div className="flex flex-wrap gap-2">
          {PROCEEDED_VALUES.map((o) => (
            <Button
              key={o.value}
              variant={proceeded === o.value ? "default" : "outline"}
              size="sm"
              onClick={() => setProceeded(o.value)}
            >
              {tOptions(o.key)}
            </Button>
          ))}
        </div>
      </div>

      {proceeded && !noshow && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <Label>{t("satisfactionLabel")}</Label>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={t("satisfactionAria", { n })}
                  onClick={() => setSatisfaction(n)}
                  className="p-0.5"
                >
                  <Star
                    className={
                      satisfaction != null && n <= satisfaction
                        ? "size-7 fill-amber-400 text-amber-400"
                        : "size-7 text-muted-foreground/40"
                    }
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t("followUpLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              {FOLLOW_UPS.map((f) => (
                <Button
                  key={f}
                  variant={followUp === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFollowUp(f)}
                >
                  {tFollowUp(f)}
                </Button>
              ))}
            </div>
          </div>
        </>
      )}

      {noshow && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>{t("noshowTitle")}</AlertTitle>
          <AlertDescription>
            {t("noshowDescription")}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          {tCompose("back")}
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit || submitting}>
          {noshow ? t("submitNoshow") : t("submitFinish")}
        </Button>
      </div>
    </Card>
  )
}

function ComposeStep(props: {
  meetingId: string
  inputMode: "audio" | "text"
  setInputMode: (v: "audio" | "text") => void
  memo: string
  setMemo: (v: string) => void
  aiBusy: boolean
  runAi: (file: File | null) => void
  hasDraft: boolean
  discussion: string
  setDiscussion: (v: string) => void
  agreements: string
  setAgreements: (v: string) => void
  actions: string
  setActions: (v: string) => void
  fit: FitRating | null
  setFit: (v: FitRating) => void
  fitReason: string
  setFitReason: (v: string) => void
  fitTags: string[]
  transcriptTurns: TranscriptTurn[]
  counterpartOrg: string
  onNext: () => void
}) {
  const t = useTranslations("review.compose")
  const tFit = useTranslations("review.fit")
  const p = props
  // 세션 캐시에서 복원 — 다른 메뉴 갔다 뒤로가기로 돌아와도(소프트 네비) 고른 파일이 유지된다.
  const [file, setFileState] = useState<File | null>(() => recallSelectedFile(p.meetingId))
  function setFile(f: File | null) {
    setFileState(f)
    rememberSelectedFile(p.meetingId, f) // 선택/해제를 캐시에도 반영
  }
  const canRun = p.inputMode === "audio" ? !!file : p.memo.trim().length > 0

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-6">
        <Tabs value={p.inputMode} onValueChange={(v) => p.setInputMode(v as "audio" | "text")}>
          <TabsList className="w-full">
            <TabsTrigger value="audio">
              <Mic className="size-4" /> {t("audioTab")}
            </TabsTrigger>
            <TabsTrigger value="text">
              <FileText className="size-4" /> {t("textTab")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="audio" className="mt-4">
            <AudioDropzone file={file} setFile={setFile} disabled={p.aiBusy} />
          </TabsContent>

          <TabsContent value="text" className="mt-4">
            <div className="flex flex-col gap-2">
              <Label>{t("memoLabel")}</Label>
              <Textarea
                value={p.memo}
                onChange={(e) => p.setMemo(e.target.value)}
                placeholder={t("memoPlaceholder")}
                className="min-h-32"
                disabled={p.aiBusy}
              />
            </div>
          </TabsContent>
        </Tabs>

        <Button
          onClick={() => p.runAi(file)}
          disabled={p.aiBusy || !canRun}
          className="self-start"
        >
          {p.aiBusy ? <Spinner /> : <Sparkles className="size-4" />}
          {p.aiBusy ? t("processing") : t("runAi")}
        </Button>
      </Card>

      {p.aiBusy && !p.hasDraft && <ComposingSkeleton inputMode={p.inputMode} />}

      {/* C1(QA): AI 정리는 보조 수단 — AI를 돌리지 않아도 이 카드에서 바로 직접 입력할 수 있다.
          AI 처리 중에는 스켈레톤과 중복되지 않도록 숨긴다. */}
      {!p.aiBusy && (
        <Card className="flex flex-col gap-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t("reviewHint")}
            </p>
            {p.transcriptTurns.length > 0 && (
              <TranscriptSheet turns={p.transcriptTurns} counterpartOrg={p.counterpartOrg} />
            )}
          </div>
          <ReportField label={t("discussion")} dot="bg-blue-500" value={p.discussion} onChange={p.setDiscussion} />
          <ReportField label={t("agreements")} dot="bg-green-500" value={p.agreements} onChange={p.setAgreements} />
          <ReportField label={t("actions")} dot="bg-amber-500" value={p.actions} onChange={p.setActions} />

          <Separator />

          <div className="flex flex-col gap-2">
            <Label>
              {t("fitLabel")}{" "}
              <span className="text-xs font-normal text-muted-foreground">{t("fitHint")}</span>
            </Label>
            <div className="flex gap-2">
              {FITS.map((f) => (
                <Button
                  key={f}
                  variant={p.fit === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => p.setFit(f)}
                >
                  {tFit(f)}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t("fitReasonLabel")}</Label>
            <Textarea
              value={p.fitReason}
              onChange={(e) => p.setFitReason(e.target.value)}
              className="min-h-20"
            />
            {p.fitTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {p.fitTags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <Alert>
            <Lock />
            <AlertDescription>
              {t("privacyNotice")}
            </AlertDescription>
          </Alert>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={p.onNext} disabled={p.aiBusy}>
          {t("next")}
        </Button>
      </div>
    </div>
  )
}

function AudioDropzone({
  file,
  setFile,
  disabled,
}: {
  file: File | null
  setFile: (f: File | null) => void
  disabled: boolean
}) {
  const t = useTranslations("review.compose")
  const tToast = useTranslations("review.toast")
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function pick(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    // 모바일(iOS 보이스메모·일부 안드로이드)은 오디오 파일도 MIME 타입이 빈 문자열이거나
    // 비표준("application/octet-stream" 등)으로 오는 경우가 많다. accept="audio/*"로 이미
    // 피커를 걸렀으니, 여기선 audio/* · 빈 타입 · 알려진 오디오 확장자면 통과시킨다.
    const isAudio =
      f.type.startsWith("audio/") ||
      f.type === "" ||
      f.type === "application/octet-stream" ||
      /\.(mp3|m4a|wav|aac|ogg|oga|flac|webm|mp4|amr|3gp|caf|aiff?)$/i.test(f.name)
    if (!isAudio) {
      toast.error(tToast("audioOnly"))
      return
    }
    setFile(f)
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    pick(e.dataTransfer.files)
  }

  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <FileAudio className="size-5 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{file.name}</span>
          <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={t("removeFileAria")}
          disabled={disabled}
          onClick={() => setFile(null)}
        >
          <X className="size-4" />
        </Button>
      </div>
    )
  }

  // audio/* 만 두면 일부 모바일(안드로이드)에서 음악 라이브러리만 열려 녹음이 안 보인다.
  // 확장자를 함께 명시해 파일 관리자/보이스메모까지 노출한다. 검증은 pick()가 한 번 더 한다.
  // Chrome MediaRecorder 녹음은 .webm(대개 video/webm)이라 audio/* 로는 picker에서 회색처리됨 → 반드시 포함.
  const AUDIO_ACCEPT =
    "audio/*,video/webm,.webm,.m4a,.mp3,.wav,.aac,.ogg,.oga,.flac,.amr,.caf,.3gp,.mp4,.aif,.aiff"

  // label 로 input 을 감싸 탭하면 네이티브 파일 선택창이 바로 열린다.
  // (button + inputRef.click() 프로그램 클릭은 일부 모바일 브라우저에서 선택창이 안 열림 — F-MY-002 버그)
  return (
    <label
      aria-disabled={disabled}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`block w-full cursor-pointer rounded-lg border border-dashed text-left transition-colors ${
        disabled ? "pointer-events-none opacity-50" : ""
      } ${dragging ? "border-primary bg-primary/5" : "border-input hover:bg-muted/50"}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={AUDIO_ACCEPT}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          pick(e.currentTarget.files)
          e.currentTarget.value = "" // 같은 파일 다시 선택해도 onChange 발화되도록 초기화
        }}
      />
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Upload />
          </EmptyMedia>
          <EmptyTitle>{t("dropzoneTitle")}</EmptyTitle>
          <EmptyDescription>
            {t("dropzoneDescription")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </label>
  )
}

function ComposingSkeleton({ inputMode }: { inputMode: "audio" | "text" }) {
  const t = useTranslations("review.compose")
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {inputMode === "audio" ? t("composingAudio") : t("composingText")}
      </div>
      <Separator />
      {["bg-blue-500", "bg-green-500", "bg-amber-500"].map((dot) => (
        <div key={dot} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className={`size-2.5 rounded-sm ${dot}`} />
            <Skeleton className="h-4 w-28" />
          </div>
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </Card>
  )
}

function ReportField({
  label,
  dot,
  value,
  onChange,
}: {
  label: string
  dot: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="flex items-center gap-2">
        <span className={`size-2.5 rounded-sm ${dot}`} /> {label}
      </Label>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} className="min-h-20" />
    </div>
  )
}

function DoneStep({
  stored,
  counterpartOrg,
  meetingId,
  api,
  onExport,
  onEdit,
}: {
  stored: StoredReview
  counterpartOrg: string
  meetingId: string
  api: ReviewClient
  onExport: (fmt: "pdf" | "docx") => void
  onEdit: () => void
}) {
  const t = useTranslations("review.done")
  const tCompose = useTranslations("review.compose")
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex items-start gap-3 p-6">
        <CheckCircle2 className="mt-0.5 size-6 text-green-600" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {stored.isNoshow
              ? // "불참"은 두 갈래다 — 상대가 안 왔는지, 내가 못 갔는지. isNoshow만 보면 구분이
                // 안 되니 counterpartNoshow로 갈라 서로 다른 라벨을 보여준다(QA: "내가 불참"도
                // 불참으로 기록되되, 어느 쪽 불참인지는 알아볼 수 있어야 한다).
                stored.counterpartNoshow
                ? t("noshowTitle")
                : t("selfNoshowTitle")
              : t("completeTitle")}
          </p>
          <p className="text-sm text-muted-foreground">{t("savedWith", { org: counterpartOrg })}</p>
        </div>
      </Card>

      {!stored.isNoshow && stored.report && (
        <Card className="flex flex-col gap-5 p-6">
          <ReadSection title={tCompose("discussion")} dot="bg-blue-500" items={stored.report.discussion} />
          <ReadSection title={tCompose("agreements")} dot="bg-green-500" items={stored.report.agreements} />
          <ReadSection title={tCompose("actions")} dot="bg-amber-500" items={stored.report.actions} />
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">{t("exportTitle")}</span>
            <Button variant="outline" size="sm" onClick={() => onExport("pdf")}>
              <Download className="size-4" /> PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => onExport("docx")}>
              <Download className="size-4" /> Word(DOCX)
            </Button>
            <span className="text-xs text-muted-foreground">{t("exportPrivacyNote")}</span>
          </div>

          {stored.transcriptTurns.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-wrap items-center gap-3">
                <TranscriptSheet turns={stored.transcriptTurns} counterpartOrg={counterpartOrg} />
                <span className="text-xs text-muted-foreground">
                  {t("transcriptPrivacyNote")}
                </span>
              </div>
            </>
          )}
        </Card>
      )}

      {/* 러브콜 메일(#13) — 확정된 회의록을 재료로 상대 기업에 실제 메일을 보낸다.
          노쇼(상대 불참)면 보낼 대상이 없으니 카드 자체를 띄우지 않는다. */}
      {!stored.isNoshow && <LoveCallMailCard meetingId={meetingId} api={api} />}

      <div className="flex justify-end">
        <Button variant="outline" onClick={onEdit}>
          {t("edit")}
        </Button>
      </div>
    </div>
  )
}

// 전사 원문(화자별) — 읽기전용 사이드 시트. 데스크톱 우측, 모바일 하단(바텀시트). 편집은 3섹션에서만.
function TranscriptSheet({
  turns,
  counterpartOrg,
}: {
  turns: TranscriptTurn[]
  counterpartOrg: string
}) {
  const tt = useTranslations("review.transcript")
  const isMobile = useIsMobile()
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <ScrollText className="size-4" /> {tt("viewButton")}
        </Button>
      </SheetTrigger>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={isMobile ? "max-h-[85svh] sm:max-w-none" : "sm:max-w-md"}
      >
        <SheetHeader>
          <SheetTitle>{tt("title")}</SheetTitle>
          <SheetDescription>
            {tt("aiNote")}
          </SheetDescription>
        </SheetHeader>
        {/* 긴 전사도 시트 밖으로 페이지를 늘리지 않도록 내부 스크롤. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
          {turns.map((turn, i) => {
            const us = turn.who === "us"
            return (
              <div key={i} className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span
                    className={`size-2.5 rounded-full ${us ? "bg-blue-500" : "border border-muted-foreground/40 bg-muted"}`}
                  />
                  {us ? tt("us") : counterpartOrg || tt("counterpartFallback")}
                </span>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{turn.text}</p>
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ReadSection({ title, dot, items }: { title: string; dot: string; items: string[] }) {
  const t = useTranslations("review.done")
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className={`size-2.5 rounded-sm ${dot}`} /> {title}
      </p>
      {items.length > 0 ? (
        <ul className="ml-4 list-disc text-sm text-muted-foreground">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : (
        <p className="ml-4 text-sm text-muted-foreground">{t("emptySection")}</p>
      )}
    </div>
  )
}
