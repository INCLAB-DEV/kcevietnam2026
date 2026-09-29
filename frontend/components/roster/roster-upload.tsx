"use client"

// 명단 업로드 — 두 콘솔(/admin/organizations "기업 관리", /organizer/members "참가기업 관리")이 쓰는
// **유일한** 업로드 버튼·다이얼로그다. 예전엔 콘솔마다 다이얼로그·클라이언트·BFF·템플릿이 따로 있어
// 서로 어긋났다(어드민 템플릿의 name_ko 헤더를 백엔드가 몰라 업로드가 전부 400으로 거부됨, 2026-09-16).
//
// 흐름: 템플릿 다운로드 → 파일 선택 → 공통 비밀번호(선택) → 미리보기(dry_run, 저장 안 됨) → 적용 →
// 행별 결과 → 목록 새로고침(router.refresh). 파일·비밀번호를 바꾸면 미리보기를 다시 해야 적용할 수 있다.
// 권한·관할의 권위는 백엔드(이 행사의 master·sub, sub는 자기 바이어만)라 버튼은 쓰기 가능한 운영자에게
// 똑같이 노출하고, 거부 사유는 행별 결과로 보여준다.
//
// 공통 비밀번호는 요청 본문으로만 보낸다(lib/roster/upload.ts) — 화면 상태 밖으로 저장하지 않는다.

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Download, Eye, EyeOff, Loader2, Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { download } from "@/components/admin/shared"
import { isValidPassword } from "@/lib/auth/password-policy"
import {
  ROSTER_TEMPLATE_FILENAME,
  ROSTER_TEMPLATE_HEADERS,
  isTemplateExampleEmail,
  rosterTemplateCsv,
} from "@/lib/roster/template"
import type { RosterImportReport, RosterImportRow } from "@/lib/roster/types"
import { uploadRoster } from "@/lib/roster/upload"

type Phase = "idle" | "previewing" | "previewed" | "applying" | "applied"

// 트리거 버튼 + 다이얼로그. 다이얼로그 본문(라우터 사용)은 열렸을 때만 마운트한다 — 닫으면 입력(비밀번호
// 포함)이 통째로 사라지고, 다시 열면 새 흐름으로 시작한다.
export function RosterUploadButton({ eventId }: { eventId?: string }) {
  const t = useTranslations("rosterUpload")
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Upload data-icon="inline-start" />
        {t("trigger")}
      </Button>
      {open && <RosterUploadDialog open onOpenChange={setOpen} eventId={eventId} />}
    </>
  )
}

