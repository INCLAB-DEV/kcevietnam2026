"use client"

// BM-005 마이페이지 — 내 프로필의 한 구획(= 작성 폼의 한 단계)을 다이얼로그에서 직접 고친다.
// 필드 정의·라벨·선택지·검증을 새로 만들지 않고 작성 폼의 스텝 컴포넌트(Step1Basic~Step4Target)를
// 그대로 렌더한다 — 신청서와 마이페이지가 어긋날 여지를 없앤다(PRD F-BM-005 D1의 "작성 폼 단일 소스"를
// 딥링크 대신 다이얼로그로 구현). 저장 페이로드 규칙은 lib/bm/profile-form-state.stepSavePayload,
// 필수 판정은 lib/bm/schemas 정본.
//
// 저장 계약(낙관적 갱신 금지): onSave는 서버 확인까지 기다린다. 성공하면 성공 토스트 + 닫힘(조회는
// 호출부가 서버 응답으로 갱신), 실패하면 에러 토스트만 띄우고 다이얼로그를 열어 둔 채 사용자 입력을
// 그대로 남긴다 — 조회 화면의 값은 건드리지 않으므로 화면엔 여전히 서버의 옛 값이 남는다.
//
// 운영자 소관 필드는 여기서도 못 고친다: 회사명·부스(Hall/관/부스위치/타입/개수)는 스텝 컴포넌트가
// 읽기 전용으로 그리고(부스는 stepSavePayload가 페이로드에서도 뺀다), 승인 상태·미팅 불가 시간대는
// 애초에 이 폼의 필드가 아니다(불가 시간대는 백엔드가 기업 PATCH를 422로 거부 — ExhibitorStep4).

import { useState } from "react"
import { useForm } from "react-hook-form"
import { useTranslations } from "next-intl"
import { Pencil } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { focusFirstErrorField } from "@/components/form/field-controls"
import {
  NO_MISSING_FIELDS,
  missingFieldsOf,
} from "@/lib/bm/schemas"
import {
  SAVE_VALIDATED_STEPS,
  stepSavePayload,
} from "@/lib/bm/profile-form-state"
import type {
  EditableStep,
  ExhibitorProfileDraft,
  ExhibitorStepPatch,
} from "@/lib/bm/types"

import { Step1Basic, Step2Intro, Step3Products, Step4Target } from "./apply-form"
import { mergeDraftInto, toggleCodeIn } from "./draft-form"

// 구획 제목은 작성 폼의 단계 제목을 그대로 쓴다(같은 구획 = 같은 이름).
const STEP_TITLE_KEY: Record<EditableStep, string> = {
  1: "step1.title",
  2: "step2.title",
  3: "step3.title",
  4: "step4.title",
}

