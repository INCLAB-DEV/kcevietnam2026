"use client"

// 자체 회원가입 폼. 로그인(DX Korea 아이디/비번)과는 별개 경로 — 가입 가능한 역할은 바이어/참가사
// 둘뿐이다(운영자 계열은 가입 경로 없음, 슈퍼어드민은 DB에서만 부여). 폼 상태는 React Hook Form이
// 들고, 검증 정본은 zod(SignupFormSchema)가 맡는다 — apply-form.tsx와 같은 패턴(zodResolver 대신
// 제출 시 수동 safeParse): 오류는 "가입하기" 시도 후에만 표시되고, watch() 기반 재판정으로 입력하면
// 실시간으로 사라진다. 제출 후 성공/409/422는 SignupClient(lib/auth/signup-client.ts, mock/http 스왑)로 분기.

import { useEffect, useState, type FormEvent } from "react"
import { useForm, useController, type Control, type UseFormRegisterReturn } from "react-hook-form"
import { useTranslations } from "next-intl"
import { Loader2, ChevronRight, CheckCircle2 } from "lucide-react"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { defaultSignupClient } from "@/lib/auth/signup-client"
import type { SignupClient, SignupRole } from "@/lib/auth/signup-client"
import { CONSENT_DOCUMENTS } from "@/lib/auth/mock-auth-client"
import { PASSWORD_MAX_BYTES, PASSWORD_POLICY, exceedsPasswordByteLimit } from "@/lib/auth/password-policy"

// 이메일 실존 인증(#9) — 재발송 쿨다운(초). 백엔드 레이트리밋(app.auth.email_verification_service.
// RESEND_COOLDOWN)과 동일한 값을 화면에도 못박아 둔다(서버가 최종 판정, 이건 UX용 타이머일 뿐).
const RESEND_COOLDOWN_SECONDS = 60

// ── 검증 정본(zod) ───────────────────────────────────────────────────────────
// 비밀번호 정책: 최소 8자 + 영문 + 숫자 포함(그 외 문자 제한 없음) — 정규식은 명단 업로드 공통
// 비밀번호와 공유하는 lib/auth/password-policy.ts. schemas.ts류와 동일하게 메시지는 하드코딩
// 한국어(이 프로젝트의 zod 스키마 관행 — lib/apply/schemas.ts 참조, 화면 라벨만 next-intl로 옮기고
// 검증 메시지는 스키마에 둔다).

