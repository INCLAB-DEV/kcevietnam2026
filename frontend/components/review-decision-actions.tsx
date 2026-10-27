"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export type ReviewDecision = "approved" | "rejected" | "changes_requested"

// 승인 심사 결정 액션(사유 입력 + 승인/반려/수정요청 버튼) — organizer 콘솔(members-table의
// ReviewModal)과 admin 콘솔(organizations-console)이 공유한다. 둘 다 결국 같은 백엔드 엔드포인트
// (PATCH .../organizations/{id}/review)를 향하고 결정 로직도 같으므로(canReview·사유 규칙), 이
// 조각만 공유하고 프로필 표시(Dialog vs Sheet)는 각 콘솔 것을 그대로 둔다.
export function ReviewDecisionActions({
  onDecide,
  pending = false,
  noteId = "review-note",
}: {
  onDecide: (status: ReviewDecision, note?: string) => void
  // 호출부가 서버 응답을 기다리는 동안(admin 콘솔) 버튼을 잠근다. organizer는 낙관적 처리라 안 쓴다.
  pending?: boolean
  noteId?: string
}) {
  const [note, setNote] = useState("")
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>사유 (수정요청·반려 시)</Label>
        <Input
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="보완/반려 사유를 적어주세요"
          disabled={pending}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onDecide("changes_requested", note.trim() || undefined)}
        >
          수정요청
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => onDecide("rejected", note.trim() || undefined)}
        >
          반려
        </Button>
        <Button type="button" disabled={pending} onClick={() => onDecide("approved")}>
          승인
        </Button>
      </div>
    </div>
  )
}
