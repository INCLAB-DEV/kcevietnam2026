"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  assignInterpreter,
  INTERPRETER_ERROR_MESSAGES,
  languageLabel,
  validateInterpreter,
  type InterpreterFormInput,
} from "@/lib/admin/interpreters"
import {
  createInterpreter,
  deleteInterpreter,
  patchInterpreter,
  setInterpreterAssignment,
} from "@/lib/admin/admin-actions"
import type { AdminInterpreter, AdminOrganization } from "@/lib/admin/types"
import { EmptyResult, TextField } from "./shared"

// 통역사 관리 — CRUD + 참가기업 배정(기업당 1명).
// 배정은 드롭다운에서 기업을 고르면 즉시 반영된다. 다른 통역사가 맡고 있던 기업을 고르면 그쪽
// 배정이 자동으로 풀린다(기업당 1명 불변식 — lib/admin/interpreters).

const NONE = "__none__"

export function InterpretersConsole({
  interpreters: initial,
  organizations,
  eventId,
  readOnly,
}: {
  interpreters: AdminInterpreter[]
  organizations: AdminOrganization[]
  eventId: string
  readOnly: boolean
}) {
  const [rows, setRows] = useState<AdminInterpreter[]>(initial)
  const [editing, setEditing] = useState<AdminInterpreter | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AdminInterpreter | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [newId, setNewId] = useState(0)

  function assign(interpreter: AdminInterpreter, orgId: string) {
    const target = orgId === NONE ? null : orgId
    const org = target ? (organizations.find((o) => o.id === target) ?? null) : null
    const displaced = target
      ? rows.find((i) => i.id !== interpreter.id && i.assigned_org_id === target)
      : undefined

    setRows((prev) => assignInterpreter(prev, interpreter.id, target, org?.name_ko ?? null))
    toast(
      target
        ? `'${interpreter.name}'을(를) '${org?.name_ko}'에 배정했어요`
        : `'${interpreter.name}' 배정을 해제했어요`,
      {
        description: displaced
          ? `기업당 1명 원칙에 따라 '${displaced.name}'의 배정이 해제됐습니다`
          : undefined,
      },
    )
    // 배정/해제는 계약이 비대칭이다(POST .../assign vs DELETE .../assign/{org_id}) —
    // 해제 경로가 기업 id를 요구하므로 직전 배정 기업을 함께 넘긴다.
    void setInterpreterAssignment(
      eventId,
      interpreter.id,
      target,
      interpreter.assigned_org_id,
    ).then((r) => {
      if (!r.success) toast.error("배정 저장에 실패했어요")
    })
  }

  function save(input: InterpreterFormInput, target: AdminInterpreter | null) {
    const check = validateInterpreter(input)
    if (!check.valid) {
      toast.error("입력을 확인해 주세요", {
        description: check.errors.map((c) => INTERPRETER_ERROR_MESSAGES[c]).join(" "),
      })
      return false
    }

    if (target) {
      const patch = {
        name: check.name,
        languages: check.languages,
        phone: check.phone,
        email: check.email,
      }
      setRows((prev) => prev.map((i) => (i.id === target.id ? { ...i, ...patch } : i)))
      toast(`'${check.name}' 정보를 수정했어요`)
      void patchInterpreter(eventId, target.id, patch)
    } else {
      const id = `adm-itp-new-${newId + 1}`
      setNewId((n) => n + 1)
      setRows((prev) => [
        ...prev,
        {
          id,
          event_id: eventId,
          name: check.name,
          languages: check.languages,
          phone: check.phone,
          email: check.email,
          assigned_org_id: null,
          assigned_org_name: null,
        },
      ])
      toast(`'${check.name}' 통역사를 등록했어요`)
      void createInterpreter(eventId, {
        name: check.name,
        languages: check.languages,
        phone: check.phone,
        email: check.email,
      })
    }
    return true
  }

  async function confirmDelete() {
    if (!deleting || deletingBusy) return
    const target = deleting
    setDeletingBusy(true)
    try {
      const result = await deleteInterpreter(eventId, target.id)
      if (!result.success) {
        toast.error("삭제에 실패했어요", { description: result.error ?? "다시 시도해 주세요" })
        return
      }
      setRows((prev) => prev.filter((i) => i.id !== target.id))
      setDeleting(null)
      toast(`'${target.name}'을(를) 삭제했어요`)
    } catch {
      toast.error("삭제에 실패했어요", { description: "연결을 확인하고 다시 시도해 주세요" })
    } finally {
      setDeletingBusy(false)
    }
  }

  const assignedCount = rows.filter((i) => i.assigned_org_id).length

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          통역사 {rows.length}명 · 배정 완료 {assignedCount}명
        </span>
        {!readOnly && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" />
            통역사 등록
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyResult
          title="등록된 통역사가 없습니다"
          description="통역사를 등록하면 참가기업에 배정할 수 있습니다."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[800px]">
            <TableHeader>
              <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                <TableHead>이름</TableHead>
                <TableHead>언어</TableHead>
                <TableHead>전화</TableHead>
                <TableHead>이메일</TableHead>
                <TableHead>배정 기업</TableHead>
                <TableHead className="w-28" aria-label="작업" />
              </TableRow>
            </TableHeader>
            <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="flex flex-wrap gap-1">
                      {row.languages.map((l) => (
                        <Badge key={l} variant="outline">
                          {languageLabel(l)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.phone ?? "-"}</TableCell>
                  <TableCell className="text-muted-foreground">{row.email ?? "-"}</TableCell>
                  <TableCell>
                    {readOnly ? (
                      <span className="text-sm text-muted-foreground">
                        {row.assigned_org_name ?? "미배정"}
                      </span>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="max-w-52">
                            <span className="truncate">{row.assigned_org_name ?? "미배정"}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                          <DropdownMenuRadioGroup
                            value={row.assigned_org_id ?? NONE}
                            onValueChange={(v) => assign(row, v)}
                          >
                            <DropdownMenuRadioItem value={NONE}>미배정</DropdownMenuRadioItem>
                            <DropdownMenuSeparator />
                            {organizations.map((o) => (
                              <DropdownMenuRadioItem key={o.id} value={o.id}>
                                {o.name_ko}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                  <TableCell>
                    {!readOnly && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => setEditing(row)}
                        >
                          수정
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${row.name} 삭제`}
                          onClick={() => setDeleting(row)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <InterpreterFormDialog
        key={editing?.id ?? "create"}
        open={!!editing || creating}
        target={editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setCreating(false)
          }
        }}
        onSubmit={(input) => save(input, editing)}
      />

      <Dialog open={!!deleting} onOpenChange={(open) => !open && !deletingBusy && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>통역사 삭제</DialogTitle>
            <DialogDescription>
              {deleting ? `'${deleting.name}'을(를) 삭제합니다. ` : ""}
              배정된 기업이 있으면 배정도 함께 해제되며 되돌릴 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deletingBusy}>취소</Button>
            </DialogClose>
            <Button variant="destructive" disabled={deletingBusy} onClick={() => void confirmDelete()}>
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InterpreterFormDialog({
  open,
  target,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  target: AdminInterpreter | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: InterpreterFormInput) => boolean
}) {
  const [form, setForm] = useState<InterpreterFormInput>({
    name: target?.name ?? "",
    languages: target?.languages.join(", ") ?? "",
    phone: target?.phone ?? "",
    email: target?.email ?? "",
  })

  const set = <K extends keyof InterpreterFormInput>(key: K, value: InterpreterFormInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? "통역사 수정" : "통역사 등록"}</DialogTitle>
          <DialogDescription>
            현장 연락이 닿아야 하므로 전화와 이메일 중 최소 하나는 입력해 주세요.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (onSubmit(form)) onOpenChange(false)
          }}
        >
          <div className="flex flex-col gap-3 px-5">
            <TextField
              id="itp-name"
              label="이름"
              value={form.name}
              onChange={(v) => set("name", v)}
            />
            <TextField
              id="itp-languages"
              label="담당 언어"
              value={form.languages}
              onChange={(v) => set("languages", v)}
              placeholder="영어, 베트남어"
              hint="쉼표로 구분"
            />
            <div className="flex flex-wrap gap-3">
              <TextField
                id="itp-phone"
                label="전화"
                value={form.phone}
                onChange={(v) => set("phone", v)}
              />
              <TextField
                id="itp-email"
                label="이메일"
                type="email"
                value={form.email}
                onChange={(v) => set("email", v)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">{target ? "저장" : "등록"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