export const SignupFormSchema = z
  .object({
    // "organizer" 등 그 외 값은 애초에 리터럴 유니온에 없어 타입상 대입이 불가하다(운영자 계열
    // 가입 경로 없음 요구사항을 타입으로 고정 — signup-form.test.tsx가 컴파일 타임에 검증).
    role: z.enum(["buyer", "exhibitor"], { message: "가입 유형을 선택해주세요." }),
    orgNameKo: z.string().trim().min(1, "기업명(국문)을 입력해주세요."),
    orgNameEn: z.string().trim(),
    name: z.string().trim().min(1, "담당자 이름을 입력해주세요."),
    email: z.string().trim().min(1, "이메일을 입력해주세요.").email("올바른 이메일 형식이 아니에요."),
    password: z
      .string()
      .min(1, "비밀번호를 입력해주세요.")
      .regex(PASSWORD_POLICY, "비밀번호는 8자 이상, 영문과 숫자를 포함해야 해요.")
      .refine((value) => !exceedsPasswordByteLimit(value), {
        message: `비밀번호는 최대 ${PASSWORD_MAX_BYTES}바이트(UTF-8 기준)까지 가능해요.`,
      }),
    passwordConfirm: z.string(),
    phone: z.string().trim(),
    termsAgreed: z.boolean(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "비밀번호가 일치하지 않아요.",
    path: ["passwordConfirm"],
  })
  .refine((data) => data.termsAgreed === true, {
    message: "약관에 동의해야 가입할 수 있어요.",
    path: ["termsAgreed"],
  })

// RHF 폼 값 — role은 미선택 초기상태를 표현하려고 ""을 함께 허용한다(zod enum이 ""을 거부해
// "선택 안 함"을 자연스럽게 필수 오류로 잡아준다). SignupInput(seam, lib/auth/signup-client.ts)과는
// role의 선택형이라는 점만 다르고 나머지는 1:1 대응.
export interface SignupFormValues {
  role: SignupRole | ""
  orgNameKo: string
  orgNameEn: string
  name: string
  email: string
  password: string
  passwordConfirm: string
  phone: string
  termsAgreed: boolean
}

function emptyValues(): SignupFormValues {
  return {
    role: "",
    orgNameKo: "",
    orgNameEn: "",
    name: "",
    email: "",
    password: "",
    passwordConfirm: "",
    phone: "",
    termsAgreed: false,
  }
}

// 필드별 첫 오류 메시지 — apply-form.tsx의 missingOf와 동형(safeParse → path[0] 키로 집계).
function fieldErrorsOf(values: SignupFormValues): Partial<Record<keyof SignupFormValues, string>> {
  const result = SignupFormSchema.safeParse(values)
  if (result.success) return {}
  const errors: Partial<Record<keyof SignupFormValues, string>> = {}
  for (const issue of result.error.issues) {
    const key = String(issue.path[0]) as keyof SignupFormValues
    if (!(key in errors)) errors[key] = issue.message
  }
  return errors
}

const EMPTY_ERRORS: Partial<Record<keyof SignupFormValues, string>> = {}
// 가입 시 표시할 필수 약관 — 로그인 최초진입 약관 동의(mock-auth-client의 CONSENT_DOCUMENTS)를
// 재사용한다(문구 이중화 방지). marketing(선택)은 가입 단계에선 노출하지 않는다.
const REQUIRED_TERMS = CONSENT_DOCUMENTS.filter((d) => d.required)

export interface SignupFormProps {
  // 인증 경계 주입(테스트용). 기본은 mock — 실연동 시 HTTP 구현으로 스왑.
  client?: SignupClient
}

export function SignupForm({ client = defaultSignupClient }: SignupFormProps) {
  const t = useTranslations("signup")
  const tc = useTranslations("common")
  const [succeeded, setSucceeded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverFieldErrors, setServerFieldErrors] = useState<
    Partial<Record<keyof SignupFormValues, string>>
  >(EMPTY_ERRORS)

  // ── 이메일 실존 인증(#9) — 가입 중 코드 확인 ──────────────────────────────────
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null)
  const [verificationToken, setVerificationToken] = useState<string | null>(null)
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCode] = useState("")
  const [sendingCode, setSendingCode] = useState(false)
  const [verifyingCode, setVerifyingCode] = useState(false)
  const [sendCodeError, setSendCodeError] = useState<string | null>(null)
  const [verifyCodeError, setVerifyCodeError] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)

  const form = useForm<SignupFormValues>({ defaultValues: emptyValues() })
  // RHF watch()는 React Compiler가 메모이제이션을 스킵한다(구독 기반 API) — apply-form.tsx와 동일.
  // eslint-disable-next-line react-hooks/incompatible-library
  const values = form.watch()
  const clientErrors = showErrors ? fieldErrorsOf(values) : EMPTY_ERRORS
  const errors = { ...clientErrors, ...serverFieldErrors }
  const emailVerified = verifiedEmail !== null && verifiedEmail === values.email

  // 인증 완료 후 이메일을 고치면 인증 상태를 리셋한다(요구사항 8 — "잠금, 수정하면 인증 리셋").
  useEffect(() => {
    if (verifiedEmail !== null && values.email !== verifiedEmail) {
      setVerifiedEmail(null)
      setVerificationToken(null)
      setCodeSent(false)
      setCode("")
      setVerifyCodeError(null)
      setResendCooldown(0) // 다른(새) 수신자로 바뀌었으니 이전 발송의 쿨다운을 그대로 물려받지 않는다
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.email])

  useEffect(() => {
    if (resendCooldown <= 0) return
    const id = setInterval(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(id)
  }, [resendCooldown])

  async function handleSendCode() {
    const emailCheck = z.string().trim().min(1).email().safeParse(values.email)
    if (!emailCheck.success) {
      setShowErrors(true)
      return
    }
    setSendingCode(true)
    setSendCodeError(null)
    const res = await client.requestEmailCode(values.email)
    setSendingCode(false)
    if (res.outcome === "sent") {
      setCodeSent(true)
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      return
    }
    setSendCodeError(
      res.outcome === "rate_limited" ? t("errorSendCodeRateLimited") : t("errorSendCodeInvalidEmail")
    )
  }

  async function handleVerifyCode() {
    if (!code) return
    setVerifyingCode(true)
    setVerifyCodeError(null)
    const res = await client.verifyEmailCode(values.email, code)
    setVerifyingCode(false)
    if (res.outcome === "verified") {
      setVerifiedEmail(values.email)
      setVerificationToken(res.token)
      return
    }
    setVerifyCodeError(t("errorVerifyCodeInvalid"))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const current = form.getValues()
    const parsed = SignupFormSchema.safeParse(current)
    if (!parsed.success) {
      setShowErrors(true)
      setServerFieldErrors(EMPTY_ERRORS)
      return
    }
    if (!emailVerified || !verificationToken) {
      setServerError(t("errorEmailNotVerified"))
      return
    }
    setBusy(true)
    setServerError(null)
    setServerFieldErrors(EMPTY_ERRORS)
    const res = await client.signup({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      phone: parsed.data.phone || undefined,
      orgNameKo: parsed.data.orgNameKo,
      orgNameEn: parsed.data.orgNameEn || undefined,
      role: parsed.data.role,
      emailVerificationToken: verificationToken,
    })
    setBusy(false)
    if (res.outcome === "succeeded") {
      setSucceeded(true)
      return
    }
    if (res.outcome === "email_taken") {
      setServerError(t("errorEmailTaken"))
      return
    }
    if (res.outcome === "verification_invalid") {
      // 토큰이 소진/만료된 사이 다른 탭 등에서 재사용됐을 수 있다 — 인증을 다시 받게 한다.
      setVerifiedEmail(null)
      setVerificationToken(null)
      setCodeSent(false)
      setServerError(t("errorVerificationInvalid"))
      return
    }
    // validation_error(422) — 백엔드가 되돌린 필드별 오류를 인라인으로 노출.
    setShowErrors(true)
    setServerFieldErrors(res.fieldErrors as Partial<Record<keyof SignupFormValues, string>>)
    setServerError(t("errorGeneric"))
  }

  if (succeeded) {
    return <SuccessScreen t={t} />
  }

  // 버튼 자체를 disabled로 막지는 않는다 — 그러면 다른 필드가 빈 채로 눌렀을 때 인라인 검증
  // 오류를 보여줄 기회가 사라진다(zod 오류를 먼저 보여주는 게 사용자에게 더 유용). "인증 완료
  // 전엔 제출 불가"는 handleSubmit 안의 이메일 인증 체크가 실제로 막는다(errorEmailNotVerified).
  const canSubmit = !busy

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <RoleField control={form.control} tc={tc} label={t("roleFieldLabel")} error={errors.role} />

        <TextInput
          id="signup-org-ko"
          label={t("orgNameKoLabel")}
          placeholder={t("orgNameKoPlaceholder")}
          error={errors.orgNameKo}
          inputProps={form.register("orgNameKo")}
        />
        <TextInput
          id="signup-org-en"
          label={t("orgNameEnLabel")}
          placeholder={t("orgNameEnPlaceholder")}
          error={errors.orgNameEn}
          inputProps={form.register("orgNameEn")}
        />
        <TextInput
          id="signup-name"
          label={t("nameLabel")}
          placeholder={t("namePlaceholder")}
          error={errors.name}
          inputProps={form.register("name")}
        />
        <EmailVerificationField
          t={t}
          registerEmail={form.register("email")}
          emailVerified={emailVerified}
          error={errors.email}
          codeSent={codeSent}
          code={code}
          onCodeChange={setCode}
          sendingCode={sendingCode}
          verifyingCode={verifyingCode}
          resendCooldown={resendCooldown}
          sendCodeError={sendCodeError}
          verifyCodeError={verifyCodeError}
          onSendCode={handleSendCode}
          onVerifyCode={handleVerifyCode}
        />
        <TextInput
          id="signup-password"
          label={t("passwordLabel")}
          type="password"
          hint={!errors.password ? t("passwordHint") : undefined}
          error={errors.password}
          inputProps={{ ...form.register("password"), autoComplete: "new-password" }}
        />
        <TextInput
          id="signup-password-confirm"
          label={t("passwordConfirmLabel")}
          type="password"
          error={errors.passwordConfirm}
          inputProps={{ ...form.register("passwordConfirm"), autoComplete: "new-password" }}
        />
        <TextInput
          id="signup-phone"
          label={t("phoneLabel")}
          type="tel"
          placeholder={t("phonePlaceholder")}
          error={errors.phone}
          inputProps={{ ...form.register("phone"), autoComplete: "tel" }}
        />

        <TermsField
          control={form.control}
          label={t("termsRequiredLabel")}
          agreeLabel={t("termsAgreeLabel")}
          viewFullLabel={t("viewFull")}
          error={errors.termsAgreed}
        />

        {serverError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {serverError}
          </p>
        )}

        <Button type="submit" size="lg" className="mt-1 w-full" disabled={!canSubmit}>
          {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
          {busy ? t("submitting") : t("submit")}
        </Button>
      </form>
    </div>
  )
}

