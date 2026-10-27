"use client"

// 셀프 비밀번호 변경 다이얼로그 — 참가자 마이페이지(바이어·참가사 **양쪽**) 헤더의 진입점.
// 명단 업로드로 공통 비밀번호가 일괄 부여된 계정이 자기 로그인 비밀번호를 직접 바꾼다(발주자
// 요구사항 2026-09-30). 두 허브(components/apply/buyer-profile-hub·components/exhibitor/
// exhibitor-profile-hub)가 이 한 컴포넌트를 import한다 — 화면마다 폼을 복제하지 않는다.
// 행사의 참가자 메뉴가 "미팅만"이면 프로필 메뉴가 없어 마이페이지에 닿을 길이 없다 — 그때는 사이드바
// 하단(components/app-sidebar.tsx)이 같은 다이얼로그를 trigger만 바꿔 연다(F-NV-001 D15).
//
// 검증 정본은 zod(ChangePasswordFormSchema) + lib/auth/password-policy(백엔드 credentials.py의
// 화면용 사본)다 — 규칙을 여기서 새로 만들지 않는다. signup-form.tsx와 같은 패턴(zodResolver 대신
// 제출 시 수동 safeParse): 오류는 [비밀번호 변경] 시도 후에만 표시되고, watch() 기반 재판정으로
// 입력하면 실시간으로 사라진다. zod 이슈의 message는 문장이 아니라 **메시지 키**
// (changePassword.errors.*)다 — 문구는 화면 로케일(ko/en)의 카탈로그에서 뽑는다. 화면 라벨·안내도
// next-intl(changePassword 네임스페이스).
//
// 서버 판정(현재 비밀번호 일치·정책·기존과 동일·계정 상태)은 전부 FastAPI가 내린다
// (app/auth/password_change.py) — 실패하면 **낙관적 갱신 없이** 다이얼로그를 열어둔 채 입력을
// 남기고 사유를 보여준다(profile-section-edit-dialog.tsx와 같은 저장 계약). 사유 문구는 ko에선
// 서버 문구 그대로, en에선 outcome에 대응하는 번역 문구다(서버 문구는 한국어뿐이다).
// 클라이언트 경계는 ChangePasswordClient(mock/http 스왑) — 데모 세션에서도 동선이 그대로 돈다.

import { useState, type FormEvent } from "react"
import { useForm } from "react-hook-form"
import { useLocale, useTranslations } from "next-intl"
import { KeyRound } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { defaultChangePasswordClient } from "@/lib/auth/change-password-client"
import type { ChangePasswordClient } from "@/lib/auth/change-password-client"
import { resolveLocale } from "@/lib/i18n/config"
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_POLICY,
  exceedsPasswordByteLimit,
} from "@/lib/auth/password-policy"

// ── 검증 정본(zod) ───────────────────────────────────────────────────────────
// 새 비밀번호 규칙은 signup-form.tsx와 **같은 정규식·같은 바이트 상한**을 쓴다(정본
// lib/auth/password-policy.ts). 현재 비밀번호는 빈 값만 막는다 — 맞는지 틀리는지는 서버만 안다.
// 각 규칙의 message는 messages의 changePassword.errors.{키}다(문장 아님 — 위 머리말 참고).
export const ChangePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "currentRequired"),
    newPassword: z
      .string()
      .min(1, "newRequired")
      .regex(PASSWORD_POLICY, "passwordPolicy")
      .refine((value) => !exceedsPasswordByteLimit(value), {
        message: "passwordTooLong",
      }),
    newPasswordConfirm: z.string(),
  })
  .refine((data) => data.newPassword === data.newPasswordConfirm, {
    message: "mismatch",
    path: ["newPasswordConfirm"],
  })

export interface ChangePasswordFormValues {
  currentPassword: string
  newPassword: string
  newPasswordConfirm: string
}

function emptyValues(): ChangePasswordFormValues {
  return { currentPassword: "", newPassword: "", newPasswordConfirm: "" }
}

