"use client"

// 3단계 — 확인. 1~2단계 입력을 요약하고, 각 단계로 바로 수정 진입(연필)할 수 있게 한다.
// 미완 단계는 경고로 표시하고 제출을 막는다(제출 버튼은 orchestrator가 isSubmittable로 제어).
import { useLocale, useTranslations } from "next-intl"
import { Pencil, CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  adoptionTimelineOptionsFor,
  annualSalesBuyerOptionsFor,
  budgetRangeOptionsFor,
  businessFieldOptionsFor,
  employeeRangeOptionsFor,
  labelOf,
  languageOptionsFor,
  orgTypesFor,
} from "@/lib/apply/options"
import { isStepComplete, type StepNumber } from "@/lib/apply/form-state"
import type { BuyerProfileDraft } from "@/lib/apply/types"

interface StepReviewProps {
  draft: BuyerProfileDraft
  onEditStep: (step: StepNumber) => void
  // 읽기전용(제출 후 잠금 — submitted/approved/rejected): 단계별 수정 버튼을 숨긴다(신청서 보기).
  readOnly?: boolean
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-words">{value || "—"}</span>
    </div>
  )
}

function SummaryCard({
  step,
  draft,
  onEditStep,
  readOnly,
  children,
}: {
  step: StepNumber
  draft: BuyerProfileDraft
  onEditStep: (step: StepNumber) => void
  readOnly?: boolean
  children: React.ReactNode
}) {
  const t = useTranslations("applyBuyer")
  const complete = isStepComplete(step, draft)
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {step}. {t(`stepTitles.${step}`)}
          {!complete && !readOnly && (
            <span className="inline-flex items-center gap-1 text-xs font-normal text-destructive">
              <CircleAlert className="size-3.5" /> {t("review.incomplete")}
            </span>
          )}
        </h3>
        {readOnly ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={() => onEditStep(step)}>
            <Pencil className="size-3.5" />
            {t("review.edit")}
          </Button>
        )}
      </div>
      <div className="divide-y">{children}</div>
    </section>
  )
}

export function StepReview({ draft, onEditStep, readOnly }: StepReviewProps) {
  const t = useTranslations("applyBuyer.review")
  const t1 = useTranslations("applyBuyer.step1")
  const locale = useLocale() === "en" ? "en" : "ko"
  const interests = draft.interestCategories
    .map((c) => labelOf(businessFieldOptionsFor(locale), c))
    .join(", ")
  const orgTypes = draft.orgTypes.map((c) => labelOf(orgTypesFor(locale), c)).join(", ")
  const language = labelOf(languageOptionsFor(locale), draft.contactLanguage)

  return (
    <div className="flex flex-col gap-4">
      {readOnly ? null : <p className="text-sm text-muted-foreground">{t("hint")}</p>}

      <SummaryCard step={1} draft={draft} onEditStep={onEditStep} readOnly={readOnly}>
        <Row
          label={t("name")}
          value={[draft.contactNameEn, draft.contactNameKo].filter(Boolean).join(" / ")}
        />
        <Row label={t("org")} value={draft.organizationNameEn || draft.organizationNameKo} />
        <Row
          label={t("title")}
          value={[draft.contactTitleEn, draft.contactTitleKo].filter(Boolean).join(" / ")}
        />
        <Row label={t("email")} value={draft.contactEmail} />
        <Row label={t("phone")} value={draft.tel} />
        <Row label={t("language")} value={language} />
        <Row
          label={t("interpreterNeed")}
          value={
            draft.contactInterpreterNeed == null
              ? ""
              : draft.contactInterpreterNeed
                ? t1("interpreterYes")
                : t1("interpreterNo")
          }
        />
        <Row label={t("country")} value={draft.country} />
        <Row label={t("orgTypes")} value={orgTypes} />
        <Row label={t("annualSales")} value={labelOf(annualSalesBuyerOptionsFor(locale), draft.annualSalesRange)} />
        <Row label={t("employeeRange")} value={labelOf(employeeRangeOptionsFor(locale), draft.employeeRange)} />
      </SummaryCard>

      <SummaryCard step={2} draft={draft} onEditStep={onEditStep} readOnly={readOnly}>
        <Row label={t("interests")} value={interests} />
        {draft.companyIntroKo && <Row label={t("introKo")} value={draft.companyIntroKo} />}
        <Row label={t("introEn")} value={draft.companyIntroEn} />
        <Row label={t("budgetRange")} value={labelOf(budgetRangeOptionsFor(locale), draft.budgetRange)} />
        <Row label={t("adoptionTimeline")} value={labelOf(adoptionTimelineOptionsFor(locale), draft.adoptionTimeline)} />
      </SummaryCard>
    </div>
  )
}
