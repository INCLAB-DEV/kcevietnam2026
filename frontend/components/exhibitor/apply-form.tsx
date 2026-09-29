"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileUp,
  ListChecks,
  Lock,
  PartyPopper,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  ChipToggleGroup,
  Field as SharedField,
  NativeSelectControl,
  focusFirstErrorField,
} from "@/components/form/field-controls"
import { EXHIBITOR_STEP_SCHEMAS } from "@/lib/bm/schemas"

import { getExhibitorClient } from "@/lib/bm/exhibitor-client"
import {
  buildRegistrantPrefill,
  type RegistrantInfo,
} from "@/lib/bm/registrant-prefill"
import {
  applySmartFill,
  getSmartFillClient,
  hasRealSmartFillClient,
} from "@/lib/bm/smartfill-client"
import {
  EDITABLE_STEPS,
  PRODUCTS_STEP,
  STEP_META,
  addItem,
  canSubmit,
  cleanProducts,
  completedSteps,
  isProductValid,
  nextStep,
  prevStep,
  removeItem,
  stepPatch,
  updateItem,
  type StepMeta,
} from "@/lib/bm/profile-form-state"
import {
  annualSalesSellerOptionsFor,
  businessFieldOptionsFor,
  buyerCountryOptionsFor,
  contentCategoryOptionsFor,
  employeeRangeOptionsFor,
  languageOptionsFor,
  orgTypeOptionsFor,
  productPriceRangeOptionsFor,
  type FieldLocale,
  type Option,
} from "@/lib/bm/fields"
import type {
  ApplicationStatus,
  EditableStep,
  ExhibitorProfileDraft,
  Lang,
  Product,
  Step,
} from "@/lib/bm/types"

// 입력 칸의 출처 — 명단(등록) 자동 프리필("roster") / Smart Fill AI 추출("ai"). 사용자가 손대면 해제.
type Provenance = "roster" | "ai"
type SourceMap = Record<string, Provenance | undefined>

// next-intl useLocale()은 SUPPORTED_LOCALES(ko|en) 밖 값을 주지 않지만 타입은 string — fields.ts의
// FieldLocale로 좁힌다(이슈 #7 — 선택지 값 영문화).
function toFieldLocale(locale: string): FieldLocale {
  return locale === "en" ? "en" : "ko"
}

// ── 작은 재사용 필드 ───────────────────────────────────────────────────────────
// 섹션 제목(h2)용 — 필드 라벨의 필수 별은 공용 Field가 그리므로 여기선 섹션에만 쓴다.
function RequiredMark() {
  const t = useTranslations("applyExhibitor")
  return (
    <span className="text-destructive" aria-label={t("requiredAria")}>
      *
    </span>
  )
}

function SourceBadge({ kind }: { kind: Provenance }) {
  const t = useTranslations("applyExhibitor.sourceBadge")
  return kind === "roster" ? (
    <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
      <ListChecks className="size-3" /> {t("roster")}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 border-primary/40 text-[11px] font-normal text-primary"
    >
      <Sparkles className="size-3" /> {t("ai")}
    </Badge>
  )
}

// 공용 부품(components/form/field-controls) 위의 얇은 어댑터들(2026-07-06 공용화).
// 마크업/스타일은 공용이 갖고, 이 폼 고유 시맨틱만 여기 남긴다:
//   - Field: 출처 배지(등록정보/AI 초안) → 공용 Field의 badge 슬롯
//   - NativeSelect: undefined 기반 값 + placeholder로 되돌리기 허용(공용은 "" 기반)
//   - ChipMultiSelect: selected가 undefined일 수 있는 draft 특성 흡수
function Field({
  label,
  required,
  error,
  source,
  hint,
  children,
}: {
  label: string
  required?: boolean
  error?: boolean
  source?: Provenance
  hint?: string
  children: React.ReactNode
}) {
  return (
    <SharedField
      label={label}
      required={required}
      error={error}
      hint={hint}
      badge={source ? <SourceBadge kind={source} /> : undefined}
    >
      {children}
    </SharedField>
  )
}

function NativeSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: T | undefined
  onChange: (value: T | undefined) => void
  options: Option<T>[]
  placeholder?: string
}) {
  const t = useTranslations("applyExhibitor")
  return (
    <NativeSelectControl
      value={value ?? ""}
      options={options}
      onChange={(v) => onChange(v === "" ? undefined : v)}
      placeholder={placeholder ?? t("selectPlaceholder")}
      disabledPlaceholder={false}
    />
  )
}

function ChipMultiSelect<T extends string>({
  options,
  selected,
  onToggle,
}: {
  options: Option<T>[]
  selected: T[] | undefined
  onToggle: (code: T) => void
}) {
  return (
    <ChipToggleGroup options={options} values={selected} onToggle={onToggle} />
  )
}

// ── Smart Fill 배너(문서 업로드 → AI 추출 프리필) ───────────────────────────────
function SmartFillBanner({
  busy,
  onUpload,
}: {
  busy: boolean
  onUpload: (file: File) => void
}) {
  const t = useTranslations("applyExhibitor.smartFill")
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Card className="flex flex-col gap-3 border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="size-4.5 text-primary" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>
      <div className="shrink-0">
        {/* real Chrome은 accept에 없는 확장자를 picker에서 회색처리(선택 불가)한다.
            한글(.hwp) 등 흔한 문서 포맷을 포함해 "선택이 안 되는" 문제를 막는다. */}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.hwp,.hwpx,.txt,.rtf,.odt,.odp,.key,.pages"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUpload(file)
            e.target.value = "" // 같은 파일 재선택 허용
          }}
        />
        <Button
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="w-full sm:w-auto"
        >
          {busy ? (
            <>
              <Spinner className="size-4" /> {t("analyzing")}
            </>
          ) : (
            <>
              <FileUp className="size-4" /> {t("uploadCta")}
            </>
          )}
        </Button>
      </div>
    </Card>
  )
}

// ── 메인 폼 ────────────────────────────────────────────────────────────────────
const EMPTY_ERRORS: Set<string> = new Set()

