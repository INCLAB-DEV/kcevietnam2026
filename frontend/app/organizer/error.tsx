"use client"

import { useEffect } from "react"

import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { operatorErrorKind } from "@/lib/auth/operator-errors"

// 행사 운영 콘솔(/organizer/*)의 안전망 — 페이지 렌더·데이터 읽기가 던져도 사이드바(레이아웃)는 남기고
// 본문 자리에서만 안내한다. 403/404는 읽기 어댑터가 digest로 실어 보내(lib/auth/operator-errors) 사람이
// 읽는 안내로 바꾸고, 그 외는 재시도를 권한다. 원문 메시지는 화면에 내지 않는다(프로덕션에선 가려져
// 오고, 개발 중에도 내부 경로가 섞여 있다) — 콘솔 로그로만 남긴다.
export default function OrganizerError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  const kind = operatorErrorKind(error)
  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <OperatorStatePanel
        kind={kind === "unknown" ? "error" : kind}
        onRetry={kind === "unknown" ? unstable_retry : undefined}
        homeHref="/organizer"
        homeLabel="매칭 현황으로"
      />
    </div>
  )
}
