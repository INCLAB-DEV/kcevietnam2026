"use client"

// BM-004 마이페이지 — 내 신청서의 한 구획(= 작성 폼의 한 단계)을 다이얼로그에서 직접 고친다.
// 필드 정의·라벨·선택지·검증을 새로 만들지 않고 작성 폼의 스텝 컴포넌트(StepBasicInfo·StepInterests)를
// 그대로 렌더한다 — 신청서와 마이페이지가 어긋날 여지를 없앤다(PRD F-BM-004 D4의 "쓰기는 작성 폼
// 단일 소스"를 `/apply?step=N` 딥링크 대신 다이얼로그로 구현: 딥링크는 제출 후 잠긴 폼으로 들어가
// 읽기전용 화면만 나오고, 화면을 떠났다 돌아오는 왕복도 필요했다).
// 필수 판정은 lib/apply/form-state.validateStep(정본 lib/apply/schemas), 저장 페이로드는 stepPatch.
//
// 저장 계약(낙관적 갱신 금지): onSave는 서버 확인까지 기다린다. 성공하면 성공 토스트 + 닫힘(조회는
// 호출부가 서버 응답으로 갱신), 실패하면 에러 토스트만 띄우고 다이얼로그를 열어 둔 채 입력을 남긴다 —
// 조회 화면의 값은 건드리지 않으므로 화면엔 여전히 서버의 옛 값이 남는다.
//
// 운영자 소관 필드(승인 상태·부스·관리 운영자)는 애초에 이 폼의 필드가 아니다 — 바이어 신청서는
// 1 기본정보 / 2 관심분야·소개 두 구획이 전부이고, 상태 전이(제출·승인)는 /welcome·운영 콘솔 소관이다.

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
import { stepPatch, validateStep } from "@/lib/apply/form-state"
import type {
  BuyerEditableStep,
  BuyerProfileDraft,
  BuyerStepPatch,
} from "@/lib/apply/types"

import { StepBasicInfo } from "./steps/step-basic-info"
import { StepInterests } from "./steps/step-interests"

const NO_ERRORS: Set<string> = new Set()

export function BuyerSectionEditDialog({
  step,
  draft,
  onSave,
  requireComplete = true,
  describeSaveError,
  onOpenChange,
}: {
  // 편집 가능한 구획은 1(기본정보)·2(관심분야·소개)뿐 — 3은 확인·제출 단계라 입력이 없다.
  step: BuyerEditableStep
  // 서버에서 읽어온 현재 신청서 — 다이얼로그를 열 때마다 이 값으로 폼을 되돌린다(취소 후 재진입 시
  // 이전 편집이 남지 않게).
  draft: BuyerProfileDraft
  // 저장(서버 PATCH). 실패는 reject — 이 컴포넌트가 에러 토스트를 띄우고 다이얼로그를 유지한다.
  onSave: (step: BuyerEditableStep, patch: BuyerStepPatch) => Promise<void>
  // 필수 항목이 비어 있으면 저장을 막을지. 기본값 true = 바이어 마이페이지의 현행 동작.
  // 운영자 콘솔은 false — 운영자는 일부만 아는 채로 채워 가므로 누락으로 저장을 막지 않는다
  // (운영자 PATCH도 필수를 요구하지 않는다, app/admin/service.py patch_profile).
  requireComplete?: boolean
  // 실패 토스트 문구를 바꿀 기회(권한 없음 등). undefined를 돌려주면 기본 문구를 쓴다.
  describeSaveError?: (error: unknown) => string | undefined
  // 다이얼로그가 열리고 닫힐 때 알린다(열 때는 폼을 draft로 되돌리기 직전). 미전달이면 아무 일도 없다 —
  // 운영자 콘솔이 "열 때의 값"을 기억해 두는 데 쓴다(저장할 때 그 사이 서버가 달라졌는지 견줄 기준).
  onOpenChange?: (open: boolean) => void
}) {
  const t = useTranslations("applyBuyer")
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // 필수 오류는 [저장] 시도 후에만 표시(작성 폼 [다음]과 같은 정책 — 입력하면 실시간 해제).
  const [showErrors, setShowErrors] = useState(false)
  const form = useForm<BuyerProfileDraft>({ defaultValues: draft })
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

  async function handleSave() {
    const current = form.getValues()
    if (requireComplete && !validateStep(step, current).ok) {
      setShowErrors(true)
      // 오류 마크가 렌더된 뒤 첫 오류 입력으로 포커스(폼 공통 규칙).
      setTimeout(() => focusFirstErrorField(), 0)
      return
    }
    setSaving(true)
    try {
      await onSave(step, stepPatch(step, current))
      toast.success(t("profileEdit.saved"))
      setOpen(false)
    } catch (error) {
      // 서버가 거부했으면 조회 값은 그대로 두고 입력만 남긴다(낙관적 갱신 없음).
      toast.error(describeSaveError?.(error) ?? t("profileEdit.saveError"))
    } finally {
      setSaving(false)
    }
  }

  const errors =
    showErrors && requireComplete
      ? new Set(validateStep(step, values).missing)
      : NO_ERRORS
  const sectionTitle = t(`stepTitles.${step}`)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="size-3.5" />
          {t("profileEdit.trigger", { section: sectionTitle })}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("profileEdit.title", { section: sectionTitle })}
          </DialogTitle>
          <DialogDescription>{t("profileEdit.description")}</DialogDescription>
        </DialogHeader>

        {/* DialogContent가 max-h를 갖는 flex 컨테이너라, 긴 구획은 본문만 스크롤한다. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-1">
          {step === 1 ? (
            <StepBasicInfo control={form.control} errors={errors} />
          ) : (
            <StepInterests control={form.control} errors={errors} />
          )}
        </div>

        {showErrors && errors.size > 0 ? (
          <p className="px-5 text-sm text-destructive">{t("requiredHint")}</p>
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
