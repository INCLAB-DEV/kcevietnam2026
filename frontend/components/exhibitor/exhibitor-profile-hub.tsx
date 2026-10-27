"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { canSelfEditProfile } from "@/lib/application-status"
import { getExhibitorClient } from "@/lib/bm/exhibitor-client"
import { applyStepPatch, canSubmit, stepPatch } from "@/lib/bm/profile-form-state"
import { DEMO_EXHIBITOR_PROFILE } from "@/lib/bm/demo-profile"
import type {
  ApplicationStatus,
  EditableStep,
  ExhibitorProfileDraft,
  ExhibitorStepPatch,
} from "@/lib/bm/types"
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog"
import { ProfileView } from "./apply-form"
import { ExhibitorSectionEditDialog } from "./profile-section-edit-dialog"

// BM-005 참가사 내 프로필 허브 — 저장된 프로필을 작성 폼 4단계 구획(기본정보·회사소개·전시품목·타겟)
// 대로 보여주고, **각 구획을 참가자가 직접 고칠 수 있게** 편집 다이얼로그를 꽂는다. 작성 폼의
// ProfileView를 단일 소스로 공유한다(별도 조회/수정 화면 안 만듦, F-BM-005 D1).
//
// 편집 가능 상태는 lib/application-status의 canSelfEditProfile 하나로 판정한다 — approved(승인 후
// 정정, F-BM-004 D5)·changes_requested(보완 후 재제출)·registered는 열리고, submitted(검토 중
// 표류 방지)·rejected(종단)는 조회 전용. 수정은 application_status를 건드리지 않는다(비강등).
// ProfileView의 큰 '수정하기'(작성 폼 전체 진입)는 계속 닫아 둔다 — 신청기간 중 작성 동선은
// /exhibitor/apply 소관이고, 이 화면의 수정 단위는 구획이다. 헤더 오른쪽의 비밀번호 변경
// (headerAction)은 프로필이 아니라 계정 기능이라 신청서 상태와 무관하게 항상 열려 있다.
//
// 저장은 서버 확인 후에만 화면에 반영한다(낙관적 갱신 없음): saveStep 응답에서 **그 구획의 필드만**
// 되받아 병합하고(다른 구획의 표시값 보존 — 작성 폼 saveCurrentStep과 같은 규칙), router.refresh()로
// 서버 컴포넌트(쉘·nav)도 갱신한다. 실패는 다이얼로그가 에러 토스트를 띄우고 옛 값이 그대로 남는다.
//
// 데이터(getProfile)는 클라 클라이언트(인메모리 mock / 실세션이면 FastAPI, BFF 경유)라 클라이언트
// 컴포넌트로 읽는다. nav 라우트(허브)라 onBack 미전달(돌아가기 숨김 — nav로 이동). Organization 단위
// 권한은 백엔드(app/bm/router.py _load_owned_role)가 강제한다 — FE는 별도 권한 경로를 만들지 않는다.
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
  const router = useRouter()
  const [profile, setProfile] = useState<ExhibitorProfileDraft | null>(null)
  const [status, setStatus] = useState<ApplicationStatus | null>(null)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const isReal = !!orgEventRoleId
  const roleKey = orgEventRoleId ?? profileKey

  useEffect(() => {
    let alive = true
    setError(false)
    getExhibitorClient(isReal)
      .getProfile(roleKey)
      .then((p) => {
        if (!alive) return
        const complete = canSubmit(p)
        setProfile(isReal || complete ? p : DEMO_EXHIBITOR_PROFILE)
        // 데모 예시로 대체한 경우엔 실제 status가 무의미하다 — 프로필 탭이 열리는 상태(approved)로
        // 간주해 mock/데모에서도 구획 편집 동선을 그대로 시연·검증할 수 있게 한다.
        setStatus(isReal || complete ? p.applicationStatus : "approved")
      })
      .catch(() => {
        if (!alive) return
        if (isReal) setError(true)
        else {
          setProfile(DEMO_EXHIBITOR_PROFILE) // mock 조회 실패는 데모로 폴백
          setStatus("approved")
        }
      })
    return () => {
      alive = false
    }
  }, [roleKey, isReal, reloadKey])

  // 구획 저장 — 서버 PATCH 후 응답의 그 구획 필드만 병합한다. 실패는 그대로 throw해 다이얼로그가
  // 에러 토스트를 띄우고 사용자 입력을 유지하게 한다(여기서 삼키면 실패가 성공처럼 보인다).
  async function handleSaveSection(
    step: EditableStep,
    patch: ExhibitorStepPatch
  ) {
    const saved = await getExhibitorClient(isReal).saveStep(roleKey, step, patch)
    setProfile((prev) =>
      prev ? applyStepPatch(prev, step, stepPatch(saved, step)) : saved
    )
    setStatus(saved.applicationStatus)
    router.refresh()
  }

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

  const selfEditable = status != null && canSelfEditProfile(status)

  return (
    <div data-tour="profile-view">
      <ProfileView
        draft={profile}
        canEdit={false}
        onEdit={() => {}}
        // 비밀번호 변경은 프로필 내용이 아니라 계정 기능이라 구획(sectionAction)이 아니라 헤더
        // 오른쪽에 둔다 — 신청서 상태(selfEditable)와 무관하게 항상 열려 있어야 한다.
        headerAction={<ChangePasswordDialog />}
        sectionAction={
          selfEditable
            ? (step) => (
                <ExhibitorSectionEditDialog
                  step={step}
                  draft={profile}
                  onSave={handleSaveSection}
                />
              )
            : undefined
        }
      />
    </div>
  )
}
