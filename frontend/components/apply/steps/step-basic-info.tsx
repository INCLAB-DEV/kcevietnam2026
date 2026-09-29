"use client"

// 1단계 — 기본정보(2026-06-29). 신청자 식별(이름·소속·직위 국/영, 이메일, 전화번호, 구분, 언어)
// + 국가·기업규모. "소속"=organizations.name_ko/en 재사용, "전화번호"=tel, "구분"=참가자 구분(8종).
// 이름·직위·이메일·언어는 신규(신청자 1인). 컬럼 매핑은 후속(HITL — types.ts 주석).
// 2026-07-06: 공용 RHF 필드(components/form/rhf-fields)로 전환 — 배선은 control이 담당.
import { useLocale, useTranslations } from "next-intl"
import {
  annualSalesBuyerOptionsFor,
  employeeRangeOptionsFor,
  languageOptionsFor,
  orgTypeChoicesFor,
} from "@/lib/apply/options"
import {
  FormBoolField,
  FormChipMultiSelect,
  FormSelectField,
  FormTextField,
} from "@/components/form/rhf-fields"
import type { StepProps } from "../step-props"

export function StepBasicInfo({ control, errors }: StepProps) {
  const t = useTranslations("applyBuyer.step1")
  const locale = useLocale() === "en" ? "en" : "ko"
  return (
    <div className="flex flex-col gap-5">
      {/* 순서: 이름 → 소속 → 직위 → 이메일 → 전화번호 → 언어 → 국가 → 구분 → 규모 */}
      <div className="grid gap-5 sm:grid-cols-2">
        <FormTextField control={control} name="contactNameKo" label={t("nameKo")} />
        <FormTextField
          control={control}
          name="contactNameEn"
          label={t("nameEn")}
          required
          error={errors.has("contactNameEn")}
        />
        <FormTextField
          control={control}
          name="organizationNameKo"
          label={t("orgKo")}
          placeholder={t("selectPlaceholder")}
        />
        <FormTextField
          control={control}
          name="organizationNameEn"
          label={t("orgEn")}
          required
          error={errors.has("organizationNameEn")}
          placeholder="Organization (EN)"
        />
        <FormTextField control={control} name="contactTitleKo" label={t("titleKo")} />
        <FormTextField control={control} name="contactTitleEn" label={t("titleEn")} />
      </div>
      <FormTextField
        control={control}
        name="contactEmail"
        label={t("email")}
        type="email"
        required
        error={errors.has("contactEmail")}
      />
      <FormTextField
        control={control}
        name="tel"
        label={t("phone")}
        type="tel"
        required
        error={errors.has("tel")}
      />
      <FormSelectField control={control} name="contactLanguage" label={t("language")} options={languageOptionsFor(locale)} />
      <FormBoolField
        control={control}
        name="contactInterpreterNeed"
        label={t("interpreterNeed")}
        yesLabel={t("interpreterYes")}
        noLabel={t("interpreterNo")}
      />
      <FormTextField
        control={control}
        name="country"
        label={t("country")}
        required
        error={errors.has("country")}
      />
      <FormChipMultiSelect
        control={control}
        name="orgTypes"
        label={t("orgTypes")}
        options={orgTypeChoicesFor(locale)}
        hint={t("orgTypesHint")}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <FormSelectField
          control={control}
          name="annualSalesRange"
          label={t("annualSales")}
          options={annualSalesBuyerOptionsFor(locale)}
        />
        <FormSelectField
          control={control}
          name="employeeRange"
          label={t("employeeRange")}
          options={employeeRangeOptionsFor(locale)}
        />
      </div>
    </div>
  )
}
