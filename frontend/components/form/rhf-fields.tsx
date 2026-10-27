"use client"

// React Hook Form 연동 필드 래퍼 — field-controls(제어 컴포넌트)를 useController로 감싼다.
// value/onChange 배선과 멀티선택 toggle을 흡수해 스텝 컴포넌트가 control+name만 넘기게 한다.
//
// 에러 표시는 RHF formState가 아니라 부모가 준 error prop을 쓴다 — "오류는 [다음] 시도 후에만
// 표시, 입력하면 실시간 해제" 정책이 폼(오케스트레이터) 소유이기 때문. 여기서 formState를 읽으면
// 표시 시점 정책이 부품에 새어 들어온다("공통으로 할 수 있는 것만 공통").

import type { ReactNode } from "react"
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"
import {
  BoolField,
  ChipMultiSelect,
  SelectField,
  TextAreaField,
  TextField,
  type FieldOption,
} from "./field-controls"

interface RhfBaseProps<TFieldValues extends FieldValues> {
  control: Control<TFieldValues>
  name: FieldPath<TFieldValues>
  label: string
  required?: boolean
  error?: boolean
  badge?: ReactNode
}

interface FormTextFieldProps<TFieldValues extends FieldValues>
  extends RhfBaseProps<TFieldValues> {
  placeholder?: string
  type?: string
  hint?: string
}

export function FormTextField<TFieldValues extends FieldValues>({
  control,
  name,
  ...rest
}: FormTextFieldProps<TFieldValues>) {
  const { field } = useController({ control, name })
  return (
    <TextField {...rest} value={(field.value as string) ?? ""} onChange={field.onChange} />
  )
}

interface FormTextAreaFieldProps<TFieldValues extends FieldValues>
  extends RhfBaseProps<TFieldValues> {
  placeholder?: string
  maxLength?: number
  rows?: number
}

export function FormTextAreaField<TFieldValues extends FieldValues>({
  control,
  name,
  ...rest
}: FormTextAreaFieldProps<TFieldValues>) {
  const { field } = useController({ control, name })
  return (
    <TextAreaField {...rest} value={(field.value as string) ?? ""} onChange={field.onChange} />
  )
}

interface FormSelectFieldProps<TFieldValues extends FieldValues, T extends string>
  extends RhfBaseProps<TFieldValues> {
  options: FieldOption<T>[]
  placeholder?: string
}

export function FormSelectField<TFieldValues extends FieldValues, T extends string>({
  control,
  name,
  ...rest
}: FormSelectFieldProps<TFieldValues, T>) {
  const { field } = useController({ control, name })
  return (
    <SelectField {...rest} value={((field.value as T | "") ?? "") as T | ""} onChange={field.onChange} />
  )
}

interface FormChipMultiSelectProps<TFieldValues extends FieldValues, T extends string>
  extends RhfBaseProps<TFieldValues> {
  options: FieldOption<T>[]
  hint?: string
}

export function FormChipMultiSelect<TFieldValues extends FieldValues, T extends string>({
  control,
  name,
  ...rest
}: FormChipMultiSelectProps<TFieldValues, T>) {
  const { field } = useController({ control, name })
  const values = (field.value as T[] | undefined) ?? []
  const toggle = (code: T) => {
    field.onChange(
      values.includes(code) ? values.filter((c) => c !== code) : [...values, code],
    )
  }
  return <ChipMultiSelect {...rest} values={values} onToggle={toggle} />
}

interface FormBoolFieldProps<TFieldValues extends FieldValues>
  extends RhfBaseProps<TFieldValues> {
  yesLabel?: string
  noLabel?: string
}

export function FormBoolField<TFieldValues extends FieldValues>({
  control,
  name,
  ...rest
}: FormBoolFieldProps<TFieldValues>) {
  const { field } = useController({ control, name })
  return (
    <BoolField
      {...rest}
      value={(field.value as boolean | null) ?? null}
      onChange={field.onChange}
    />
  )
}
