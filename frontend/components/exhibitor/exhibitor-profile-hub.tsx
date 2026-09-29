"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { getExhibitorClient } from "@/lib/bm/exhibitor-client"
import { canSubmit } from "@/lib/bm/profile-form-state"
import { DEMO_EXHIBITOR_PROFILE } from "@/lib/bm/demo-profile"
import type { ExhibitorProfileDraft } from "@/lib/bm/types"
import { ProfileView } from "./apply-form"

// BM-005 참가사 내 프로필 조회 허브 — 저장된 프로필을 작성 폼 4단계 구획(기본정보·회사소개·전시품목·타겟)대로
// 읽기전용 표시(조회 전용, 결정 A). 작성 폼의 ProfileView를 단일 소스로 공유한다(별도 조회 화면 안 만듦,
// F-BM-005 D1). 승인 후 프로필은 #114 정책상 읽기전용 — canEdit=false, 섹션→단계 수정 딥링크는 후속.
// 데이터(getProfile)는 클라 클라이언트(인메모리 mock / 실세션이면 FastAPI, BFF 경유)라 클라이언트
// 컴포넌트로 읽는다. nav 라우트(허브)라 onBack 미전달(돌아가기 숨김 — nav로 이동). Organization 단위
// 권한은 백엔드(app/bm/router.py _load_owned_role)가 강제한다.
//
// 실 세션(orgEventRoleId 있음): 실 프로필을 미완성이어도 정직하게 그대로 보여준다(데모 폴백 없음) —
// 조회 실패는 에러 UI. mock/dev(orgEventRoleId 없음)는 기존과 동일하게 완성된 실제 프로필이 있으면
// 그걸, 없으면(데모 계정·미작성) 데모 예시 데이터를 채운다(가라데이터, mock 전용).
export function ExhibitorProfileHub({
  profileKey,
  orgEventRoleId,
}: {
  profileKey: string
  orgEventRoleId?: string | null
}) {
  const t = useTranslations("applyExhibitor")
  const [profile, setProfile] = useState<ExhibitorProfileDraft | null>(null)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const isReal = !!orgEventRoleId

  useEffect(() => {
    let alive = true
    setError(false)
    const key = orgEventRoleId ?? profileKey
    getExhibitorClient(isReal)
      .getProfile(key)
      .then((p) => {
        if (!alive) return
        setProfile(isReal ? p : canSubmit(p) ? p : DEMO_EXHIBITOR_PROFILE)
      })
      .catch(() => {
        if (!alive) return
        if (isReal) setError(true)
        else setProfile(DEMO_EXHIBITOR_PROFILE) // mock 조회 실패는 데모로 폴백(읽기전용이라 위험 없음)
      })
    return () => {
      alive = false
    }
  }, [profileKey, orgEventRoleId, isReal, reloadKey])

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-4">
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
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div data-tour="profile-view">
      <ProfileView draft={profile} canEdit={false} onEdit={() => {}} />
    </div>
  )
}
