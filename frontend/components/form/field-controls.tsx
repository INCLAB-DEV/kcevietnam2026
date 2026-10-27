"use client"

// 폼 공용 입력 컨트롤 — 모든 폼(BM-001 바이어·F-BM-002 참가사·향후 폼)이 공유하는 필드 부품.
// near-mono 디자인(저채도·샤프) 정합. 멀티선택은 칩, 단일선택은 카드/세그먼트, 구간 enum은
// 네이티브 select(모바일 우선 — OS 휠 피커).
//
// 구조: bare control(NativeSelectControl·ChipToggleGroup) ↔ 조합형(TextField 등 = Field 래퍼 포함).
// 폼마다 다른 시맨틱(값 표현·에러 정책·라벨 부속물)은 여기 넣지 않는다 — 호출측 어댑터나
// Field의 badge 슬롯으로 해결한다("공통으로 할 수 있는 것만 공통").
// RHF 연동 래퍼는 rhf-fields.tsx(별도) — 이 파일은 제어 컴포넌트(value/onChange)만.

import { useId, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Check } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// 옵션 형태 — lib/apply/options·lib/bm 의 Option과 구조 호환(도메인 모듈에 의존하지 않는다).
export interface FieldOption<T extends string> {
  code: T
  label: string
}

// 안정적 id(서버/클라 하이드레이션 일치) — React useId. 명시 id가 있으면 그것을 우선.
function useFieldId(explicit?: string): string {
  const generated = useId()
  return explicit ?? generated
}

interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  error?: boolean
  hint?: string
  // 라벨 옆 부속물 슬롯 — 참가사 폼의 출처 배지(등록정보/AI 초안) 등 폼 고유 표식은 이 슬롯으로.
  badge?: ReactNode
  children: ReactNode
}

export function Field({ label, htmlFor, required, error, hint, badge, children }: FieldProps) {
  return (
    // data-field-error: 오류 필드 앵커 — focusFirstErrorField가 "다음" 차단 시 첫 오류 입력으로
    // 포커스를 옮기는 데 쓴다(폼 공통 규칙: 필수 미충족 → 에러 표시 + 포커스).
    <div className="flex flex-col gap-1.5" data-field-error={error ? "" : undefined}>
      <div className="flex items-center gap-2">
        <Label htmlFor={htmlFor} className={cn(error && "text-destructive")}>
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        {badge}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <RequiredFieldError />}
    </div>
  )
}

// 필수 미충족 안내 한 줄. 문구는 messages의 common.form.required(화면 로케일)에서 온다.
// Field 본문이 아니라 별도 컴포넌트로 둔 이유: 번역 훅은 next-intl provider 안에서만 쓸 수 있는데,
// Field(ChipMultiSelect 경유)는 provider 없이 렌더하는 운영자 콘솔 테스트에서도 쓰인다. 그쪽은
// error를 넘기지 않으므로, 오류가 있을 때만 마운트되는 이 컴포넌트에 훅을 가둬 두면 영향이 없다.
function RequiredFieldError() {
  const t = useTranslations("common.form")
  return <p className="text-xs text-destructive">{t("required")}</p>
}

// 첫 오류 필드(data-field-error)의 첫 입력 요소로 포커스 — [다음] 차단 직후 호출한다.
// setState 반영 후 DOM에 오류 마크가 그려진 다음 찾아야 하므로 호출측은 setTimeout(0)으로 미룬다.
export function focusFirstErrorField(root: ParentNode = document): void {
  const holder = root.querySelector("[data-field-error]")
  const target = holder?.querySelector<HTMLElement>("input, textarea, select, button")
  target?.focus()
}

interface TextFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  error?: boolean
  placeholder?: string
  type?: string
  hint?: string
  badge?: ReactNode
  id?: string
}

export function TextField({
  label,
  value,
  onChange,
  required,
  error,
  placeholder,
  type = "text",
  hint,
  badge,
  id,
}: TextFieldProps) {
  const fieldId = useFieldId(id)
  return (
    <Field label={label} htmlFor={fieldId} required={required} error={error} hint={hint} badge={badge}>
      <Input
        id={fieldId}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={error || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

interface TextAreaFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  error?: boolean
  placeholder?: string
  maxLength?: number
  rows?: number
  badge?: ReactNode
  id?: string
}

export function TextAreaField({
  label,
  value,
  onChange,
  required,
  error,
  placeholder,
  maxLength,
  rows = 4,
  badge,
  id,
}: TextAreaFieldProps) {
  const fieldId = useFieldId(id)
  return (
    <Field
      label={label}
      htmlFor={fieldId}
      required={required}
      error={error}
      badge={badge}
      hint={maxLength ? `${value.length} / ${maxLength}` : undefined}
    >
      <Textarea
        id={fieldId}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

// bare 네이티브 select — Field 래퍼 없이 마크업/스타일만. 값 시맨틱("" vs undefined)은 호출측이
// 어댑트한다(참가사 폼은 undefined 기반이라 얇은 어댑터를 둔다).
// placeholder를 생략하면 messages의 common.form.selectPlaceholder(화면 로케일)를 쓴다 — 참가자 신청서
// 전용 컨트롤이라(운영자 콘솔은 자체 select를 쓴다) 번역 훅을 여기서 직접 부른다.
interface NativeSelectControlProps<T extends string> {
  value: T | ""
  options: FieldOption<T>[]
  onChange: (v: T | "") => void
  placeholder?: string
  disabledPlaceholder?: boolean
  invalid?: boolean
  id?: string
}

export function NativeSelectControl<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  disabledPlaceholder = true,
  invalid,
  id,
}: NativeSelectControlProps<T>) {
  const t = useTranslations("common.form")
  return (
    <select
      id={id}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value as T | "")}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        value === "" && "text-muted-foreground",
      )}
    >
      <option value="" disabled={disabledPlaceholder}>
        {placeholder ?? t("selectPlaceholder")}
      </option>
      {options.map((o) => (
        <option key={o.code} value={o.code} className="text-foreground">
          {o.label}
        </option>
      ))}
    </select>
  )
}

