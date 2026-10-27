"use client"

// BM-001 3단계 폼 오케스트레이터 — 단계 진행/검증/이어쓰기 저장을 묶는다.
// 도메인 규칙은 순수 모듈에 위임한다:
//   - 진행/이어쓰기/직접진입: lib/apply/form-state (profile-form-state)
//   - 단계별 검증 스키마:     lib/apply/schemas (validateStep과 동등 — schemas.test.ts가 고정)
//   - 저장/조회/제출:         lib/apply/buyer-profile-store (#26 API 미러) + form-actions(서버 POST)
// 폼 상태는 React Hook Form(control)이 들고, 필드는 공용 RHF 래퍼(components/form/rhf-fields)가
// 그린다. 검증·에러 표시 정책은 이 오케스트레이터 소유: 오류는 "다음" 시도 후에만 표시하되
// 입력하면 실시간으로 사라진다 — watch() 리렌더마다 현재 단계 스키마로 재판정(파생 상태).
// 폼은 드래프트 저장만 하고, 제출(application_status 전환)은 /welcome에서 일어난다(2026-06-30 결정).

import { useEffect, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArrowLeft, ArrowRight, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { focusFirstErrorField } from "@/components/form/field-controls"
import {
  completedSteps,
  furthestStep,
  nextStep,
  prevStep,
  resolveEntryStep,
  stepPatch,
  LAST_STEP,
  REVIEW_STEP,
  type StepNumber,
} from "@/lib/apply/form-state"
import { STEP_SCHEMAS } from "@/lib/apply/schemas"
import { saveStepToServer } from "@/lib/apply/form-actions"
import {
  loadProfile,
  saveStep,
  type ProfileSeed,
} from "@/lib/apply/buyer-profile-store"
import {
  emptyBuyerProfileDraft,
  type BuyerEditableStep,
  type BuyerProfileDraft,
  type ApplicationStatus,
} from "@/lib/apply/types"
import { getBuyerClient } from "@/lib/bm/buyer-client"
import { ApplyStepper } from "./apply-stepper"
import { StepBasicInfo } from "./steps/step-basic-info"
import { StepInterests } from "./steps/step-interests"
import { StepReview } from "./steps/step-review"

export interface ApplyFormProps {
  // 프로필 식별자 — mock 스토어(localStorage)의 키(세션 orgId). isReal=true여도 이 값 자체는
  // 쓰이지 않지만(실 경로는 orgEventRoleId를 쓴다) prop은 항상 받는다(호출부 단순화).
  profileKey: string
  // 실 세션의 org_event_role_id — isReal=true일 때 getBuyerClient(true) 호출의 경로 파라미터로
  // 쓰인다(/api/bm/buyer/{id}). isReal=false면 쓰이지 않는다.
  orgEventRoleId?: string
  seed?: ProfileSeed
  // /apply?step=N 직접 진입 요청값(서버 searchParams).
  initialStepParam?: number
  // 세션 application_status(권위) — 읽기전용 판단의 단일 소스(localStorage status가 아니라 이걸 본다,
  // dev ?status는 세션 쿠키에만 반영되므로). 실연동 시 Cognito status.
  applicationStatus?: ApplicationStatus
  // 실 로그인 세션이면 true — getBuyerClient(true)로 실 백엔드(FastAPI, BFF 경유)를 쓴다. 기본값
  // false(미전달 시 기존 buyer-profile-store(localStorage) mock 동작 100% 보존, exhibitor
  // apply-form(components/exhibitor/apply-form.tsx)의 isReal과 동일 패턴).
  isReal?: boolean
}

const EMPTY_ERRORS: Set<string> = new Set()

// 현재 단계 스키마의 미충족 필드 키 — validateStep의 missing과 동일 키(schemas.test.ts 계약).
function missingOf(step: StepNumber, draft: BuyerProfileDraft): Set<string> {
  const result = STEP_SCHEMAS[step].safeParse(draft)
  if (result.success) return EMPTY_ERRORS
  return new Set(result.error.issues.map((issue) => String(issue.path[0])))
}

export function ApplyForm({
  profileKey,
  orgEventRoleId,
  seed,
  initialStepParam,
  applicationStatus = "registered",
  isReal = false,
}: ApplyFormProps) {
  const t = useTranslations("applyBuyer")
  const router = useRouter()
  // 실 세션이면 getBuyerClient(true)(BFF 경유 FastAPI). mock(기본값)은 null — 아래 분기가 기존
  // buyer-profile-store(localStorage)/form-actions 경로를 그대로 탄다(100% 보존).
  const api = useMemo(() => (isReal ? getBuyerClient(true) : null), [isReal])
  const realRoleId = orgEventRoleId ?? profileKey

  // localStorage는 클라이언트에만 있으므로 마운트 후 store에서 하이드레이트(SSR 불일치 방지).
  // 실 세션은 대신 FastAPI(BFF 경유)에서 비동기로 읽는다.
  const [hydrated, setHydrated] = useState(false)
  const [step, setStep] = useState<StepNumber>(1)
  const [showErrors, setShowErrors] = useState(false)

  const form = useForm<BuyerProfileDraft>({
    defaultValues: emptyBuyerProfileDraft(),
  })
  // RHF watch()는 React Compiler가 메모이제이션을 스킵한다(구독 기반 API) — 의도된 동작.
  // eslint-disable-next-line react-hooks/incompatible-library
  const draft = form.watch()

  useEffect(() => {
    if (api) {
      // 실 세션 — 로컬 store를 거치지 않고 저장된 프로필을 그대로 이어쓴다(데모 seed 프리필 없음,
      // exhibitor apply-form과 동일 원칙 — 실사용자에게 가짜 값을 보여주지 않는다).
      let alive = true
      api
        .getProfile(realRoleId)
        .then(({ draft: loaded }) => {
          if (!alive) return
          form.reset(loaded)
          setStep(resolveEntryStep(initialStepParam, loaded))
          setHydrated(true)
        })
        .catch(() => {
          if (alive) {
            toast.error(t("loadError"))
            setHydrated(true)
          }
        })
      return () => {
        alive = false
      }
    }
    // 클라이언트 전용 영속 스토어(localStorage)에서 1회 하이드레이트한다. 마운트 후 읽어
    // SSR/CSR 입력값 불일치를 피한다. 1회성이라 cascading render가 아니다.
    const stored = loadProfile(profileKey, seed)
    form.reset(stored.draft)
    setStep(resolveEntryStep(initialStepParam, stored.draft))
    setHydrated(true)
    // 최초 1회 — api/profileKey/realRoleId 변화 시에만 재하이드레이트.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, profileKey, realRoleId])

  const completed = completedSteps(draft)
  const furthest = furthestStep(draft)
  // 오류는 "다음" 시도 후에만 표시 — 입력할 때마다 watch() 리렌더로 재판정돼 실시간으로 사라진다.
  const errors =
    showErrors && step < REVIEW_STEP ? missingOf(step, draft) : EMPTY_ERRORS

  function syncUrl(target: StepNumber) {
    if (typeof window === "undefined") return
    const params = new URLSearchParams()
    params.set("step", String(target))
    window.history.replaceState(null, "", `/apply?${params.toString()}`)
  }

  // 현재 단계의 필드만 부분저장(PATCH — backend /steps/{step} 미러). 다른 단계 값은 보존된다.
  // mock: 로컬 store가 복구(재개)의 단일 소스(동기) + 서버 저장은 비차단 미러 — 실패해도 이동은
  // 막지 않고 토스트로만 알린다(입력값은 로컬에 남아 있다). 실 세션: getBuyerClient(true)로 직접
  // PATCH(로컬 store 미사용) — 실패해도 마찬가지로 이동은 막지 않는다(토스트만).
  function persist() {
    if (step >= REVIEW_STEP) return
    const values = form.getValues()
    if (api) {
      // step은 위 가드로 REVIEW_STEP(3) 미만 — BuyerEditableStep(1|2)과 정확히 일치.
      void api
        .saveStep(
          realRoleId,
          step as BuyerEditableStep,
          stepPatch(step, values)
        )
        .catch(() => {
          toast.error(t("saveServerError"))
        })
      return
    }
    saveStep(profileKey, step, stepPatch(step, values), seed)
    void saveStepToServer(step, values).then((result) => {
      if (!result.success) {
        toast.error(t("saveServerError"))
      }
    })
  }

  function goTo(target: StepNumber) {
    persist()
    setShowErrors(false)
    setStep(target)
    syncUrl(target)
    if (typeof window !== "undefined") {
      try {
        window.scrollTo({ top: 0 })
      } catch {
        // jsdom 등 scrollTo 미구현 환경 — 무시.
      }
    }
  }

  function handleNext() {
    if (step < REVIEW_STEP && missingOf(step, form.getValues()).size > 0) {
      setShowErrors(true)
      // 오류 마크가 렌더된 뒤 첫 오류 입력으로 포커스(폼 공통 규칙).
      setTimeout(() => focusFirstErrorField(), 0)
      return
    }
    goTo(nextStep(step))
  }

  function handleBack() {
    goTo(prevStep(step))
  }

  // 로그인 바이어: 폼은 '저장'만 한다(제출 분리, 2026-06-30 결정). 현재 단계를 저장하고 입장 전 랜딩으로 —
  // 실제 제출(application_status 전환)은 /welcome에서 일어난다.
  function handleSaveExit() {
    persist()
    router.push("/welcome")
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-60 items-center justify-center" aria-busy>
        <Spinner />
      </div>
    )
  }

  // 제출 후 잠금(읽기전용) — submitted/approved/rejected는 '신청서 보기'로만. 수정 진입·저장 동선을 막는다.
  // 판단은 세션 status(prop) 단일 소스. 수정은 운영이 changes_requested로 돌려보낼 때만 다시 열린다.
  if (
    applicationStatus === "submitted" ||
    applicationStatus === "approved" ||
    applicationStatus === "rejected"
  ) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {/* 단독 화면이라 nav가 없으니 입장 전 화면(/welcome)으로 돌아갈 뒤로가기를 준다. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/welcome")}
          className="-ml-2 w-fit text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> {t("locked.back")}
        </Button>
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
            {t("locked.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("locked.description")}
          </p>
        </header>
        <StepReview draft={draft} onEditStep={() => {}} readOnly />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
          {t("header.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("header.subtitle")}</p>
      </header>

      <div data-tour="apply-steps">
        <ApplyStepper
          current={step}
          completed={completed}
          furthest={furthest}
          onJump={goTo}
        />
      </div>

      <div data-tour="apply-form">
        <h2 className="mb-4 text-base font-semibold">
          {step}. {t(`stepTitles.${step}`)}
        </h2>
        {step === 1 && <StepBasicInfo control={form.control} errors={errors} />}
        {step === 2 && <StepInterests control={form.control} errors={errors} />}
        {step === 3 && <StepReview draft={draft} onEditStep={goTo} />}
      </div>

      {showErrors && step < REVIEW_STEP && errors.size > 0 && (
        <p className="text-sm text-destructive">{t("requiredHint")}</p>
      )}

      <footer
        className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur"
        data-tour="apply-nav"
      >
        {step > 1 ? (
          <Button type="button" variant="outline" onClick={handleBack}>
            <ArrowLeft className="size-4" />
            {t("back")}
          </Button>
        ) : (
          <span />
        )}
        {step < LAST_STEP ? (
          <Button type="button" onClick={handleNext}>
            {t("next")}
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          // 로그인 바이어: 저장만 — 제출은 입장 전 화면(/welcome)에서.
          <Button type="button" onClick={handleSaveExit}>
            <Save className="size-4" />
            {t("saveExit")}
          </Button>
        )}
      </footer>
    </div>
  )
}
