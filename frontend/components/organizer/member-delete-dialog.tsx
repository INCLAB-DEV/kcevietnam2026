"use client"

// OP-002 — "참가자 삭제" 확인 다이얼로그(/organizer/members 행 메뉴 "삭제", master 전용).
//
// 열릴 때마다 서버에서 **삭제 영향**을 읽어 보여 준다(lib/organizer/member-deletion.ts — 실제 삭제와 같은
// 판정). 운영 데이터를 지우는 확인이라, 무엇이 함께 지워지는지 모르는 채로 누르게 두지 않는다:
//   · 읽는 중·읽지 못함 → 삭제 버튼 비활성. 실패는 실패라고 알리고 다시 확인하게 한다
//     (읽지 못한 것을 "함께 지워지는 것 없음"으로 보여 주지 않는다).
//   · 삭제 가능 → 함께 지워지는 것을 건수와 함께 나열한다.
//   · 막힘(예정·완료 미팅) → 이유와 할 일을 알리고 삭제 버튼을 막는다.
//   · 명단에 없음(미리보기가 구조화된 404 ORG_NOT_FOUND) → 일반 실패와 다른 안내를 띄우고 삭제 버튼을 막는다.
//     다시 확인해도 소용없으니 재시도 버튼은 없다. 행을 임의로 숨기지 않고 부모(reloadMembers)가 명단을 서버에서
//     다시 읽는다 — 다른 운영자가 먼저 지웠는지, 다른 탭에서 행사가 바뀌어 요청이 다른 행사로 갔는지 404만으로는
//     모른다(정말 지워졌으면 새 명단에서 빠지고, 행사가 바뀌었으면 바뀐 행사의 명단이 보인다).
//
// 삭제 요청은 부모(onConfirm)가 보낸다. 서버가 확인하면 부모가 이 다이얼로그를 내리고 행을 지운다.
// 서버가 "미팅이 있다"고 거부하면(미리보기를 읽은 뒤 상황이 바뀐 경우) 거부에 실린 건수로 화면을
// 막힘 상태로 바꾼다 — 낡은 "삭제 가능" 화면을 남겨 두지 않는다. 삭제가 "명단에 없음"(구조화된 404)이면 부모가
// 이 다이얼로그를 내리고 명단을 다시 읽는다. 그 밖의 실패(평문 404 포함)는 그대로 두어 다시 누를 수 있게 한다
// (안내 토스트는 부모가 띄운다).
//
// 열 때마다 그 기업만 새로 읽는다: 닫으면 부모가 이 다이얼로그를 내리므로(조건부 렌더) 다음에 열 때 새로
// 마운트되고, 마운트할 때의 loadImpact를 붙잡아 한 번만 부른다(부모가 다시 그려질 때마다 새 함수가 와도 다시
// 읽지 않는다). 부모의 key(행 id)는 닫지 않은 채 대상이 바뀌는 경우까지 막는 방어다. 앞서 연 기업의 응답이
// 늦게 와도 이미 내려간 다이얼로그의 것이라 버려진다(useServerValue).

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useServerValue } from "@/components/operator/use-server-value"
import {
  describeDeletionBlockers,
  describeDeletionConsequences,
  isOrgNotFoundError,
  MEMBER_NOT_FOUND_HINT,
  type MemberDeletionImpact,
} from "@/lib/organizer/member-deletion"

export type MemberDeleteOutcome =
  | { status: "deleted" }
  // 이 행사 명단에 없었다(구조화된 404) — 부모가 이 다이얼로그를 내리고 명단을 다시 읽는다.
  | { status: "not_found" }
  // 서버가 미팅 때문에 거부했다 — 지금 막고 있는 건수(서버가 센 값).
  | { status: "blocked"; scheduledCount: number; completedCount: number }
  | { status: "failed" }

export function MemberDeleteDialog({
  name,
  loadImpact,
  onOpenChange,
  onConfirm,
  reloadMembers,
}: {
  name: string
  // 이 기업의 삭제 영향을 서버에서 읽는다. 마운트할 때의 함수를 붙잡아 한 번 부른다(= 열 때 읽는다).
  loadImpact: () => Promise<MemberDeletionImpact>
  onOpenChange: (open: boolean) => void
  // 삭제를 서버에 요청하고 결과를 돌려준다. "deleted"·"not_found"면 부모가 이 다이얼로그를 내린다.
  onConfirm: () => Promise<MemberDeleteOutcome>
  // 명단을 서버에서 다시 읽는다. 미리보기가 "명단에 없음"이면 한 번 부른다(다이얼로그는 안내를 띄운 채 남는다).
  // 안내 문구가 "명단을 새로 불러왔다"고 말하므로 선택이 아니다. 마운트할 때의 함수를 붙잡는다(다시 그려질
  // 때마다 다시 부르지 않게).
  reloadMembers: () => void
}) {
  const [load] = useState(() => loadImpact)
  const [reload] = useState(() => reloadMembers)
  const { state, setValue, retry } = useServerValue(load)
  const notFound = state.status === "error" && isOrgNotFoundError(state.error)
  useEffect(() => {
    if (notFound) reload()
  }, [notFound, reload])
  // 서버 응답을 기다리는 동안 — 삭제 재클릭과 닫기를 막는다(결과를 보기 전에 닫히지 않게).
  const [submitting, setSubmitting] = useState(false)

  const impact = state.status === "ready" ? state.value : null
  const blockers = impact ? describeDeletionBlockers(impact) : []
  const canDelete = impact !== null && impact.deletable

  async function confirm() {
    if (submitting || !impact || !impact.deletable) return
    setSubmitting(true)
    try {
      const outcome = await onConfirm()
      if (outcome.status === "blocked") {
        setValue({
          ...impact,
          deletable: false,
          scheduledCount: outcome.scheduledCount,
          completedCount: outcome.completedCount,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (submitting) return
        onOpenChange(open)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>참가자 삭제</DialogTitle>
          <DialogDescription>{`'${name}'을(를) 이 행사 명단에서 삭제합니다.`}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 text-sm">
          {state.status === "loading" && (
            <div
              className="flex flex-col gap-2"
              aria-busy="true"
              aria-label="삭제하면 함께 지워지는 것을 확인하는 중"
            >
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {notFound && (
            <Alert>
              <AlertTitle>이 행사 명단에서 찾을 수 없는 기업이에요</AlertTitle>
              <AlertDescription className="break-keep">
                {MEMBER_NOT_FOUND_HINT}
              </AlertDescription>
            </Alert>
          )}
          {state.status === "error" && !notFound && (
            <Alert variant="destructive">
              <AlertTitle>삭제 영향을 확인하지 못했어요</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <span>
                  이 기업의 미팅과 함께 지워지는 것을 서버에서 읽지 못했습니다. 확인한 뒤에만 삭제할 수
                  있습니다.
                </span>
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  다시 확인
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {impact && !impact.deletable && (
            <Alert variant="destructive">
              <AlertTitle>지금은 삭제할 수 없습니다</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4 break-keep">
                  {blockers.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {impact && impact.deletable && (
            <>
              <ul className="flex list-disc flex-col gap-1 pl-4 break-keep text-foreground">
                <li>이 기업의 신청서·제품·담당자 정보가 삭제됩니다.</li>
                {describeDeletionConsequences(impact).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="font-medium text-destructive">되돌릴 수 없습니다.</p>
            </>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={submitting}>
              취소
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!canDelete || submitting}
            aria-busy={submitting}
            onClick={confirm}
          >
            {submitting && <Loader2 className="animate-spin" />}
            삭제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