// ── 서브컴포넌트 ─────────────────────────────────────────────────────────────

function TextInput({
  id,
  label,
  type = "text",
  placeholder,
  hint,
  error,
  inputProps,
}: {
  id: string
  label: string
  type?: string
  placeholder?: string
  hint?: string
  error?: string
  inputProps: React.ComponentProps<typeof Input>
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        {...inputProps}
      />
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

// 이메일 필드 + 인증코드 발송·확인(#9). 인증 완료 전엔 SignupForm이 제출 버튼을 비활성 처리한다
// (canSubmit = emailVerified && verificationToken). 인증 완료 후 이메일은 읽기전용으로 잠그고,
// "변경" 버튼으로만 다시 편집을 열 수 있다 — 열리는 순간 상위(SignupForm의 useEffect)가 인증
// 상태를 리셋한다(email !== verifiedEmail).
function EmailVerificationField({
  t,
  registerEmail,
  emailVerified,
  error,
  codeSent,
  code,
  onCodeChange,
  sendingCode,
  verifyingCode,
  resendCooldown,
  sendCodeError,
  verifyCodeError,
  onSendCode,
  onVerifyCode,
}: {
  t: ReturnType<typeof useTranslations>
  registerEmail: UseFormRegisterReturn<"email">
  emailVerified: boolean
  error?: string
  codeSent: boolean
  code: string
  onCodeChange: (value: string) => void
  sendingCode: boolean
  verifyingCode: boolean
  resendCooldown: number
  sendCodeError: string | null
  verifyCodeError: string | null
  onSendCode: () => void
  onVerifyCode: () => void
}) {
  const [editingLockedEmail, setEditingLockedEmail] = useState(false)
  const locked = emailVerified && !editingLockedEmail

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="signup-email">{t("emailLabel")}</Label>
        {emailVerified && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="size-3.5" />
            {t("emailVerifiedBadge")}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          id="signup-email"
          type="email"
          placeholder={t("emailPlaceholder")}
          aria-invalid={Boolean(error)}
          readOnly={locked}
          {...registerEmail}
          autoComplete="email"
          className={cn(locked && "bg-muted text-muted-foreground")}
        />
        {locked ? (
          <Button type="button" variant="outline" onClick={() => setEditingLockedEmail(true)}>
            {t("emailChangeButton")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={onSendCode}
            disabled={sendingCode || resendCooldown > 0}
            className="shrink-0"
          >
            {sendingCode
              ? t("sendingCode")
              : resendCooldown > 0
                ? t("resendCodeButton", { seconds: resendCooldown })
                : t("sendCodeButton")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      {sendCodeError && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {sendCodeError}
        </p>
      )}

      {codeSent && !locked && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">{t("codeSentHint")}</p>
          <div className="flex gap-2">
            <Input
              id="signup-email-code"
              inputMode="numeric"
              maxLength={6}
              placeholder={t("codePlaceholder")}
              value={code}
              onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-label={t("codeFieldLabel")}
            />
            <Button
              type="button"
              onClick={onVerifyCode}
              disabled={verifyingCode || code.length !== 6}
              className="shrink-0"
            >
              {verifyingCode ? t("verifyingCode") : t("verifyCodeButton")}
            </Button>
          </div>
          {verifyCodeError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {verifyCodeError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function RoleField({
  control,
  tc,
  label,
  error,
}: {
  control: Control<SignupFormValues>
  tc: ReturnType<typeof useTranslations>
  label: string
  error?: string
}) {
  const { field } = useController({ control, name: "role" })
  const options: { code: SignupRole; label: string }[] = [
    { code: "buyer", label: tc("roleBuyer") },
    { code: "exhibitor", label: tc("roleExhibitor") },
  ]
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => {
          const active = field.value === o.code
          return (
            <button
              key={o.code}
              type="button"
              aria-pressed={active}
              onClick={() => field.onChange(o.code)}
              className={cn(
                "rounded-lg border px-3.5 py-3 text-left text-sm font-semibold transition-colors",
                active
                  ? "border-primary bg-accent/50"
                  : "border-input bg-background hover:bg-muted"
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function TermsField({
  control,
  label,
  agreeLabel,
  viewFullLabel,
  error,
}: {
  control: Control<SignupFormValues>
  label: string
  agreeLabel: string
  viewFullLabel: string
  error?: string
}) {
  const { field } = useController({ control, name: "termsAgreed" })
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
        <p className="mb-1.5 text-xs font-semibold text-foreground/70">{label}</p>
        <ul className="flex flex-col gap-1">
          {REQUIRED_TERMS.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-muted-foreground">{doc.title}</span>
              <TermsDocSheet doc={doc} triggerLabel={viewFullLabel} />
            </li>
          ))}
        </ul>
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={field.value}
          onChange={(e) => field.onChange(e.target.checked)}
          onBlur={field.onBlur}
          aria-invalid={Boolean(error)}
          className="mt-0.5 size-4 shrink-0 rounded border-input accent-foreground"
        />
        <span>{agreeLabel}</span>
      </label>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

// 약관 전문 — 로그인 ConsentDocSheet와 동일 UX(하단 바텀시트)지만 가입 단계는 단일 체크로
// 동의하므로 읽기 전용(동의 버튼 없음, 기본 X로 닫기).
function TermsDocSheet({
  doc,
  triggerLabel,
}: {
  doc: (typeof CONSENT_DOCUMENTS)[number]
  triggerLabel: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
      >
        {triggerLabel}
        <ChevronRight className="size-3.5" />
      </button>
      <SheetContent side="bottom" className="max-h-[85svh] gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle>{doc.title}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed text-muted-foreground">
          {doc.content}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SuccessScreen({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CheckCircle2 className="size-7" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{t("successTitle")}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("successBody")}</p>
      </div>
      <Button asChild size="lg" className="mt-1 w-full">
        <a href="/login">{t("goToLogin")}</a>
      </Button>
    </div>
  )
}