interface SelectFieldProps<T extends string> {
  label: string
  value: T | ""
  options: FieldOption<T>[]
  onChange: (v: T | "") => void
  required?: boolean
  error?: boolean
  placeholder?: string
  badge?: ReactNode
  id?: string
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  required,
  error,
  placeholder,
  badge,
  id,
}: SelectFieldProps<T>) {
  const fieldId = useFieldId(id)
  return (
    <Field label={label} htmlFor={fieldId} required={required} error={error} badge={badge}>
      <NativeSelectControl
        id={fieldId}
        value={value}
        options={options}
        onChange={onChange}
        placeholder={placeholder}
        invalid={error}
      />
    </Field>
  )
}

// bare 멀티선택 칩 — Field 래퍼 없이. 선택 시 면을 채워(near-mono) 상태를 명확히.
interface ChipToggleGroupProps<T extends string> {
  values: T[] | undefined
  options: FieldOption<T>[]
  onToggle: (code: T) => void
}

export function ChipToggleGroup<T extends string>({
  values,
  options,
  onToggle,
}: ChipToggleGroupProps<T>) {
  const set = new Set(values ?? [])
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = set.has(o.code)
        return (
          <button
            key={o.code}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(o.code)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-input bg-background text-foreground hover:bg-muted",
            )}
          >
            {active && <Check className="size-3.5" />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

interface ChipMultiSelectProps<T extends string> {
  label: string
  values: T[]
  options: FieldOption<T>[]
  onToggle: (code: T) => void
  required?: boolean
  error?: boolean
  hint?: string
  badge?: ReactNode
}

// 멀티선택 칩(Field 포함) — 사업분야 8종·참가자 구분 8종·언어.
export function ChipMultiSelect<T extends string>({
  label,
  values,
  options,
  onToggle,
  required,
  error,
  hint,
  badge,
}: ChipMultiSelectProps<T>) {
  return (
    <Field label={label} required={required} error={error} hint={hint} badge={badge}>
      <ChipToggleGroup values={values} options={options} onToggle={onToggle} />
    </Field>
  )
}

interface RadioCardsProps<T extends string> {
  label: string
  value: T | ""
  options: FieldOption<T>[]
  onChange: (v: T) => void
  required?: boolean
  error?: boolean
}

// 단일선택 카드 — 참가 경로 등. 큰 탭 영역(모바일 우선).
export function RadioCards<T extends string>({
  label,
  value,
  options,
  onChange,
  required,
  error,
}: RadioCardsProps<T>) {
  return (
    <Field label={label} required={required} error={error}>
      <div className="grid gap-2">
        {options.map((o) => {
          const active = value === o.code
          return (
            <button
              key={o.code}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.code)}
              className={cn(
                "flex items-center justify-between rounded-md border px-3.5 py-2.5 text-left text-sm transition-colors",
                active ? "border-foreground bg-muted" : "border-input hover:bg-muted/60",
              )}
            >
              <span>{o.label}</span>
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border",
                  active ? "border-foreground" : "border-muted-foreground/40",
                )}
              >
                {active && <span className="size-2 rounded-full bg-foreground" />}
              </span>
            </button>
          )
        })}
      </div>
    </Field>
  )
}

interface BoolFieldProps {
  label: string
  value: boolean | null
  onChange: (v: boolean) => void
  required?: boolean
  error?: boolean
  yesLabel?: string
  noLabel?: string
}

// yesLabel/noLabel을 생략하면 messages의 common.form.yes/no(화면 로케일)를 쓴다.
export function BoolField({
  label,
  value,
  onChange,
  required,
  error,
  yesLabel,
  noLabel,
}: BoolFieldProps) {
  const t = useTranslations("common.form")
  return (
    <Field label={label} required={required} error={error}>
      <div className="grid grid-cols-2 gap-2">
        {[
          { v: true, l: yesLabel ?? t("yes") },
          { v: false, l: noLabel ?? t("no") },
        ].map(({ v, l }) => {
          const active = value === v
          return (
            <button
              key={l}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(v)}
              className={cn(
                "rounded-md border px-3 py-2 text-sm transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-input hover:bg-muted",
              )}
            >
              {l}
            </button>
          )
        })}
      </div>
    </Field>
  )
}
