"use client"

import { useEffect } from "react"

import { OperatorStatePanel } from "@/components/layout/operator-state-panel"
import { operatorErrorKind } from "@/lib/auth/operator-errors"

// 관리자 콘솔(/admin/*)의 안전망 — 페이지 읽기가 던져도 사이드바·헤더(app/admin/layout.tsx)는 남기고
// 본문 자리에서만 안내한다. 403/404는 읽기 어댑터(lib/admin/http-client adminFetch)가 digest로 실어
// 보내 "권한 없음/찾을 수 없음"으로 바꾸고, 그 외는 재시도를 권한다. 원문 메시지는 화면에 내지 않는다.
export default function AdminError({
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
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
      <OperatorStatePanel
        kind={kind === "unknown" ? "error" : kind}
        onRetry={kind === "unknown" ? unstable_retry : undefined}
        homeHref="/admin"
        homeLabel="대시보드로"
      />
    </div>
  )
}
