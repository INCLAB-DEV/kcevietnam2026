"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Lock, ShieldAlert, Trash2, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  canRevoke,
  grantServerErrorMessage,
  MASTER_GRANT_NOTICE,
  ORGANIZER_ERROR_MESSAGES,
  SUB_GRANT_CAPABILITY_NOTICE,
  sortOrganizers,
  validateOrganizerGrant,
} from "@/lib/admin/organizers"
import { grantSubAdmin, revokeOrganizer } from "@/lib/admin/admin-actions"
import { ADMIN_PERMISSION_LABELS, type AdminOrganizer } from "@/lib/admin/types"
import { TextField, formatDateTime } from "./shared"

// 운영자(회원 역할) 관리 — 이 행사의 운영자 목록 + 서브어드민 부여·회수.
//
// 권한 정책: **슈퍼어드민(master)은 DB에서만 부여한다.** 이 화면에는 부여 경로가 없고, master 행은
// 참조용으로 보이되 회수 버튼도 뜨지 않는다(lib/admin/organizers). 정책 문구를 상단에 상시 노출해
// 운영자가 "왜 master를 못 만드나"를 화면에서 바로 알 수 있게 한다.
//
// 부여·회수는 **서버 확정 후에만** 목록에 반영한다(2026-09-17). 예전엔 회원 UUID를 입력받아 행을
// 먼저 그려 놓고(낙관적) 서버 실패는 토스트만 띄워, 없는 회원·중복 부여가 유령 행으로 남았고 지어낸
// 행 id로는 곧바로 회수도 안 됐다. 이제 대상은 로그인 이메일이고, 행은 서버 응답(배정 id·실명·이메일)으로만
// 추가한다.

export function OrganizersConsole({
  organizers: initial,
  eventId,
  timeZone,
  readOnly,
}: {
  organizers: AdminOrganizer[]
  eventId: string
  timeZone: string
  readOnly: boolean
}) {
  const [rows, setRows] = useState<AdminOrganizer[]>(() => sortOrganizers(initial))
  const [granting, setGranting] = useState(false)
  const [revoking, setRevoking] = useState<AdminOrganizer | null>(null)
  const [revokePending, setRevokePending] = useState(false)

  const masters = rows.filter((o) => o.permission_level === "master").length
  const subs = rows.filter((o) => o.permission_level === "sub").length

  // 부여 — 입력 검증 → 서버 확정 → 응답 행으로만 목록 반영. 실패면 행을 만들지 않고 다이얼로그를 남긴다
  // (false 반환 — 입력을 고쳐 다시 시도할 수 있게).
  async function grant(emailInput: string): Promise<boolean> {
    // level은 "sub" 고정 — 이 화면에서 master를 만들 방법 자체를 두지 않는다.
    const check = validateOrganizerGrant(emailInput, "sub", rows)
    if (!check.valid) {
      toast.error("서브어드민을 부여하지 못했어요", {
        description: check.errors.map((c) => ORGANIZER_ERROR_MESSAGES[c]).join(" "),
      })
      return false
    }

    const result = await grantSubAdmin(eventId, check.email)
    if (!result.success || !result.organizer) {
      toast.error("서브어드민을 부여하지 못했어요", {
        description: grantServerErrorMessage(result.error),
      })
      return false
    }
    const created = result.organizer
    setRows((prev) => sortOrganizers([...prev.filter((o) => o.id !== created.id), created]))
    toast(`'${created.name}'(${created.email || check.email})에게 서브어드민 권한을 부여했어요`, {
      description: SUB_GRANT_CAPABILITY_NOTICE,
    })
    return true
  }

  // 회수 — 서버가 확정한 뒤에만 목록에서 뺀다. 실패하면 행을 그대로 두고 알린다(사라진 척하지 않는다).
  async function confirmRevoke() {
    if (!revoking || revokePending) return
    const target = revoking
    if (!canRevoke(target)) {
      toast.error("회수할 수 없는 권한입니다", { description: MASTER_GRANT_NOTICE })
      setRevoking(null)
      return
    }
    setRevokePending(true)
    const result = await revokeOrganizer(eventId, target.id)
    setRevokePending(false)
    if (!result.success) {
      toast.error(`'${target.name}'의 권한을 회수하지 못했어요`, {
        description: "잠시 후 다시 시도해 주세요. 목록은 바뀌지 않았습니다.",
      })
      return
    }
    setRows((prev) => prev.filter((o) => o.id !== target.id))
    setRevoking(null)
    toast(`'${target.name}'의 서브어드민 권한을 회수했어요`)
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Alert>
        <Lock />
        <AlertTitle>권한 부여 정책</AlertTitle>
        <AlertDescription>{MASTER_GRANT_NOTICE}</AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          슈퍼어드민 {masters}명 · 서브어드민 {subs}명
        </span>
        {!readOnly && (
          <Button size="sm" onClick={() => setGranting(true)}>
            <UserPlus data-icon="inline-start" />
            서브어드민 부여
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
              <TableHead>이름</TableHead>
              <TableHead>이메일</TableHead>
              <TableHead>권한</TableHead>
              <TableHead>관할</TableHead>
              <TableHead>부여 시각</TableHead>
              <TableHead className="w-20" aria-label="작업" />
            </TableRow>
          </TableHeader>
          <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.email || "-"}</TableCell>
                <TableCell>
                  <Badge
                    variant={row.permission_level === "master" ? "default" : "outline"}
                    className="gap-1"
                  >
                    {row.permission_level === "master" && <ShieldAlert className="size-3" />}
                    {ADMIN_PERMISSION_LABELS[row.permission_level]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.trade_office ?? "-"}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatDateTime(row.granted_at, timeZone)}
                </TableCell>
                <TableCell>
                  {/* master 행에는 회수 버튼을 아예 렌더하지 않는다 — DB 소관이다. */}
                  {!readOnly && canRevoke(row) ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${row.name} 권한 회수`}
                      onClick={() => setRevoking(row)}
                    >
                      <Trash2 />
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <GrantDialog open={granting} onOpenChange={setGranting} onSubmit={grant} />

      <Dialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>서브어드민 권한 회수</DialogTitle>
            <DialogDescription>
              {revoking ? `'${revoking.name}'의 서브어드민 권한을 회수합니다. ` : ""}
              회수 후에는 이 행사의 관리자 콘솔에 접근할 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">취소</Button>
            </DialogClose>
            <Button variant="destructive" disabled={revokePending} onClick={() => void confirmRevoke()}>
              {revokePending ? "회수 중…" : "회수"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function GrantDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (email: string) => Promise<boolean>
}) {
  const [email, setEmail] = useState("")
  const [pending, setPending] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return // 서버 응답 전엔 닫지 않는다 — 결과를 못 보고 창이 사라지면 성공으로 오해한다.
        if (!o) setEmail("")
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>서브어드민 부여</DialogTitle>
          <DialogDescription>
            가입된 회원에게 이 행사의 서브어드민(관할 한정) 권한을 부여합니다. {MASTER_GRANT_NOTICE}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (pending) return
            setPending(true)
            const ok = await onSubmit(email)
            setPending(false)
            if (ok) {
              setEmail("")
              onOpenChange(false)
            }
          }}
        >
          <div className="flex flex-col gap-3 px-5">
            <TextField
              id="org-member-email"
              label="회원 이메일"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="예: trade.office@kotra.or.kr"
              hint="회원가입을 마친 계정의 로그인 이메일을 입력하세요. 부여 권한은 서브어드민으로 고정됩니다."
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                취소
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!email.trim() || pending}>
              {pending ? "부여 중…" : "서브어드민 부여"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
