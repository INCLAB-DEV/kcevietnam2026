// OP-005 — 배정 삭제(DELETE). REFACTORING.md Phase 2 optional 항목. UI 동선은 아직 없고
// (그리드에서 확정 배정 삭제는 TBD-4), 계약만 먼저 열어둔다. 운영자 전용.

import { NextResponse } from "next/server"
import { resolveRequestGuard, resolveRequestSession } from "@/lib/mock/session-server"
import { removeAssignment } from "@/lib/organizer/assignment-store"

export const dynamic = "force-dynamic"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
) {
  const guard = await resolveRequestGuard()
  if (!guard.authenticated) {
    return NextResponse.json({ success: false, error: "unauthenticated" }, { status: 401 })
  }
  const session = await resolveRequestSession()
  if (session.role !== "organizer") {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 })
  }

  const { assignmentId } = await params
  if (!removeAssignment(assignmentId)) {
    return NextResponse.json({ success: false, error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