export function ExhibitorSectionEditDialog({
  step,
  draft,
  onSave,
  requireComplete = true,
  lockedNotice,
  describeSaveError,
  onOpenChange,
}: {
  step: EditableStep
  // 서버에서 읽어온 현재 프로필 — 다이얼로그를 열 때마다 이 값으로 폼을 되돌린다(취소 후 재진입 시
  // 이전 편집이 남지 않게).
  draft: ExhibitorProfileDraft
  // 저장(서버 PATCH). 실패는 reject — 이 컴포넌트가 에러 토스트를 띄우고 다이얼로그를 유지한다.
  onSave: (step: EditableStep, patch: ExhibitorStepPatch) => Promise<void>
  // 필수 항목이 비어 있으면 저장을 막을지. 기본값 true = 참가자 마이페이지의 현행 동작.
  // 운영자 콘솔은 false — 운영자는 일부만 아는 채로 채워 가므로 누락으로 저장을 막지 않는다
  // (운영자 PATCH도 필수를 요구하지 않는다, app/admin/service.py patch_profile).
  requireComplete?: boolean
  // 기본정보 구획의 "회사명·부스는 수정할 수 없어요" 안내 자리(Step1Basic으로 넘긴다). 미전달이면 참가자용 기본.
  lockedNotice?: React.ReactNode
  // 실패 토스트 문구를 바꿀 기회(권한 없음 등). undefined를 돌려주면 기본 문구를 쓴다.
  describeSaveError?: (error: unknown) => string | undefined
  // 다이얼로그가 열리고 닫힐 때 알린다(열 때는 폼을 draft로 되돌리기 직전). 미전달이면 아무 일도 없다 —
  // 운영자 콘솔이 "열 때의 값"을 기억해 두는 데 쓴다(저장할 때 그 사이 서버가 달라졌는지 견줄 기준).
  onOpenChange?: (open: boolean) => void
}) {
  const t = useTranslations("applyExhibitor")
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // 필수 오류는 [저장] 시도 후에만 표시(작성 폼 [다음]과 같은 정책 — 입력하면 실시간 해제).
  const [showErrors, setShowErrors] = useState(false)
  const form = useForm<ExhibitorProfileDraft>({ defaultValues: draft })
  // RHF watch()는 React Compiler가 메모이제이션을 스킵한다(구독 기반 API) — 의도된 동작.
  // eslint-disable-next-line react-hooks/incompatible-library
  const values = form.watch()

  function handleOpenChange(next: boolean) {
    onOpenChange?.(next)
    if (next) {
      form.reset(draft)
      setShowErrors(false)
    }
    setOpen(next)
  }

  function patch(update: Partial<ExhibitorProfileDraft>) {
    mergeDraftInto(form, update)
  }

  function toggleIn<T extends string>(
    key: keyof ExhibitorProfileDraft,
    code: T
  ) {
    toggleCodeIn(form, key, code)
  }

  // 필수 게이트가 걸리는 단계인가 — 운영자 모드(requireComplete=false)는 어느 단계도 막지 않는다.
  const validated = requireComplete && SAVE_VALIDATED_STEPS.includes(step)

  async function handleSave() {
    const current = form.getValues()
    if (validated) {
      if (missingFieldsOf(step, current).size > 0) {
        setShowErrors(true)
        // 오류 마크가 렌더된 뒤 첫 오류 입력으로 포커스(폼 공통 규칙).
        setTimeout(() => focusFirstErrorField(), 0)
        return
      }
    }
    setSaving(true)
    try {
      await onSave(step, stepSavePayload(current, step))
      toast.success(t("profileEdit.saved"))
      setOpen(false)
    } catch (error) {
      // 서버가 거부했으면 조회 값은 그대로 두고 입력만 남긴다(낙관적 갱신 없음).
      toast.error(describeSaveError?.(error) ?? t("saveError"))
    } finally {
      setSaving(false)
    }
  }

  const errors =
    showErrors && validated ? missingFieldsOf(step, values) : NO_MISSING_FIELDS
  const sectionTitle = t(STEP_TITLE_KEY[step])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="size-3.5" />
          {t("profileEdit.trigger", { section: sectionTitle })}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("profileEdit.title", { section: sectionTitle })}
          </DialogTitle>
          <DialogDescription>{t("profileEdit.description")}</DialogDescription>
        </DialogHeader>

        {/* DialogContent가 max-h를 갖는 flex 컨테이너라, 긴 구획(기본정보·전시품목)은 본문만 스크롤한다. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-1">
          {step === 1 && (
            <Step1Basic
              draft={values}
              source={{}}
              patch={patch}
              lockedNotice={lockedNotice}
            />
          )}
          {step === 2 && (
            <Step2Intro
              draft={values}
              source={{}}
              patch={patch}
              toggleIn={toggleIn}
              errors={errors}
            />
          )}
          {step === 3 && (
            <Step3Products
              draft={values}
              source={{}}
              patch={patch}
              toggleIn={toggleIn}
              errors={errors}
            />
          )}
          {step === 4 && <Step4Target draft={values} toggleIn={toggleIn} />}
        </div>

        {showErrors && errors.size > 0 ? (
          <p className="px-5 text-sm text-destructive">
            {t("profileEdit.requiredHint")}
          </p>
        ) : null}

        <DialogFooter className="justify-end">
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              {t("profileEdit.cancel")}
            </Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : null}
            {t("profileEdit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