// 현재 단계 스키마의 미충족 필드 키(Zod 이슈 경로) — 정본은 lib/bm/schemas.ts.
function missingOf(
  step: EditableStep,
  draft: ExhibitorProfileDraft
): Set<string> {
  const result = EXHIBITOR_STEP_SCHEMAS[step].safeParse(draft)
  if (result.success) return EMPTY_ERRORS
  return new Set(result.error.issues.map((issue) => String(issue.path[0])))
}

// 1단계 저장 PATCH에서 뺄 키 — 부스(운영자 배정 스냅샷)는 1단계 UI에서 편집하지 않으므로,
// 클라 드래프트의 stale 값으로 서버 값을 덮어쓰지 않게 막는다(STEP_META[0].fields엔 들어있지만
// 회사 정보 편집 전환과 무관 — 회귀·권한 이슈 방지). 담당자(attendees)는 2026-09-12부터 1단계에서
// 직접 추가/수정/삭제할 수 있어(가입정보 프리필 포함) 더 이상 제외하지 않는다.
const STEP1_SAVE_EXCLUDE_KEYS: (keyof ExhibitorProfileDraft)[] = [
  "hall",
  "pavilion",
  "boothLocation",
  "boothType",
  "boothCount",
]

function omitKeys<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = { ...obj }
  for (const key of keys) delete out[key]
  return out
}