// 필드별 첫 오류의 **메시지 키** — signup-form.tsx의 fieldErrorsOf와 동형(safeParse → path[0] 키로 집계).
// 문구로 바꾸는 건 렌더 쪽(ChangePasswordDialog)이 한다.
function fieldErrorsOf(
  values: ChangePasswordFormValues
): Partial<Record<keyof ChangePasswordFormValues, string>> {
  const result = ChangePasswordFormSchema.safeParse(values)
  if (result.success) return {}
  const errors: Partial<Record<keyof ChangePasswordFormValues, string>> = {}
  for (const issue of result.error.issues) {
    const key = String(issue.path[0]) as keyof ChangePasswordFormValues
    if (!(key in errors)) errors[key] = issue.message
  }
  return errors
}

const EMPTY_ERRORS: Partial<Record<keyof ChangePasswordFormValues, string>> = {}

// 서버가 거절한 outcome → 화면 문구 키(changePassword.*). ko 로케일은 서버 문구가 있으면 그걸 먼저 쓴다.
const SERVER_ERROR_KEY = {
  invalid_current: "errorInvalidCurrent",
  same_password: "errorSamePassword",
  policy_violation: "errorPolicy",
  no_local_password: "errorNoLocalPassword",
  error: "errorGeneric",
} as const

export interface ChangePasswordDialogProps {
  // 경계 주입(테스트용). 기본은 seam 리졸버가 고른 구현 — 실연동 시 HTTP 구현으로 스왑.
  client?: ChangePasswordClient
  // 다이얼로그를 여는 버튼을 바꿔 끼운다(DialogTrigger asChild — 클릭 가능한 요소 하나여야 한다).
  // 생략하면 마이페이지 헤더용 기본 버튼이다. 사이드바는 자리가 좁아 작은 텍스트 버튼을 넘긴다
  // (components/app-sidebar.tsx — 프로필 메뉴가 없는 "미팅만" 행사의 유일한 진입점).
  trigger?: React.ReactNode
}