export function RosterUploadDialog({
  open,
  onOpenChange,
  eventId,
  onApplied,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 어드민 콘솔은 선택된 행사를 넘긴다. 생략하면 BFF가 운영자의 첫 행사로 정한다.
  eventId?: string
  onApplied?: (report: RosterImportReport) => void
}) {
  const t = useTranslations("rosterUpload")
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [report, setReport] = useState<RosterImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = phase === "previewing" || phase === "applying"
  const policyError = password.length > 0 && !isValidPassword(password)
  const mismatch = password !== passwordConfirm
  const passwordReady = !policyError && !mismatch

  // 입력이 바뀌면 이전 미리보기·결과는 더 이상 이 입력을 설명하지 못한다 — 처음부터 다시.
  // (요청 중에는 입력을 잠가, 응답이 바뀐 입력의 미리보기처럼 보이는 경합을 막는다.)
  function resetResult() {
    setPhase("idle")
    setReport(null)
    setError(null)
  }

  function errorMessage(code: string): string {
    if (/^[A-Za-z0-9_]+$/.test(code) && t.has(`error.${code}`)) return t(`error.${code}`)
    if (code === "http_401") return t("error.no_session")
    if (code === "http_403") return t("error.forbidden")
    return t("error.generic", { message: code })
  }

  async function run(dryRun: boolean) {
    setAttempted(true)
    if (!file || !passwordReady || busy) return
    setError(null)
    setPhase(dryRun ? "previewing" : "applying")
    const outcome = await uploadRoster({ file, eventId, password, dryRun })
    if (!outcome.success) {
      setPhase(dryRun ? "idle" : "previewed")
      setError(errorMessage(outcome.error))
      return
    }
    setReport(outcome.report)
    setPhase(dryRun ? "previewed" : "applied")
    if (!dryRun) {
      onApplied?.(outcome.report)
      router.refresh() // 서버 컴포넌트가 새 명단을 다시 내려준다(두 콘솔 공통)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-5">
          {/* 1. 템플릿 */}
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{t("templateHeading")}</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => download(ROSTER_TEMPLATE_FILENAME, rosterTemplateCsv(), "text/csv;charset=utf-8")}
              >
                <Download data-icon="inline-start" />
                {t("downloadTemplate")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("templateHint")}</p>
            <ul className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              {ROSTER_TEMPLATE_HEADERS.map((column) => (
                <li key={column} className="min-w-0">
                  <code className="text-foreground">{column}</code> — {t(`columns.${column}`)}
                </li>
              ))}
            </ul>
          </section>

          {/* 2. 파일 */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("fileHeading")}</h3>
            <Label htmlFor="roster-upload-file" className="sr-only">
              {t("fileLabel")}
            </Label>
            {/* 네이티브 파일 input은 디자인 토큰과 안 맞아 숨기고, 버튼+파일명으로 대체 */}
            <input
              ref={inputRef}
              id="roster-upload-file"
              type="file"
              accept=".csv,text/csv,.xlsx"
              className="sr-only"
              onChange={(e) => {
                const next = e.target.files?.[0]
                if (next) {
                  setFile(next)
                  resetResult()
                }
                e.target.value = "" // 같은 파일 재선택도 다시 트리거되게 초기화
              }}
            />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                {t("chooseFile")}
              </Button>
              <span className="min-w-0 truncate text-sm text-muted-foreground">{file?.name ?? t("noFile")}</span>
            </div>
          </section>

          {/* 3. 공통 비밀번호 */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("passwordHeading")}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="roster-upload-password">{t("passwordLabel")}</Label>
                <div className="relative">
                  <Input
                    id="roster-upload-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    disabled={busy}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={attempted && policyError}
                    className="pr-8"
                    onChange={(e) => {
                      setPassword(e.target.value)
                      resetResult()
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute inset-y-0 right-0 h-full w-8 text-muted-foreground hover:bg-transparent hover:text-foreground"
                    aria-label={showPassword ? t("hidePasswordAria") : t("showPasswordAria")}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="roster-upload-password-confirm">{t("passwordConfirmLabel")}</Label>
                <Input
                  id="roster-upload-password-confirm"
                  type={showPassword ? "text" : "password"}
                  value={passwordConfirm}
                  disabled={busy}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={attempted && mismatch}
                  onChange={(e) => {
                    setPasswordConfirm(e.target.value)
                    resetResult()
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
            {password.length === 0 && (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{t("passwordEmptyWarning")}</p>
            )}
            {attempted && policyError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("passwordPolicyError")}
              </p>
            )}
            {attempted && !policyError && mismatch && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("passwordMismatch")}
              </p>
            )}
          </section>

          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {report && <RosterReportPanel report={report} applied={phase === "applied"} />}
        </div>

        <DialogFooter className="flex-wrap justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
          <Button type="button" variant="outline" disabled={!file || busy} onClick={() => void run(true)}>
            {phase === "previewing" && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {phase === "previewing" ? t("previewing") : t("preview")}
          </Button>
          <Button type="button" disabled={phase !== "previewed"} onClick={() => void run(false)}>
            {phase === "applying" && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {phase === "applying" ? t("applying") : t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const RESULT_BADGE: Record<RosterImportRow["result"], "default" | "secondary" | "outline" | "destructive"> = {
  added: "default",
  updated: "secondary",
  unchanged: "outline",
  skipped: "destructive",
}

// 주관사 전체 스냅샷은 수천 행일 수 있다 — 표는 이만큼만 그리되, 확인이 필요한 행(건너뜀·사유·로그인 불가)을
// 먼저 채워 넣어 잘리지 않게 한다.
export const MAX_VISIBLE_ROWS = 300

function needsAttention(row: RosterImportRow): boolean {
  return row.result === "skipped" || row.reason !== null || row.password === "missing"
}

function visibleRows(rows: RosterImportRow[]): RosterImportRow[] {
  if (rows.length <= MAX_VISIBLE_ROWS) return rows
  return [...rows.filter(needsAttention), ...rows.filter((row) => !needsAttention(row))]
    .slice(0, MAX_VISIBLE_ROWS)
    .sort((a, b) => (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER))
}

function RosterReportPanel({ report, applied }: { report: RosterImportReport; applied: boolean }) {
  const t = useTranslations("rosterUpload")
  const allRows = report.rows ?? []
  const rows = visibleRows(allRows)
  const accounts = report.accounts
  const exampleRows = allRows.filter((row) => row.result !== "skipped" && isTemplateExampleEmail(row.email)).length
  const reasonLabel = (reason: string) =>
    /^[a-z_]+$/.test(reason) && t.has(`reason.${reason}`) ? t(`reason.${reason}`) : reason
  const warningLabel = (reason: string) =>
    /^[a-z_]+$/.test(reason) && t.has(`warning.${reason}`) ? t(`warning.${reason}`) : reason

  return (
    <section aria-live="polite" className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <h3 className="text-sm font-semibold">{applied ? t("appliedTitle") : t("previewTitle")}</h3>
      <p className="text-sm">
        {t("summary", {
          added: report.added,
          updated: report.updated,
          unchanged: report.unchanged,
          skipped: report.skipped,
        })}
      </p>
      {accounts && (
        <p className="text-sm text-muted-foreground">
          {t(applied ? "accountsApplied" : "accountsPreview", {
            set: accounts.password_set,
            kept: accounts.password_kept,
            missing: accounts.password_missing,
            none: accounts.no_account,
          })}
        </p>
      )}
      {exampleRows > 0 && (
        <p role="alert" className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {t("exampleRowsWarning", { count: exampleRows })}
        </p>
      )}
      {!!report.warnings?.length && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {report.warnings.map((warning, index) => (
            <li key={index}>
              {warningLabel(warning.reason)} ·{" "}
              {warning.organizer_member_id ?? warning.organizer_member_ids?.join(", ") ?? warning.organization_id}
            </li>
          ))}
        </ul>
      )}
      {allRows.length > rows.length && (
        <p className="text-xs text-muted-foreground">
          {t("rowsTruncated", { shown: rows.length, total: allRows.length })}
        </p>
      )}
      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded-md border bg-background">
          <Table>
            <TableHeader>
              <TableRow className="[&>th]:h-9 [&>th]:px-2 [&>th]:text-xs">
                <TableHead className="w-12 text-right">{t("table.row")}</TableHead>
                <TableHead>{t("table.id")}</TableHead>
                <TableHead>{t("table.org")}</TableHead>
                <TableHead>{t("table.email")}</TableHead>
                <TableHead>{t("table.result")}</TableHead>
                <TableHead>{t("table.account")}</TableHead>
                <TableHead>{t("table.note")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&>tr>td]:px-2 [&>tr>td]:py-1.5 [&>tr>td]:text-xs">
              {rows.map((row, index) => (
                <TableRow key={`${row.row ?? "x"}-${row.organizer_member_id ?? ""}-${index}`}>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{row.row ?? "-"}</TableCell>
                  <TableCell className="max-w-28 truncate">{row.organizer_member_id ?? "-"}</TableCell>
                  <TableCell className="max-w-40 truncate">{row.org_name ?? "-"}</TableCell>
                  <TableCell className="max-w-48 truncate">{row.email ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant={RESULT_BADGE[row.result] ?? "outline"}>{t(`result.${row.result}`)}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t(`account.${row.account}`)}
                    {row.password && (
                      <span className={row.password === "missing" ? "block text-destructive" : "block text-muted-foreground"}>
                        {t(`password.${row.password}`)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="min-w-40 text-muted-foreground">{row.reason ? reasonLabel(row.reason) : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
