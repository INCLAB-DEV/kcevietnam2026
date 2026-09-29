"use client"

// 담당자 계정 비밀번호 입력 — 두 운영자 콘솔(/organizer/members "참가기업 관리",
// /admin/organizations "기업 관리")이 함께 쓰는 **유일한** 비밀번호 UI다. components/roster
// (명단 업로드)와 같은 이유로 공용 모듈로 둔다 — 콘솔마다 따로 만들면 규칙·문구가 갈라진다.
//
// 두 쓰임새:
//  1. 단건 등록 폼 안의 선택 입력(비우면 비밀번호 없이 등록 — 그 계정은 로그인 불가)
//  2. 등록 이후 비밀번호 설정/재설정 다이얼로그(필수 입력)
//
// 규칙은 lib/auth/password-policy.ts(백엔드 app.auth.credentials의 화면용 사본) 하나만 본다.
// 여기서 정책을 새로 만들지 않는다 — 최종 판정은 서버가 한다. 확인 입력을 두 번 받아 오타로
// 로그인 불가 계정이 만들어지는 걸 막는다.
//
// ⚠ 평문은 이 컴포넌트의 state 밖으로 나가지 않는다 — 부모에게 제출 시점에 한 번 넘길 뿐,
// 저장·로그·URL 어디에도 싣지 않는다. 다이얼로그를 닫으면 입력이 통째로 사라진다.

import { useState, type FormEvent } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, isValidPassword } from "@/lib/auth/password-policy"

export const PASSWORD_POLICY_HINT = `최소 ${PASSWORD_MIN_LENGTH}자, 영문과 숫자를 포함해야 합니다(최대 ${PASSWORD_MAX_BYTES}바이트, 한글·이모지는 바이트를 더 씁니다).`
export const PASSWORD_POLICY_ERROR_TEXT = `비밀번호가 정책에 맞지 않아요 — ${PASSWORD_POLICY_HINT}`
export const PASSWORD_MISMATCH_TEXT = "두 비밀번호가 서로 달라요."
export const PASSWORD_REQUIRED_TEXT = "비밀번호를 입력해 주세요."

export interface PasswordPairState {
  empty: boolean
  policyError: boolean
  mismatch: boolean
  ready: boolean // 제출해도 되는 상태인가(선택 입력이면 "비어 있음"도 통과)
}

/** 두 입력의 상태 판정 — 순수 함수(화면 밖에서도 그대로 검증할 수 있게 분리). */
export function checkPasswordPair(
  password: string,
  confirm: string,
  { required }: { required: boolean },
): PasswordPairState {
  const empty = password.length === 0 && confirm.length === 0
  if (empty) {
    return { empty, policyError: false, mismatch: false, ready: !required }
  }
  const policyError = !isValidPassword(password)
  const mismatch = password !== confirm
  return { empty, policyError, mismatch, ready: !policyError && !mismatch }
}

/** 비밀번호 + 확인 두 칸(+ 보기 토글 + 오류 안내). ``attempted`` 전에는 오류를 띄우지 않는다. */
export function ContactPasswordFields({
  idPrefix,
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  disabled = false,
  attempted,
  required,
  label = "비밀번호",
  hint,
}: {
  idPrefix: string
  password: string
  confirm: string
  onPasswordChange: (value: string) => void
  onConfirmChange: (value: string) => void
  disabled?: boolean
  attempted: boolean
  required: boolean
  label?: string
  hint?: string
}) {
  const [show, setShow] = useState(false)
  const state = checkPasswordPair(password, confirm, { required })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-password`}>{label}</Label>
          <div className="relative">
            <Input
              id={`${idPrefix}-password`}
              type={show ? "text" : "password"}
              value={password}
              disabled={disabled}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={attempted && (state.policyError || (required && state.empty))}
              className="pr-8"
              onChange={(e) => onPasswordChange(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-y-0 right-0 h-full w-8 text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label={show ? "비밀번호 숨기기" : "비밀번호 보기"}
              onClick={() => setShow((v) => !v)}
            >
              {show ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-password-confirm`}>{label} 확인</Label>
          <Input
            id={`${idPrefix}-password-confirm`}
            type={show ? "text" : "password"}
            value={confirm}
            disabled={disabled}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={attempted && state.mismatch}
            onChange={(e) => onConfirmChange(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{hint ?? PASSWORD_POLICY_HINT}</p>
      {attempted && required && state.empty && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {PASSWORD_REQUIRED_TEXT}
        </p>
      )}
      {attempted && state.policyError && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {PASSWORD_POLICY_ERROR_TEXT}
        </p>
      )}
      {attempted && !state.policyError && state.mismatch && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {PASSWORD_MISMATCH_TEXT}
        </p>
      )}
    </div>
  )
}

/**
 * 등록 이후 비밀번호 설정/재설정 다이얼로그.
 *
 * ``onSubmit``은 성공 여부를 돌려준다 — 성공이면 닫고 입력을 비우고, 실패면 열어둔 채 둔다
 * (호출부가 토스트로 사유를 알린다. 실패를 성공처럼 닫아버리면 "바꿨는데 로그인이 안 된다"가 된다).
 */
export function ContactPasswordDialog({
  open,
  onOpenChange,
  orgName,
  contactEmail,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgName: string
  contactEmail?: string | null
  onSubmit: (password: string) => Promise<boolean>
}) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)

  function reset() {
    setPassword("")
    setConfirm("")
    setAttempted(false)
    setBusy(false)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setAttempted(true)
    if (busy) return
    if (!checkPasswordPair(password, confirm, { required: true }).ready) return
    setBusy(true)
    // onSubmit(호출부의 setOrganizationContactPassword/setMemberPassword)은 대체로 fetch 예외를
    // 삼키고 {success:false}로 돌려주지만, 그 경계를 여기서도 지켜야 한다 — throw 하나라도 새면
    // setBusy(false)를 건너뛰어 다이얼로그가 "저장 중"에 영구히 멈추고 재시도가 막힌다(finally로
    // 무조건 풀어준다).
    try {
      const ok = await onSubmit(password)
      if (!ok) return
      reset()
      onOpenChange(false)
    } catch {
      toast.error("비밀번호 저장 중 오류가 발생했어요", {
        description: "네트워크 상태를 확인하고 다시 시도해 주세요.",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>비밀번호 설정</DialogTitle>
          <DialogDescription>
            {`'${orgName}' 담당자 계정의 로그인 비밀번호를 새로 정합니다.`}
            {contactEmail ? ` (${contactEmail})` : ""}
            {" 기존 비밀번호는 즉시 무효가 되고, 새 비밀번호는 화면에 다시 표시되지 않습니다."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3 px-5">
            <ContactPasswordFields
              idPrefix="contact-pw"
              password={password}
              confirm={confirm}
              onPasswordChange={setPassword}
              onConfirmChange={setConfirm}
              disabled={busy}
              attempted={attempted}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {busy ? "저장 중" : "저장"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
