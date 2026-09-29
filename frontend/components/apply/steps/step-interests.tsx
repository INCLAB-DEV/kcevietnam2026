"use client"

// 2단계 — 관심분야·소개. 사업분야 8종(고정, K-콘텐츠 택소노미 kct001tax01) 멀티선택 + 기업소개(국/영).
// 2026-06-29: 기업소개 국/영 둘 다 제공, Note·파일(로고/소개서) 업로드 제거.
// 2026-07-06: 공용 RHF 필드(components/form/rhf-fields)로 전환 — 배선은 control이 담당.
import { useLocale, useTranslations } from "next-intl"
import { adoptionTimelineOptionsFor, budgetRangeOptionsFor, businessFieldOptionsFor } from "@/lib/apply/options"
import {
  FormChipMultiSelect,
  FormSelectField,
  FormTextAreaField,
} from "@/components/form/rhf-fields"
import type { StepProps } from "../step-props"

export function StepInterests({ control, errors }: StepProps) {
  const t = useTranslations("applyBuyer.step2")
  const locale = useLocale() === "en" ? "en" : "ko"
  return (
    <div className="flex flex-col gap-5">
      <FormChipMultiSelect
        control={control}
        name="interestCategories"
        label={t("interests")}
        options={businessFieldOptionsFor(locale)}
        required
        error={errors.has("interestCategories")}
        hint={t("interestsHint")}
      />
      {/* 2026-09-12: maxLength=500 제거 — 참가사 폼(exhibitor apply-form)과 동일하게 상한 없음.
          네이티브 textarea maxLength는 붙여넣기를 단어 중간에서 조용히 잘라 저장해버렸다(M-02). */}
      <FormTextAreaField
        control={control}
        name="companyIntroKo"
        label={t("introKo")}
        rows={5}
        placeholder={t("introKoPlaceholder")}
      />
      <FormTextAreaField
        control={control}
        name="companyIntroEn"
        label={t("introEn")}
        required
        error={errors.has("companyIntroEn")}
        rows={5}
        placeholder="Briefly introduce your organization in English."
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <FormSelectField
          control={control}
          name="budgetRange"
          label={t("budgetRange")}
          options={budgetRangeOptionsFor(locale)}
        />
        <FormSelectField
          control={control}
          name="adoptionTimeline"
          label={t("adoptionTimeline")}
          options={adoptionTimelineOptionsFor(locale)}
        />
      </div>
    </div>
  )
}
