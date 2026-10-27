"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  groupByVenueType,
  VENUE_ERROR_MESSAGES,
  validateVenue,
  type VenueFormInput,
} from "@/lib/admin/venues"
import { createVenue, deleteVenue, renameVenue } from "@/lib/admin/admin-actions"
import { VENUE_TYPE_LABELS, type AdminVenue, type ManageableVenueType } from "@/lib/admin/types"
import { EmptyResult, TextField } from "./shared"

// 미팅 장소 관리 — 매칭존 테이블·비즈니스 룸을 유형별로 묶어 CRUD한다(부스는 미팅 신청 시
// 자동 생성돼 이 화면 대상이 아니다 — lib/admin/venues 참고).
//
// 라벨 충돌(409 VENUE_LABEL_TAKEN)·사용 중 삭제(409 VENUE_IN_USE)는 서버 응답을 확인한다.

const SECTIONS: ManageableVenueType[] = ["zone_table", "business_room"]

export function VenuesConsole({
  venues: initial,
  eventId,
  readOnly,
}: {
  venues: AdminVenue[]
  eventId: string
  readOnly: boolean
}) {
  const [rows, setRows] = useState<AdminVenue[]>(initial)
  const [creatingType, setCreatingType] = useState<ManageableVenueType | null>(null)
  const [editing, setEditing] = useState<AdminVenue | null>(null)
  const [deleting, setDeleting] = useState<AdminVenue | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [newId, setNewId] = useState(0)

  const grouped = groupByVenueType(rows)

  function save(input: VenueFormInput, target: AdminVenue | null) {
    const check = validateVenue(input, rows, target?.id)
    if (!check.valid) {
      toast.error("입력을 확인해 주세요", {
        description: check.errors.map((c) => VENUE_ERROR_MESSAGES[c]).join(" "),
      })
      return false
    }

    if (target) {
      const previousLabel = target.label
      setRows((prev) => prev.map((v) => (v.id === target.id ? { ...v, label: check.label } : v)))
      toast(`'${check.label}'(으)로 이름을 바꿨어요`)
      void renameVenue(eventId, target.id, check.label).then((r) => {
        if (r.success) return
        setRows((prev) => prev.map((v) => (v.id === target.id ? { ...v, label: previousLabel } : v)))
        toast.error(
          r.error === "VENUE_LABEL_TAKEN" ? "이미 같은 이름의 장소가 있어요" : "이름 변경에 실패했어요",
          { description: "원래 이름으로 되돌렸어요" },
        )
      })
    } else {
      const id = `adm-vn-new-${newId + 1}`
      setNewId((n) => n + 1)
      setRows((prev) => [
        ...prev,
        { id, event_id: eventId, venue_type: check.venue_type, label: check.label, meeting_count: 0 },
      ])
      toast(`'${check.label}' 장소를 추가했어요`)
      void createVenue(eventId, { venue_type: check.venue_type, label: check.label }).then((r) => {
        if (r.success) return
        setRows((prev) => prev.filter((v) => v.id !== id))
        toast.error(
          r.error === "VENUE_LABEL_TAKEN" ? "이미 같은 이름의 장소가 있어요" : "장소 추가에 실패했어요",
        )
      })
    }
    return true
  }

  async function confirmDelete() {
    if (!deleting || deletingBusy) return
    const target = deleting
    setDeletingBusy(true)
    try {
      const result = await deleteVenue(eventId, target.id)
      if (!result.success) {
        toast.error(
          result.error === "VENUE_IN_USE" ? "사용 중인 미팅이 있어 삭제하지 못했어요" : "삭제에 실패했어요",
          { description: result.error ?? "다시 시도해 주세요" },
        )
        return
      }
      setRows((prev) => prev.filter((v) => v.id !== target.id))
      setDeleting(null)
      toast(`'${target.label}'을(를) 삭제했어요`)
    } catch {
      toast.error("삭제에 실패했어요", { description: "연결을 확인하고 다시 시도해 주세요" })
    } finally {
      setDeletingBusy(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        label 순서가 곧 자동 배정 순서입니다 — 위에 있을수록 먼저 채워집니다.
      </p>

      {SECTIONS.map((type) => (
        <VenueSection
          key={type}
          type={type}
          rows={grouped[type]}
          readOnly={readOnly}
          onAdd={() => setCreatingType(type)}
          onEdit={setEditing}
          onDelete={setDeleting}
        />
      ))}

      <VenueFormDialog
        key={editing?.id ?? creatingType ?? "closed"}
        open={!!editing || !!creatingType}
        target={editing}
        venueType={editing?.venue_type ?? creatingType ?? "zone_table"}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setCreatingType(null)
          }
        }}
        onSubmit={(input) => save(input, editing)}
      />

      <Dialog open={!!deleting} onOpenChange={(open) => !open && !deletingBusy && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>장소 삭제</DialogTitle>
            <DialogDescription>
              {deleting ? `'${deleting.label}'을(를) 삭제합니다. ` : ""}
              되돌릴 수 없습니다.
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

function VenueSection({
  type,
  rows,
  readOnly,
  onAdd,
  onEdit,
  onDelete,
}: {
  type: ManageableVenueType
  rows: AdminVenue[]
  readOnly: boolean
  onAdd: () => void
  onEdit: (v: AdminVenue) => void
  onDelete: (v: AdminVenue) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {VENUE_TYPE_LABELS[type]} <span className="text-muted-foreground">· {rows.length}곳</span>
        </h3>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={onAdd} aria-label={`${VENUE_TYPE_LABELS[type]} 추가`}>
            <Plus data-icon="inline-start" />
            장소 추가
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyResult
          title={`등록된 ${VENUE_TYPE_LABELS[type]}이 없습니다`}
          description="장소를 추가하면 미팅 배정에 쓸 수 있습니다."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                <TableHead>이름</TableHead>
                <TableHead>배정된 미팅</TableHead>
                <TableHead className="w-28" aria-label="작업" />
              </TableRow>
            </TableHeader>
            <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className="text-muted-foreground">{row.meeting_count}건</TableCell>
                  <TableCell>
                    {!readOnly && (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="text-xs" onClick={() => onEdit(row)}>
                          이름변경
                        </Button>
                        {row.meeting_count > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span tabIndex={0}>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled
                                  aria-label={`${row.label} 삭제`}
                                >
                                  <Trash2 />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>사용 중인 미팅 {row.meeting_count}건</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${row.label} 삭제`}
                            onClick={() => onDelete(row)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function VenueFormDialog({
  open,
  target,
  venueType,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  target: AdminVenue | null
  venueType: ManageableVenueType
  onOpenChange: (open: boolean) => void
  onSubmit: (input: VenueFormInput) => boolean
}) {
  const [label, setLabel] = useState(target?.label ?? "")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? "장소 이름 변경" : `${VENUE_TYPE_LABELS[venueType]} 추가`}</DialogTitle>
          <DialogDescription>추가한 순서(라벨 순)가 실제 배정 순서가 됩니다.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (onSubmit({ venue_type: venueType, label })) onOpenChange(false)
          }}
        >
          <div className="flex flex-col gap-3 px-5">
            <TextField
              id="venue-label"
              label="이름"
              value={label}
              onChange={setLabel}
              placeholder={venueType === "zone_table" ? "T-05" : "Room C"}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">{target ? "저장" : "추가"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