export function ChangePasswordDialog({
  client = defaultChangePasswordClient,
  trigger,
}: ChangePasswordDialogProps) {
  const t = useTranslations("changePassword")
  const locale = resolveLocale(useLocale())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 오류는 [비밀번호 변경] 시도 후에만 표시(작성 폼·가입 폼과 같은 정책 — 입력하면 실시간 해제).
  const [showErrors, setShowErrors] = useState(false)
  // 서버가 되돌린 문구 2종. currentPasswordError는 그 필드 인라인으로, serverError는 본문 인라인
  // 영역으로 나간다(정책 문구·계정 상태 안내는 특정 필드의 문제가 아니라 요청 전체의 결과다).
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<ChangePasswordFormValues>({ defaultValues: emptyValues() })
  // RHF watch()는 React Compiler가 메모이제이션을 스킵한다(구독 기반 API) — signup-form.tsx와 동일.
  // eslint-disable-next-line react-hooks/incompatible-library
  const values = form.watch()
  const clientErrors = showErrors ? fieldErrorsOf(values) : EMPTY_ERRORS
  // 메시지 키 → 화면 로케일 문구. maxBytes는 바이트 상한 안내(passwordTooLong)에만 쓰인다.
  const clientErrorText = (key: string | undefined) =>
    key ? t(`errors.${key}`, { maxBytes: PASSWORD_MAX_BYTES }) : undefined

  function handleOpenChange(next: boolean) {
    // 열 때도 닫을 때도 비운다 — 다이얼로그를 떠난 뒤 평문이 폼 상태에 남지 않게(취소 후 재진입 시
    // 이전 입력이 되살아나지도 않는다, profile-section-edit-dialog의 열 때 reset을 한 걸음 더).
    form.reset(emptyValues())
    setShowErrors(false)
    setCurrentPasswordError(null)
    setServerError(null)
    setOpen(next)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setCurrentPasswordError(null)
    setServerError(null)

    const parsed = ChangePasswordFormSchema.safeParse(form.getValues())
    if (!parsed.success) {
      // 현재 비밀번호 미입력·정책 미충족·확인 불일치는 서버에 보내기 전에 여기서 막는다.
      setShowErrors(true)
      return
    }

    setBusy(true)
    const result = await client.changePassword({
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    })
    setBusy(false)

    if (result.outcome === "succeeded") {
      toast.success(t("successToast"))
      form.reset(emptyValues()) // 성공 후 평문을 폼 상태에 남기지 않는다
      setShowErrors(false)
      setOpen(false)
      return
    }
    if (result.outcome === "unauthenticated") {
      // 새 창·리다이렉트는 하지 않는다 — 입력을 잃지 않게 다이얼로그를 그대로 열어둔다.
      toast.error(t("errorUnauthenticated"))
      return
    }
    // 실패 사유 문구. ko는 서버 문구가 곧 안내다(정책 문구의 정본은 백엔드 — 기존 동작 그대로). 서버
    // 문구는 한국어뿐이라 en에서는 outcome에 대응하는 번역 문구를 쓴다. error(네트워크·계약 밖 응답)는
    // 서버 문구가 없어 어느 로케일이든 화면 문구다.
    const message =
      locale === "ko" && result.outcome !== "error" && result.message
        ? result.message
        : t(SERVER_ERROR_KEY[result.outcome])
    if (result.outcome === "invalid_current") {
      // 어느 필드가 문제인지 서버가 알려주는 유일한 경우 — 그 필드 인라인으로 붙인다.
      setCurrentPasswordError(message)
      toast.error(message)
      return
    }
    // policy_violation · same_password · no_local_password · error: 특정 필드가 아니라 요청 전체의 결과다.
    setServerError(message)
    toast.error(message)
  }

  const showRequiredHint = showErrors && Object.keys(clientErrors).length > 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="shrink-0">
            <KeyRound className="size-3.5" />
            {t("trigger")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4 px-5" onSubmit={handleSubmit} noValidate>
          <PasswordField
            id="change-password-current"
            label={t("currentPasswordLabel")}
            error={currentPasswordError ?? clientErrorText(clientErrors.currentPassword)}
            inputProps={{
              ...form.register("currentPassword"),
              autoComplete: "current-password",
            }}
          />
          <PasswordField
            id="change-password-new"
            label={t("newPasswordLabel")}
            hint={t("passwordHint")}
            error={clientErrorText(clientErrors.newPassword)}
            inputProps={{ ...form.register("newPassword"), autoComplete: "new-password" }}
          />
          <PasswordField
            id="change-password-new-confirm"
            label={t("newPasswordConfirmLabel")}
            // 이 필드의 실패 경로는 "새 비밀번호와 다르다" 하나뿐이라, 문구는 화면(i18n)이 소유한다.
            error={clientErrors.newPasswordConfirm ? t("mismatchHint") : undefined}
            inputProps={{ ...form.register("newPasswordConfirm"), autoComplete: "new-password" }}
          />

          {showRequiredHint ? (
            <p className="text-sm text-destructive">{t("requiredHint")}</p>
          ) : null}
          {serverError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {serverError}
            </p>
          ) : null}

          <DialogFooter className="justify-end px-0">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="size-4" /> : null}
              {busy ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// signup-form.tsx의 TextInput과 같은 모양(라벨 + aria-invalid + 힌트/오류 한 줄)을 비밀번호 전용으로
// 좁힌 것 — 그쪽은 모듈 비공개라 import할 수 없고, 필드 정의가 아니라 표시 껍데기라 공유 컴포넌트로
// 승격할 만큼의 재사용은 아니다(오류가 있으면 힌트는 숨긴다).
function PasswordField({
  id,
  label,
  hint,
  error,
  inputProps,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  inputProps: React.ComponentProps<typeof Input>
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" aria-invalid={Boolean(error)} {...inputProps} />
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
