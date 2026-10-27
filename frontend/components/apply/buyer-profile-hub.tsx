"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { canSelfEditProfile } from "@/lib/application-status"
import {
  peekProfile,
  saveStep as saveStepToStore,
} from "@/lib/apply/buyer-profile-store"
import { isSubmittable, stepPatch } from "@/lib/apply/form-state"
import type {
  ApplicationStatus,
  BuyerEditableStep,
  BuyerProfileDraft,
  BuyerStepPatch,
} from "@/lib/apply/types"
import { DEMO_BUYER_PROFILE } from "@/lib/apply/demo-profile"
import { getBuyerClient } from "@/lib/bm/buyer-client"
import { fetchBuyerProfile } from "@/lib/bm/http-buyer-client"
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog"
import { BuyerSectionEditDialog } from "./profile-section-edit-dialog"
import { StepReview } from "./steps/step-review"

// BM-004 바이어 내 프로필 허브 — 저장된 신청서를 작성 폼 구획대로 보여주고, **각 구획을 바이어가
// 직접 고칠 수 있게** 편집 다이얼로그를 꽂는다. 작성 폼(BM-001 StepReview)을 단일 소스로 재사용한다
// (readOnly + sectionAction) — 별도 조회/수정 화면을 만들지 않는다(F-BM-004 D2/D4).
//
// 편집 가능 상태는 lib/application-status의 canSelfEditProfile 하나로 판정한다 — approved(승인 후
// 정정, F-BM-004 D5)·changes_requested(보완 후 재제출)·registered는 열리고, submitted(검토 중
// 표류 방지, FE ADR-0002 §3)·rejected(종단)는 조회 전용. 수정은 application_status를 건드리지
// 않는다 — 한 번 승인된 바이어는 항목을 고쳐도 매칭 대상으로 남는다(F-BM-004 D5 비강등).
//
// 저장은 서버 확인 후에만 화면에 반영한다(낙관적 갱신 없음): saveStep 응답에서 **그 구획의 필드만**
// 되받아 병합하고(다른 구획의 표시값 보존), router.refresh()로 서버 컴포넌트(쉘·nav)도 갱신한다.
// 실패는 다이얼로그가 에러 토스트를 띄우고 옛 값이 그대로 남는다. Organization 단위 권한은
// 백엔드(app/bm/router.py _load_owned_role)가 강제한다 — FE는 별도 권한 경로를 만들지 않는다.
//
// 실 세션(orgEventRoleId 있음): FastAPI 조회/저장(lib/bm/http-buyer-client, BFF 경유)으로 실
// 프로필을 그대로 보여준다(미완성이어도 정직하게, 데모 폴백 없음) — 실패는 에러 UI.
// mock/dev(orgEventRoleId 없음)는 기존과 동일하게 클라 스토어(localStorage)를 마운트 후 비변경
// 조회(peekProfile)로 읽고, 저장도 같은 스토어에 한다(읽기/쓰기 소스 일치).
export function BuyerProfileHub({
  profileKey,
  orgEventRoleId,
}: {
  profileKey: string
  orgEventRoleId?: string | null
}) {
  const t = useTranslations("applyBuyer.profileHub")
  const router = useRouter()
  const [draft, setDraft] = useState<BuyerProfileDraft | null>(null)
  const [status, setStatus] = useState<ApplicationStatus | null>(null)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const isReal = !!orgEventRoleId

  useEffect(() => {
    let alive = true
    setError(false)
    if (isReal) {
      fetchBuyerProfile(orgEventRoleId!)
        .then(({ draft: d, status: s }) => {
          if (!alive) return
          setDraft(d)
          setStatus(s)
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
    const complete = !!stored && isSubmittable(stored.draft)
    setDraft(complete ? stored!.draft : DEMO_BUYER_PROFILE)
    // 데모 예시로 대체한 경우엔 실제 status가 무의미하다 — 프로필 탭이 열리는 상태(approved)로
    // 간주해 mock/데모에서도 구획 편집 동선을 그대로 시연·검증할 수 있게 한다.
    setStatus(complete ? stored!.status : "approved")
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      alive = false
    }
  }, [profileKey, orgEventRoleId, isReal, reloadKey])

  // 구획 저장 — 서버(또는 mock 스토어) 확인 후 응답의 그 구획 필드만 병합한다. 실패는 그대로 throw해
  // 다이얼로그가 에러 토스트를 띄우고 사용자 입력을 유지하게 한다(여기서 삼키면 실패가 성공처럼 보인다).
  async function handleSaveSection(
    step: BuyerEditableStep,
    patch: BuyerStepPatch
  ) {
    const saved = isReal
      ? await getBuyerClient(true).saveStep(orgEventRoleId!, step, patch)
      : saveStepToStore(profileKey, step, patch)
    setDraft((prev) =>
      prev ? { ...prev, ...stepPatch(step, saved.draft) } : saved.draft
    )
    setStatus(saved.status)
    router.refresh()
  }

  const selfEditable = status != null && canSelfEditProfile(status)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* 비밀번호 변경은 신청서 상태(selfEditable)와 무관한 계정 기능이라 헤더 오른쪽에 항상 둔다 —
          조회 전용(submitted·rejected) 상태에서도 자기 로그인 비밀번호는 바꿀 수 있어야 한다. */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {/* 구획별 편집이 열려 있으면 "주최 측에 문의" 안내가 거짓이 된다. */}
            {selfEditable ? t("subtitleEditable") : t("subtitle")}
          </p>
        </div>
        <ChangePasswordDialog />
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
          <StepReview
            draft={draft}
            onEditStep={() => {}}
            readOnly
            sectionAction={
              selfEditable
                ? (step) =>
                    // 3(확인·제출)은 입력이 없는 요약 단계라 편집 진입점을 두지 않는다.
                    step === 3 ? null : (
                      <BuyerSectionEditDialog
                        step={step}
                        draft={draft}
                        onSave={handleSaveSection}
                      />
                    )
                : undefined
            }
          />
        </div>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  )
}
