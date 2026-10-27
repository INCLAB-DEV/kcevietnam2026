"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Check } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// F-MY-001 거절/취소 사유 다이얼로그 — 키워드 라디오 + 'other'면 자유입력 필수.
// 사유 어휘는 백엔드 계약(app/meetings/schemas.py)과 정확히 맞춘다: 거절=interest_mismatch/
// schedule_unavailable/other, 취소=schedule_conflict/counterpart_request/internal_change/other.
export type RejectReasonCode = "interest_mismatch" | "schedule_unavailable" | "other"
export type CancelReasonCode = "schedule_conflict" | "counterpart_request" | "internal_change" | "other"

const REJECT_CODES: RejectReasonCode[] = ["interest_mismatch", "schedule_unavailable", "other"]
const CANCEL_CODES: CancelReasonCode[] = [
  "schedule_conflict",
  "counterpart_request",
  "internal_change",
  "other",
]

interface MeetingReasonDialogProps {
  mode: "reject" | "cancel"
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (reasonCode: string, reasonText?: string) => void
  busy?: boolean
}

export function MeetingReasonDialog({ mode, open, onOpenChange, onSubmit, busy = false }: MeetingReasonDialogProps) {
  const t = useTranslations("meeting.reasonDialog")
  const codes = mode === "reject" ? REJECT_CODES : CANCEL_CODES
  const [code, setCode] = useState<string | null>(null)
  const [text, setText] = useState("")

  const requiresText = code === "other"
  const canSubmit = Boolean(code) && (!requiresText || text.trim().length > 0) && !busy

  function reset() {
    setCode(null)
    setText("")
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function submit() {
    if (!canSubmit || !code) return
    onSubmit(code, text.trim() || undefined)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === "reject" ? t("rejectTitle") : t("cancelTitle")}</DialogTitle>
          <DialogDescription>{mode === "reject" ? t("rejectDescription") : t("cancelDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-2 overflow-y-auto px-5 py-2">
          {codes.map((c) => {
            const active = c === code
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setCode(c)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 rounded-lg border p-3 text-left text-sm font-medium break-words transition-colors",
                  active ? "border-primary bg-accent/50" : "bg-background hover:bg-muted"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background"
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 break-words">{t(reasonLabelKey(c))}</span>
              </button>
            )
          })}
        </div>

        {requiresText && (
          <div className="flex min-w-0 flex-col gap-1.5 px-5">
            <label htmlFor="meeting-reason-text" className="text-sm font-semibold">
              {t("reasonTextLabel")}
            </label>
            <Textarea
              id="meeting-reason-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("reasonTextPlaceholder")}
              rows={3}
              aria-invalid={requiresText && text.trim().length === 0}
              className="w-full"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            {t("cancelButton")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {mode === "reject" ? t("submitReject") : t("submitCancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function reasonLabelKey(code: string): string {
  switch (code) {
    case "interest_mismatch":
      return "reasonInterestMismatch"
    case "schedule_unavailable":
      return "reasonScheduleUnavailable"
    case "schedule_conflict":
      return "reasonScheduleConflict"
    case "counterpart_request":
      return "reasonCounterpartRequest"
    case "internal_change":
      return "reasonInternalChange"
    default:
      return "reasonOther"
  }
}