export function ExhibitorApplyForm({
  orgEventRoleId,
  initialStep,
  registrant,
  canEdit = true,
  reviewNote,
  applicationStatus = "registered",
  isReal = false,
}: {
  orgEventRoleId: string
  initialStep: Step
  registrant?: RegistrantInfo
  canEdit?: boolean // 작성/수정 가능 — 신청기간 중 AND status ∈ {registered, changes_requested}(ADR-0002)
  reviewNote?: string // changes_requested 시 운영자 보완 요청 메모(review_note) — 상단 배너로 노출
  // 세션 application_status(권위) — 읽기전용 판단의 단일 소스. mock STORE의 status가 아니라 이걸 본다
  // (dev ?status는 세션 쿠키에만 반영돼 STORE와 어긋나므로). 실연동 시 Cognito/FastAPI status.
  applicationStatus?: ApplicationStatus
  // 실 로그인 세션이면 true — getExhibitorClient(isReal)로 실 백엔드(FastAPI, BFF 경유)를 쓴다.
  // 기본값 false(미전달 시 기존 mock 동작 100% 보존, exhibitor-profile-hub와 동일 패턴).
  isReal?: boolean
}) {
  const t = useTranslations("applyExhibitor")
  const router = useRouter()
  const api = useMemo(() => getExhibitorClient(isReal), [isReal])
  const smartfill = useMemo(() => getSmartFillClient(), [])
  // 폼 상태 컨테이너 = RHF(2026-07-06 전환, AD-001과 동일 깊이). draft는 form이 들고,
  // 스텝 컴포넌트 계약(draft/source/patch/toggleIn)은 유지 — 필드 배선을 patch에 묶어둔 이유는
  // 출처 배지(source map) 해제가 입력과 원자적으로 일어나야 해서(필드 단위 useController 전환은
  // 필드별 에러 UX가 기획에서 확정될 때 rhf-fields 래퍼로).
  const form = useForm<ExhibitorProfileDraft>({ defaultValues: {} })
  // RHF watch()는 React Compiler가 메모이제이션을 스킵한다(구독 기반 API) — 의도된 동작.
  // eslint-disable-next-line react-hooks/incompatible-library
  const draft = form.watch()
  const [source, setSource] = useState<SourceMap>({})
  const [step, setStep] = useState<Step>(initialStep)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [smartBusy, setSmartBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  // [다음] 시도 후에만 필수 오류 표시(자유 이동·부분저장 계약은 유지 — 레일 점프는 검사 안 함).
  const [showErrors, setShowErrors] = useState(false)

  // draft 부분 병합 — RHF setValue로 키별 반영(전체 reset과 달리 다른 필드의 미저장 입력 보존).
  function mergeDraft(update: Partial<ExhibitorProfileDraft>) {
    for (const key of Object.keys(update) as (keyof ExhibitorProfileDraft)[]) {
      form.setValue(key as never, update[key] as never, { shouldDirty: true })
    }
  }

  // 이어쓰기: 저장된 프로필을 드래프트로 적재. 비어 있으면 행사 등록 정보로 기본정보 자동 프리필(빈 칸만).
  useEffect(() => {
    let alive = true
    api
      .getProfile(orgEventRoleId)
      .then((profile) => {
        if (!alive) return
        if (
          applicationStatus === "submitted" ||
          applicationStatus === "approved" ||
          applicationStatus === "rejected"
        ) {
          // 제출 후 잠금 — submitted/approved/rejected는 읽기전용 ProfileView로(신청서 보기). 편집 진입 차단.
          // 판단은 세션 status(prop) 단일 소스 — mock STORE의 status가 아니라(dev ?status는 쿠키에만 반영).
          // 수정은 운영이 changes_requested로 돌려보낼 때만 다시 열린다. canEdit=false라 ProfileView에 수정 버튼 없음.
          form.reset(profile)
          setDone(true)
          setShowProfile(true)
          return
        }
        if (registrant) {
          // 회원가입/로스터가 아는 기본정보로 빈 칸만 채운다(이어쓰기 저장값 보존). 회사 정보 블록은
          // 이제 편집 가능이라 이 프리필도 수정 대상 — 출처 배지는 미부착(회사명·부스만 진짜 잠김이라
          // "등록정보에서 가져옴" 표식의 실익이 작음, 필요해지면 여기서 setSource로 추가).
          const { patch, sources } = buildRegistrantPrefill(profile, registrant)
          form.reset(sources.length > 0 ? { ...profile, ...patch } : profile)
        } else {
          form.reset(profile)
        }
      })
      .catch(() => toast.error(t("loadError")))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // form은 안정 참조(useForm 반환) — 의존성에서 제외해도 재실행 조건이 달라지지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, orgEventRoleId, registrant, applicationStatus])

  // 사용자 입력은 해당 키의 출처 배지를 해제한다(등록정보/AI 초안 → 사용자 확정).
  function clearSource(keys: string[]) {
    setSource((s) => {
      const next = { ...s }
      for (const k of keys) delete next[k]
      return next
    })
  }

  function patch(update: Partial<ExhibitorProfileDraft>) {
    mergeDraft(update)
    clearSource(Object.keys(update))
  }

  function toggleIn<T extends string>(
    key: keyof ExhibitorProfileDraft,
    code: T
  ) {
    const list = (form.getValues(key as never) as T[] | undefined) ?? []
    const next = list.includes(code)
      ? list.filter((c) => c !== code)
      : [...list, code]
    form.setValue(key as never, next as never, { shouldDirty: true })
    clearSource([key as string])
  }

  // Smart Fill: 문서 업로드 → 추출 → 빈 칸만 채우고 'AI 초안' 표시(D9 검토·수정 전제).
  async function handleSmartFill(file: File) {
    setSmartBusy(true)
    try {
      const extracted = await smartfill.extract(file)
      const { patch: p, sources } = applySmartFill(form.getValues(), extracted)
      if (sources.length === 0) {
        toast.info(t("smartFill.noNewFields"))
        return
      }
      mergeDraft(p)
      setSource((s) => ({
        ...s,
        ...Object.fromEntries(sources.map((k) => [k as string, "ai" as const])),
      }))
      toast.success(t("smartFill.success"))
    } catch {
      toast.error(t("smartFill.error"))
    } finally {
      setSmartBusy(false)
    }
  }

  // 현재 단계 부분 저장(서버 PATCH). 5단계(요약)는 저장할 게 없다.
  async function saveCurrentStep(): Promise<boolean> {
    if (step === 5) return true
    const editable = step as EditableStep
    const values = form.getValues()
    const payload =
      editable === PRODUCTS_STEP
        ? {
            ...stepPatch(values, editable),
            products: cleanProducts(values.products),
          }
        : editable === 1
          ? omitKeys(stepPatch(values, editable), STEP1_SAVE_EXCLUDE_KEYS)
          : stepPatch(values, editable)
    setSaving(true)
    try {
      const saved = await api.saveStep(orgEventRoleId, editable, payload)
      // 저장된 단계의 필드만 서버 응답에서 되받는다. 다른 단계의 아직 저장 안 된 클라 입력
      // (프리필·Smart Fill 초안)은 보존 — 전체 교체하면 그 데이터가 날아간다.
      mergeDraft(stepPatch(saved, editable))
      return true
    } catch {
      toast.error(t("saveError"))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function goToStep(target: Step) {
    if (target === step) return
    if (await saveCurrentStep()) {
      setShowErrors(false)
      setStep(target)
    }
  }

  // [다음]은 현재 단계의 필수를 검사한다(2026-07-06 결정) — 미충족이면 이동·저장을 막고
  // 필드 에러 표시 + 첫 오류 입력으로 포커스. 1단계는 읽기 전용(로스터 소관)이라 검사에서
  // 제외 — 로스터가 비어 있어도 사용자가 폼에 갇히지 않게. 레일 점프·저장하고 나가기는
  // 기존 자유 이동/부분저장 계약 그대로(검사 없음).
  async function handleNext() {
    if (step !== 1 && step !== 5) {
      const result = EXHIBITOR_STEP_SCHEMAS[step as EditableStep].safeParse(
        form.getValues()
      )
      if (!result.success) {
        setShowErrors(true)
        // 오류 마크가 렌더된 뒤 첫 오류 입력으로 포커스(폼 공통 규칙).
        setTimeout(() => focusFirstErrorField(), 0)
        return
      }
    }
    if (await saveCurrentStep()) {
      setShowErrors(false)
      setStep(nextStep(step))
    }
  }

  // 저장하고 나가기 — 폼은 '저장'만 한다(제출 분리, 2026-06-30 결정). 각 단계는 이동 시 이미 자동 저장되고,
  // 마지막에 현재 단계를 한 번 더 저장한 뒤 입장 전 랜딩(/welcome)으로. 실제 제출(submitted 전환)은 거기서.
  async function handleSaveExit() {
    if (!(await saveCurrentStep())) return
    router.push("/welcome")
  }

  if (loading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (done) {
    // 확인을 누르면 방금 신청한 프로필을 읽기 전용으로 조회한다(저장한 내용 확인).
    // 신청기간이면 거기서 '수정하기'로 폼에 다시 진입해 고칠 수 있다(canEdit).
    if (showProfile)
      return (
        <ProfileView
          draft={draft}
          canEdit={canEdit}
          onEdit={() => {
            setShowProfile(false)
            setDone(false)
            setStep(1)
          }}
          onBack={() => router.push("/welcome")}
        />
      )
    return <CompletionView onConfirm={() => setShowProfile(true)} />
  }

  const completed = completedSteps(draft)
  const submittable = canSubmit(draft)
  // 오류는 [다음] 시도 후에만 표시 — 입력할 때마다 watch() 리렌더로 재판정돼 실시간으로 사라진다.
  const errors =
    showErrors && step !== 1 && step !== 5
      ? missingOf(step as EditableStep, draft)
      : EMPTY_ERRORS
  // Smart Fill 은 회사소개(2)·전시품목(3)을 채우므로 그 단계에서만 노출 — 단, 실 추출 백엔드가
  // 붙어 있을 때만(hasRealSmartFillClient). prod는 아직 이 게이트가 항상 false라 배너 자체가 뜨지
  // 않는다 — mock 데모 추출값이 실사용자 신청서에 저장되는 사고를 막는다(2026-09-10).
  const showSmartFill = (step === 2 || step === 3) && hasRealSmartFillClient()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("header.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("header.descriptionPrefix")}{" "}
          <span className="text-destructive">*</span>{" "}
          {t("header.descriptionSuffix")}
        </p>
      </header>

      {/* 보완 요청(changes_requested) — 운영자가 돌려보낸 사유. 반영 후 재제출하면 검토 대기로 복귀. */}
      {reviewNote ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
          <p className="text-sm font-semibold text-amber-800">
            {t("reviewNoteBanner")}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-700">
            {reviewNote}
          </p>
        </div>
      ) : null}

      <div data-tour="apply-steps">
        <StepRail step={step} completed={completed} onJump={goToStep} />
      </div>

      {showSmartFill ? (
        <SmartFillBanner busy={smartBusy} onUpload={handleSmartFill} />
      ) : null}

      <div className="flex flex-col gap-5" data-tour="apply-form">
        {step === 1 && (
          <Step1Basic draft={draft} source={source} patch={patch} />
        )}
        {step === 2 && (
          <Step2Intro
            draft={draft}
            source={source}
            patch={patch}
            toggleIn={toggleIn}
            errors={errors}
          />
        )}
        {step === 3 && (
          <Step3Products
            draft={draft}
            source={source}
            patch={patch}
            toggleIn={toggleIn}
            errors={errors}
          />
        )}
        {/* 4단계(타겟)는 필수 게이트가 없어 errors를 받지 않는다(자체 props). */}
        {step === 4 && <Step4Target draft={draft} toggleIn={toggleIn} />}
        {step === 5 && (
          <Step5Summary draft={draft} completed={completed} onJump={goToStep} />
        )}
      </div>

      <div className="flex items-center justify-between" data-tour="apply-nav">
        {/* 첫 단계엔 이전 버튼 미노출(빈 자리로 다음 버튼 우측 정렬 유지). */}
        {step > 1 ? (
          <Button
            variant="outline"
            onClick={() => {
              setShowErrors(false)
              setStep(prevStep(step))
            }}
            disabled={saving}
          >
            <ChevronLeft className="size-4" /> {t("prev")}
          </Button>
        ) : (
          <div />
        )}

        <div className="flex items-center gap-2">
          {saving ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> {t("saving")}
            </span>
          ) : null}
          {step < 5 ? (
            <Button onClick={handleNext} disabled={saving}>
              {t("next")} <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={handleSaveExit} disabled={saving}>
              {t("saveExit")}
            </Button>
          )}
        </div>
      </div>
      {step === 5 ? (
        <p className="text-right text-xs text-muted-foreground">
          {submittable ? t("footerSubmittable") : t("footerIncomplete")}
        </p>
      ) : null}
    </div>
  )
}

// ── 단계 레일 ──────────────────────────────────────────────────────────────────
function StepRail({
  step,
  completed,
  onJump,
}: {
  step: Step
  completed: EditableStep[]
  onJump: (target: Step) => void
}) {
  const t = useTranslations("applyExhibitor")
  const done = new Set<number>(completed)
  return (
    <ol className="flex flex-wrap gap-2">
      {STEP_META.map((meta: StepMeta) => {
        const active = meta.step === step
        const isComplete = done.has(meta.step)
        return (
          <li key={meta.step}>
            <button
              type="button"
              onClick={() => onJump(meta.step)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                active
                  ? "border-primary bg-primary/5 font-medium"
                  : "border-input hover:bg-accent"
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-xs",
                  isComplete
                    ? "bg-primary text-primary-foreground"
                    : active
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {isComplete ? <Check className="size-3" /> : meta.step}
              </span>
              {t(STEP_TITLE_KEYS[meta.step - 1])}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// STEP_META(lib/bm/profile-form-state.ts)의 title은 정렬·필드매핑용 내부 식별자로만 쓰고,
// 화면 표시는 messages/{ko,en}.json의 applyExhibitor 키로 조립한다(1~4=stepN.title, 5=stepDone).
const STEP_TITLE_KEYS = [
  "step1.title",
  "step2.title",
  "step3.title",
  "step4.title",
  "stepDone",
] as const

type StepProps = {
  draft: ExhibitorProfileDraft
  source: SourceMap
  patch: (u: Partial<ExhibitorProfileDraft>) => void
  toggleIn: <T extends string>(
    key: keyof ExhibitorProfileDraft,
    code: T
  ) => void
  // [다음] 시도에서 미충족으로 판정된 필드 키(Zod 이슈 경로). 입력하면 실시간 해제(파생 상태).
  errors: Set<string>
}

// ── 단계 1: 기본정보(회사명·부스는 회원가입/운영자 스냅샷 — 읽기 전용, 나머지는 편집 가능) ───────
function ReadOnlyField({
  label,
  value,
  fallback,
}: {
  label: string
  value?: string | number
  fallback?: string
}) {
  const t = useTranslations("applyExhibitor")
  const has = value !== undefined && value !== null && `${value}`.trim() !== ""
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {has ? (
        <span className="text-sm">{value}</span>
      ) : (
        <span className="text-sm text-muted-foreground">
          {fallback ?? t("fallback")}
        </span>
      )}
    </div>
  )
}

function ReadOnlyGroup({
  title,
  hint,
  children,
}: {
  title: string
  // 이 그룹 전체가 왜 편집 불가인지 설명하는 보조문구(선택) — 예: 부스 정보(주최측 배정).
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid gap-4 rounded-md border border-input bg-muted/30 p-4 sm:grid-cols-2">
        {children}
      </div>
    </div>
  )
}

// draft만 받으면(ProfileView) 읽기 전용, patch까지 받으면(작성 폼) "회사 정보" 블록이 입력 가능해진다
// (2026-09-09 — 셀프가입 참가사가 사업자등록번호·대표자·연락처·주소를 채울 데가 없던 문제 해소).
// 회사명(국/영)·부스 정보는 회원가입/운영자 소관 스냅샷이라 두 모드 모두 읽기 전용으로 남긴다.
function Step1Basic({
  draft,
  source,
  patch,
}: {
  draft: ExhibitorProfileDraft
  source?: SourceMap
  patch?: (u: Partial<ExhibitorProfileDraft>) => void
}) {
  const t = useTranslations("applyExhibitor.step1")
  const attendees = draft.attendees ?? []
  const booth = draft.boothLocation
  const editable = Boolean(patch)
  return (
    <>
      <SectionTitle title={t("title")} subtitle={t("subtitle")} />
      <Alert>
        <Lock className="size-4" />
        <AlertTitle>{t("lockedTitle")}</AlertTitle>
        <AlertDescription>{t("lockedDescription")}</AlertDescription>
      </Alert>

      <ReadOnlyGroup title={t("companyInfoTitle")}>
        <ReadOnlyField label={t("nameKo")} value={draft.organizationNameKo} />
        <ReadOnlyField label={t("nameEn")} value={draft.organizationNameEn} />
        {editable ? (
          <>
            <Field label={t("businessRegNo")} source={source?.businessRegNo}>
              <Input
                value={draft.businessRegNo ?? ""}
                onChange={(e) => patch!({ businessRegNo: e.target.value })}
              />
            </Field>
            <Field label={t("companyEmail")} source={source?.companyEmail}>
              <Input
                type="email"
                value={draft.companyEmail ?? ""}
                onChange={(e) => patch!({ companyEmail: e.target.value })}
              />
            </Field>
            <Field label={t("repNameKo")} source={source?.representativeNameKo}>
              <Input
                value={draft.representativeNameKo ?? ""}
                onChange={(e) =>
                  patch!({ representativeNameKo: e.target.value })
                }
              />
            </Field>
            <Field label={t("repNameEn")} source={source?.representativeNameEn}>
              <Input
                value={draft.representativeNameEn ?? ""}
                onChange={(e) =>
                  patch!({ representativeNameEn: e.target.value })
                }
              />
            </Field>
            <Field label={t("mainTel")} source={source?.mainTel}>
              <Input
                value={draft.mainTel ?? ""}
                onChange={(e) => patch!({ mainTel: e.target.value })}
              />
            </Field>
            <Field label={t("fax")} source={source?.fax}>
              <Input
                value={draft.fax ?? ""}
                onChange={(e) => patch!({ fax: e.target.value })}
              />
            </Field>
            <Field label={t("businessType")} source={source?.businessType}>
              <Input
                value={draft.businessType ?? ""}
                onChange={(e) => patch!({ businessType: e.target.value })}
              />
            </Field>
            <Field label={t("businessItem")} source={source?.businessItem}>
              <Input
                value={draft.businessItem ?? ""}
                onChange={(e) => patch!({ businessItem: e.target.value })}
              />
            </Field>
            <Field label={t("zipCode")} source={source?.zipCode}>
              <Input
                value={draft.zipCode ?? ""}
                onChange={(e) => patch!({ zipCode: e.target.value })}
              />
            </Field>
            <div />
            <div className="sm:col-span-2">
              <Field label={t("addressKo")} source={source?.addressKo}>
                <Input
                  value={draft.addressKo ?? ""}
                  onChange={(e) => patch!({ addressKo: e.target.value })}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t("addressDetail")} source={source?.addressDetail}>
                <Input
                  value={draft.addressDetail ?? ""}
                  onChange={(e) => patch!({ addressDetail: e.target.value })}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t("addressEn")} source={source?.addressEn}>
                <Input
                  value={draft.addressEn ?? ""}
                  onChange={(e) => patch!({ addressEn: e.target.value })}
                />
              </Field>
            </div>
          </>
        ) : (
          <>
            <ReadOnlyField
              label={t("businessRegNo")}
              value={draft.businessRegNo}
            />
            <ReadOnlyField label={t("companyEmail")} value={draft.companyEmail} />
            <ReadOnlyField
              label={t("repNameKo")}
              value={draft.representativeNameKo}
            />
            <ReadOnlyField
              label={t("repNameEn")}
              value={draft.representativeNameEn}
            />
            <ReadOnlyField label={t("mainTel")} value={draft.mainTel} />
            <ReadOnlyField label={t("fax")} value={draft.fax} />
            <ReadOnlyField label={t("businessType")} value={draft.businessType} />
            <ReadOnlyField label={t("businessItem")} value={draft.businessItem} />
            <ReadOnlyField label={t("zipCode")} value={draft.zipCode} />
            <div />
            <div className="sm:col-span-2">
              <ReadOnlyField
                label={t("addressKo")}
                value={[draft.addressKo, draft.addressDetail]
                  .filter(Boolean)
                  .join(" ")}
              />
            </div>
            <div className="sm:col-span-2">
              <ReadOnlyField label={t("addressEn")} value={draft.addressEn} />
            </div>
          </>
        )}
      </ReadOnlyGroup>

      <ReadOnlyGroup title={t("boothInfoTitle")} hint={t("boothInfoHint")}>
        <ReadOnlyField
          label={t("hall")}
          value={draft.hall ? t("hallSuffix", { n: draft.hall }) : undefined}
        />
        <ReadOnlyField label={t("pavilion")} value={draft.pavilion} />
        <ReadOnlyField label={t("boothType")} value={draft.boothType} />
        <ReadOnlyField
          label={t("boothCount")}
          value={
            draft.boothCount != null
              ? t("boothCountSuffix", { n: draft.boothCount })
              : undefined
          }
        />
        <div className="sm:col-span-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">
              {t("boothLocation")}
            </span>
            {booth && booth.trim() ? (
              <span className="text-sm">{booth}</span>
            ) : (
              <span>
                <Badge variant="secondary" className="font-normal">
                  {t("unassigned")}
                </Badge>
              </span>
            )}
          </div>
        </div>
      </ReadOnlyGroup>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">
          {t("attendeesTitle")}
        </h3>
        {attendees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noAttendees")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {attendees.map((a, i) =>
              editable ? (
                <Card key={i} className="gap-3 p-4">
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary">
                      {t("attendeeLabel", { n: i + 1 })}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        patch!({ attendees: removeItem(attendees, i) })
                      }
                      aria-label={t("deleteAttendeeAria", { n: i + 1 })}
                    >
                      <Trash2 className="size-4" /> {t("deleteAttendee")}
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("attendeeNameKo")}>
                      <Input
                        value={a.firstNameKo ?? ""}
                        onChange={(e) =>
                          patch!({
                            attendees: updateItem(attendees, i, {
                              firstNameKo: e.target.value,
                            }),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("attendeeNameEn")}>
                      <Input
                        value={a.firstNameEn ?? ""}
                        onChange={(e) =>
                          patch!({
                            attendees: updateItem(attendees, i, {
                              firstNameEn: e.target.value,
                            }),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("attendeeTitle")}>
                      <Input
                        value={a.titleKo ?? ""}
                        onChange={(e) =>
                          patch!({
                            attendees: updateItem(attendees, i, {
                              titleKo: e.target.value,
                            }),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("attendeeEmail")}>
                      <Input
                        type="email"
                        value={a.email ?? ""}
                        onChange={(e) =>
                          patch!({
                            attendees: updateItem(attendees, i, {
                              email: e.target.value,
                            }),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("attendeeMobile")}>
                      <Input
                        value={a.mobile ?? ""}
                        onChange={(e) =>
                          patch!({
                            attendees: updateItem(attendees, i, {
                              mobile: e.target.value,
                            }),
                          })
                        }
                      />
                    </Field>
                  </div>
                </Card>
              ) : (
                <div
                  key={i}
                  className="grid gap-4 rounded-md border border-input bg-muted/30 p-4 sm:grid-cols-2"
                >
                  <ReadOnlyField
                    label={t("attendeeNameKo")}
                    value={a.firstNameKo}
                  />
                  <ReadOnlyField
                    label={t("attendeeNameEn")}
                    value={a.firstNameEn}
                  />
                  <ReadOnlyField label={t("attendeeTitle")} value={a.titleKo} />
                  <ReadOnlyField label={t("attendeeEmail")} value={a.email} />
                  <ReadOnlyField label={t("attendeeMobile")} value={a.mobile} />
                </div>
              )
            )}
          </div>
        )}
        {editable ? (
          <Button
            variant="outline"
            onClick={() =>
              patch!({ attendees: addItem(attendees, {}) })
            }
            className="self-start"
          >
            <Plus className="size-4" /> {t("addAttendee")}
          </Button>
        ) : null}
      </div>
    </>
  )
}

// ── 단계 2: 회사소개(소개 + 보강정보) ──────────────────────────────────────────
function Step2Intro({ draft, source, patch, toggleIn, errors }: StepProps) {
  const t = useTranslations("applyExhibitor.step2")
  const locale = toFieldLocale(useLocale())
  return (
    <>
      <SectionTitle title={t("title")} subtitle={t("subtitle")} />
      <Field
        label={t("introKo")}
        required
        error={errors.has("introKo")}
        source={source.introKo}
        hint={t("introKoHint")}
      >
        <Textarea
          value={draft.introKo ?? ""}
          onChange={(e) => patch({ introKo: e.target.value })}
          rows={5}
          aria-invalid={errors.has("introKo") || undefined}
          placeholder={t("introKoPlaceholder")}
        />
      </Field>
      <Field
        label={t("introEn")}
        required
        error={errors.has("introEn")}
        source={source.introEn}
        hint={t("introEnHint")}
      >
        <Textarea
          value={draft.introEn ?? ""}
          onChange={(e) => patch({ introEn: e.target.value })}
          rows={5}
          aria-invalid={errors.has("introEn") || undefined}
        />
      </Field>
      <Separator />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("website")} hint={t("websiteHint")}>
          <Input
            value={draft.website ?? ""}
            onChange={(e) => patch({ website: e.target.value })}
            placeholder="https://"
          />
        </Field>
        <div />
        <Field label={t("annualSales")} hint={t("annualSalesHint")}>
          <NativeSelect
            value={draft.annualSalesRange}
            onChange={(v) => patch({ annualSalesRange: v })}
            options={annualSalesSellerOptionsFor(locale)}
          />
        </Field>
        <Field label={t("employeeRange")} hint={t("employeeRangeHint")}>
          <NativeSelect
            value={draft.employeeRange}
            onChange={(v) => patch({ employeeRange: v })}
            options={employeeRangeOptionsFor(locale)}
          />
        </Field>
      </div>
      <Field label={t("languages")} hint={t("languagesHint")}>
        <ChipMultiSelect
          options={languageOptionsFor(locale)}
          selected={draft.availableLanguages}
          onToggle={(c) => toggleIn<Lang>("availableLanguages", c)}
        />
      </Field>
    </>
  )
}

// ── 단계 3: 전시품목 ───────────────────────────────────────────────────────────
function Step3Products({ draft, source, patch, toggleIn, errors }: StepProps) {
  const t = useTranslations("applyExhibitor.step3")
  const locale = toFieldLocale(useLocale())
  const products = draft.products ?? []
  // 스키마 이슈 경로는 "products" 하나(집계) — 어떤 행·필드가 미충족인지는 여기서 되짚어
  // 행별 필수 필드에 표시한다. 유효 행(국문명 있음) 0개면 목록 자체가 오류 앵커.
  const productsError = errors.has("products")
  const validRows = cleanProducts(products)
  const noValidProduct = productsError && validRows.length === 0
  function rowFieldError(p: Product, filled: boolean): boolean {
    return productsError && isProductValid(p) && !filled
  }
  function addProduct() {
    patch({ products: addItem<Product>(products, { nameKo: "" }) })
  }
  function removeProduct(i: number) {
    patch({ products: removeItem(products, i) })
  }
  function updateProduct(i: number, p: Partial<Product>) {
    patch({ products: updateItem(products, i, p) })
  }
  return (
    <>
      <SectionTitle title={t("title")} subtitle={t("subtitle")} />
      <Field
        label={t("categories")}
        required
        error={errors.has("exhibitionCategories")}
        source={source.exhibitionCategories}
        hint={t("categoriesHint")}
      >
        <ChipMultiSelect
          options={businessFieldOptionsFor(locale)}
          selected={draft.exhibitionCategories}
          onToggle={(c) => toggleIn("exhibitionCategories", c)}
        />
      </Field>

      <Field
        label={t("contentCategory")}
        source={source.contentCategory}
        hint={t("contentCategoryHint")}
      >
        <NativeSelect
          value={draft.contentCategory}
          onChange={(v) => patch({ contentCategory: v })}
          options={contentCategoryOptionsFor(locale)}
        />
      </Field>

      <Separator />
      <div className="flex items-center justify-between gap-2">
        <SectionTitle
          title={t("productsTitle")}
          subtitle={t("productsSubtitle")}
        />
        {source.products ? <SourceBadge kind={source.products} /> : null}
      </div>
      {/* 유효 제품 0개 오류 — 목록을 앵커(data-field-error)로 삼아 포커스가 [제품 추가]로 간다. */}
      <div
        className="flex flex-col gap-3"
        data-field-error={noValidProduct ? "" : undefined}
      >
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProducts")}</p>
        ) : null}
        {noValidProduct ? (
          <p className="text-xs text-destructive">{t("noValidProduct")}</p>
        ) : null}
        {products.map((p, i) => (
          <Card key={i} className="gap-3 p-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary">
                {t("productLabel", { n: i + 1 })}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeProduct(i)}
                aria-label={t("deleteAria", { n: i + 1 })}
              >
                <Trash2 className="size-4" /> {t("delete")}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("nameKo")} required>
                <Input
                  value={p.nameKo}
                  onChange={(e) => updateProduct(i, { nameKo: e.target.value })}
                  placeholder={t("nameKoPlaceholder")}
                />
              </Field>
              <Field
                label={t("nameEn")}
                required
                error={rowFieldError(p, Boolean(p.nameEn?.trim()))}
              >
                <Input
                  value={p.nameEn ?? ""}
                  onChange={(e) => updateProduct(i, { nameEn: e.target.value })}
                  aria-invalid={
                    rowFieldError(p, Boolean(p.nameEn?.trim())) || undefined
                  }
                />
              </Field>
              <Field
                label={t("category")}
                required
                error={rowFieldError(p, p.businessField != null)}
                hint={t("categoryHint")}
              >
                <NativeSelect
                  value={p.businessField}
                  onChange={(v) => updateProduct(i, { businessField: v })}
                  options={businessFieldOptionsFor(locale)}
                />
              </Field>
              <Field label={t("hsCode")} hint={t("hsCodeHint")}>
                <Input
                  value={p.hsCode ?? ""}
                  onChange={(e) => updateProduct(i, { hsCode: e.target.value })}
                  placeholder={t("hsCodePlaceholder")}
                />
              </Field>
              <Field label={t("priceRange")} hint={t("priceRangeHint")}>
                <NativeSelect
                  value={p.priceRange}
                  onChange={(v) => updateProduct(i, { priceRange: v })}
                  options={productPriceRangeOptionsFor(locale)}
                />
              </Field>
            </div>
            <Field label={t("specKo")} hint={t("specKoHint")}>
              <Textarea
                value={p.spec ?? ""}
                onChange={(e) => updateProduct(i, { spec: e.target.value })}
                placeholder={t("specKoPlaceholder")}
                rows={2}
              />
            </Field>
            <Field label={t("specEn")} hint={t("specEnHint")}>
              <Textarea
                value={p.specEn ?? ""}
                onChange={(e) => updateProduct(i, { specEn: e.target.value })}
                placeholder={t("specEnPlaceholder")}
                rows={2}
              />
            </Field>
          </Card>
        ))}
        <Button variant="outline" onClick={addProduct} className="self-start">
          <Plus className="size-4" /> {t("addProduct")}
        </Button>
      </div>
    </>
  )
}

// ── 단계 4: 타겟(담당자는 1 기본정보로, KOTRA회원은 회사소개로 이동) ──────────────
function Step4Target({
  draft,
  toggleIn,
}: {
  draft: ExhibitorProfileDraft
  toggleIn: <T extends string>(
    key: keyof ExhibitorProfileDraft,
    code: T
  ) => void
}) {
  const t = useTranslations("applyExhibitor.step4")
  const locale = toFieldLocale(useLocale())
  return (
    <>
      <SectionTitle title={t("title")} subtitle={t("subtitle")} />
      <Field label={t("countries")} hint={t("countriesHint")}>
        <ChipMultiSelect
          options={buyerCountryOptionsFor(locale)}
          selected={draft.preferredBuyerCountries}
          onToggle={(c) => toggleIn("preferredBuyerCountries", c)}
        />
      </Field>
      <Field label={t("types")} hint={t("typesHint")}>
        <ChipMultiSelect
          options={orgTypeOptionsFor(locale)}
          selected={draft.preferredBuyerTypes}
          onToggle={(c) => toggleIn("preferredBuyerTypes", c)}
        />
      </Field>
      {/* 행사 기간 미팅 가능/불가 시간 설정은 운영자 전용으로 전환됐다 — 기업 측 화면에서는 숨긴다
          (unavailableMeetingSlots는 옵셔널 필드로 남아 있고, 값은 운영자 콘솔에서만 바뀐다). */}
    </>
  )
}

// ── 단계 5: 요약·제출 ──────────────────────────────────────────────────────────
function Step5Summary({
  draft,
  completed,
  onJump,
}: {
  draft: ExhibitorProfileDraft
  completed: EditableStep[]
  onJump: (target: Step) => void
}) {
  const t = useTranslations("applyExhibitor")
  const t5 = useTranslations("applyExhibitor.step5")
  const done = new Set<number>(completed)
  const summary: Record<EditableStep, string> = {
    1: t5("step1Summary", {
      names:
        [draft.organizationNameKo, draft.organizationNameEn]
          .filter(Boolean)
          .join(" / ") || t5("empty"),
      count: draft.attendees?.length ?? 0,
    }),
    2: draft.introKo
      ? t5("step2SummaryFilled", { intro: draft.introKo.slice(0, 24) })
      : t5("empty"),
    3: t5("step3Summary", {
      products: cleanProducts(draft.products).length,
      categories: draft.exhibitionCategories?.length ?? 0,
    }),
    4: t5("step4Summary", {
      countries: draft.preferredBuyerCountries?.length ?? 0,
      types: draft.preferredBuyerTypes?.length ?? 0,
    }),
  }
  return (
    <>
      <SectionTitle title={t5("title")} subtitle={t5("subtitle")} />
      <ul className="flex flex-col gap-2">
        {EDITABLE_STEPS.map((s) => (
          <li
            key={s}
            className="flex items-center justify-between rounded-md border border-input px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs",
                  done.has(s)
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {done.has(s) ? <Check className="size-3.5" /> : s}
              </span>
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {t(STEP_TITLE_KEYS[s - 1])}
                </span>
                <span className="text-xs text-muted-foreground">
                  {summary[s]}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!done.has(s) ? (
                <Badge variant="outline" className="text-amber-600">
                  {t5("needsWork")}
                </Badge>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => onJump(s)}>
                {t5("edit")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── 완료 화면 ──────────────────────────────────────────────────────────────────
function CompletionView({ onConfirm }: { onConfirm: () => void }) {
  const t = useTranslations("applyExhibitor.completion")
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10">
        <PartyPopper className="size-7 text-primary" />
      </span>
      <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("description1")}
        <br />
        {t("description2")}
      </p>
      <Button onClick={onConfirm}>{t("confirm")}</Button>
    </div>
  )
}

// ── 신청 완료 후 저장한 프로필 읽기 전용 조회 ───────────────────────────────────
function labelOf<T extends string>(
  opts: Option<T>[],
  code?: T
): string | undefined {
  return code ? (opts.find((o) => o.code === code)?.label ?? code) : undefined
}
function labelsOf<T extends string>(opts: Option<T>[], codes?: T[]): string {
  if (!codes || codes.length === 0) return ""
  return codes.map((c) => opts.find((o) => o.code === c)?.label ?? c).join(", ")
}

// 참가사 프로필 4탭 읽기전용 뷰 — apply 폼의 '신청서 보기'이자 BM-005 프로필 허브의 본체로 공유한다.
// onBack 있으면 돌아가기 노출(단독 화면=/exhibitor/apply 읽기전용), 없으면 숨김(nav 라우트=/exhibitor/profile).
// canEdit이면 '수정하기'(신청기간 중 편집 진입). draft 한 소스를 작성 폼과 동일 구조로 표시.
export function ProfileView({
  draft,
  canEdit,
  onEdit,
  onBack,
  showHeader = true,
  hideTargetTab = false,
}: {
  draft: ExhibitorProfileDraft
  canEdit: boolean
  onEdit: () => void
  onBack?: () => void
  // 운영자 슬라이드 등에 임베드할 때 "내 비즈매칭 프로필" 헤더를 숨긴다(기본값 true — 프로필 화면 그대로).
  showHeader?: boolean
  // 운영자 슬라이드에선 "타겟"(선호 바이어·가능 시간) 탭을 숨긴다(기본값 false — 참가자 프로필 화면은 그대로).
  hideTargetTab?: boolean
}) {
  const t = useTranslations("applyExhibitor.profileView")
  const t2 = useTranslations("applyExhibitor.step2")
  const t3 = useTranslations("applyExhibitor.step3")
  const t4 = useTranslations("applyExhibitor.step4")
  const locale = toFieldLocale(useLocale())
  const products = draft.products ?? []
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* 단독 화면(apply 읽기전용)에선 nav가 없으니 돌아가기. nav 라우트(프로필 허브)에선 숨긴다. */}
      {onBack ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 w-fit text-muted-foreground"
        >
          <ChevronLeft className="size-4" /> {t("back")}
        </Button>
      ) : null}
      {showHeader && (
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">
              {canEdit ? t("descriptionEditable") : t("descriptionLocked")}
            </p>
          </div>
          {canEdit ? (
            <Button onClick={onEdit} className="shrink-0">
              <Pencil className="size-4" /> {t("edit")}
            </Button>
          ) : null}
        </header>
      )}

      <Tabs defaultValue="basic" className="gap-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="basic">{t("tabBasic")}</TabsTrigger>
          <TabsTrigger value="intro">{t("tabIntro")}</TabsTrigger>
          <TabsTrigger value="products">{t("tabProducts")}</TabsTrigger>
          {!hideTargetTab && (
            <TabsTrigger value="target">{t("tabTarget")}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="basic">
          <Step1Basic draft={draft} />
        </TabsContent>

        <TabsContent value="intro">
          <ReadOnlyGroup title={t2("title")}>
            <div className="sm:col-span-2">
              <ReadOnlyField label={t2("introKo")} value={draft.introKo} />
            </div>
            <div className="sm:col-span-2">
              <ReadOnlyField label={t2("introEn")} value={draft.introEn} />
            </div>
            <ReadOnlyField label={t2("website")} value={draft.website} />
            <ReadOnlyField
              label={t2("annualSales")}
              value={labelOf(
                annualSalesSellerOptionsFor(locale),
                draft.annualSalesRange
              )}
            />
            <ReadOnlyField
              label={t2("employeeRange")}
              value={labelOf(employeeRangeOptionsFor(locale), draft.employeeRange)}
            />
            <div className="sm:col-span-2">
              <ReadOnlyField
                label={t2("languages")}
                value={labelsOf(languageOptionsFor(locale), draft.availableLanguages)}
              />
            </div>
          </ReadOnlyGroup>
        </TabsContent>

        <TabsContent value="products">
          <div className="flex flex-col gap-4">
            <SectionTitle title={t3("title")} />
            <ReadOnlyField
              label={t3("categories")}
              value={labelsOf(
                businessFieldOptionsFor(locale),
                draft.exhibitionCategories
              )}
            />
            <ReadOnlyField
              label={t3("contentCategory")}
              value={labelOf(contentCategoryOptionsFor(locale), draft.contentCategory)}
            />
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noProducts")}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {products.map((p, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-3 rounded-md border border-input bg-muted/30 p-4"
                  >
                    <Badge variant="secondary" className="self-start">
                      {t3("productLabel", { n: i + 1 })}
                    </Badge>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ReadOnlyField label={t3("nameKo")} value={p.nameKo} />
                      <ReadOnlyField label={t3("nameEn")} value={p.nameEn} />
                      <ReadOnlyField
                        label={t3("category")}
                        value={labelOf(businessFieldOptionsFor(locale), p.businessField)}
                      />
                      <ReadOnlyField label={t3("hsCode")} value={p.hsCode} />
                      <ReadOnlyField
                        label={t3("priceRange")}
                        value={labelOf(
                          productPriceRangeOptionsFor(locale),
                          p.priceRange
                        )}
                      />
                      <div className="sm:col-span-2">
                        <ReadOnlyField label={t3("specKo")} value={p.spec} />
                      </div>
                      <div className="sm:col-span-2">
                        <ReadOnlyField label={t3("specEn")} value={p.specEn} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {!hideTargetTab && (
          <TabsContent value="target">
            <div className="flex flex-col gap-4">
              <SectionTitle title={t4("title")} />
              <ReadOnlyField
                label={t4("countries")}
                value={labelsOf(
                  buyerCountryOptionsFor(locale),
                  draft.preferredBuyerCountries
                )}
              />
              <ReadOnlyField
                label={t4("types")}
                value={labelsOf(orgTypeOptionsFor(locale), draft.preferredBuyerTypes)}
              />
              {/* 행사 기간 미팅 가능/불가 시간은 운영자 전용 설정으로 전환됐다 — 기업 측 화면에서는 숨긴다. */}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

function SectionTitle({
  title,
  required,
  subtitle,
}: {
  title: string
  required?: boolean
  subtitle?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold">
        {title}
        {required ? <RequiredMark /> : null}
      </h2>
      {subtitle ? (
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}
