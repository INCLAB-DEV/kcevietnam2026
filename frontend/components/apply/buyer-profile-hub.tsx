"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { peekProfile } from "@/lib/apply/buyer-profile-store"
import { isSubmittable } from "@/lib/apply/form-state"
import type { BuyerProfileDraft } from "@/lib/apply/types"
import { DEMO_BUYER_PROFILE } from "@/lib/apply/demo-profile"
import { fetchBuyerProfile } from "@/lib/bm/http-buyer-client"
import { StepReview } from "./steps/step-review"

// BM-004 바이어 내 프로필 조회 허브 — 저장된 신청서를 작성 폼 구획대로 읽기전용 표시한다.
// 작성 폼(BM-001 StepReview)을 단일 소스로 재사용(readOnly) — 별도 조회 화면을 만들지 않는다(F-BM-004 D2).
// 승인 후 프로필은 #114 정책상 읽기전용(제출 후 잠금): 수정은 운영자 보완요청(changes_requested) 경유로만,
// 섹션→단계 수정 딥링크는 후속(2026-06-30 결정 A — 조회 전용 허브).
//
// 실 세션(orgEventRoleId 있음): FastAPI 조회(lib/bm/http-buyer-client, BFF 경유)로 실 프로필을
// 그대로 보여준다(미완성이어도 정직하게, 데모 폴백 없음) — 실패는 에러 UI. mock/dev(orgEventRoleId
// 없음)는 기존과 동일하게 클라 스토어(localStorage)를 마운트 후 비변경 조회(peekProfile)로 읽는다
// (SSR에서 store를 보지 않아 getServerSnapshot 경고·하이드레이션 미스매치가 없다).
export function BuyerProfileHub({
  profileKey,
  orgEventRoleId,
}: {
  profileKey: string
  orgEventRoleId?: string | null
}) {
  const t = useTranslations("applyBuyer.profileHub")
  const [draft, setDraft] = useState<BuyerProfileDraft | null>(null)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const isReal = !!orgEventRoleId

  useEffect(() => {
    let alive = true
    setError(false)
    if (isReal) {
      fetchBuyerProfile(orgEventRoleId!)
        .then(({ draft: d }) => {
          if (alive) setDraft(d)
        })
        .catch(() => {
          if (alive) setError(true)
        })
      return () => {
        alive = false
      }
    }
    /* eslint-disable react-hooks/set-state-in-effect */
    // 클라 전용 스토어를 마운트 후 1회 읽는다(SSR/CSR 불일치 방지). 완성된 실제 프로필이 있으면 그걸,
    // 없으면(데모 계정·미완성) 데모 예시 데이터를 채워 보여준다(가라데이터, mock 전용).
    const stored = peekProfile(profileKey)
    setDraft(
      stored && isSubmittable(stored.draft) ? stored.draft : DEMO_BUYER_PROFILE
    )
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      alive = false
    }
  }, [profileKey, orgEventRoleId, isReal, reloadKey])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t("loadErrorTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{t("loadErrorDescription")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : draft ? (
        <div data-tour="profile-view">
          <StepReview draft={draft} onEditStep={() => {}} readOnly />
        </div>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  )
}
