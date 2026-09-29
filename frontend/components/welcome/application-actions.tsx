"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  peekProfile,
  submitProfile,
  SubmitBlockedError,
} from "@/lib/apply/buyer-profile-store"
import { submitProfileToServer } from "@/lib/apply/form-actions"
import { isSubmittable as buyerSubmittable } from "@/lib/apply/form-state"
import { getBuyerClient } from "@/lib/bm/buyer-client"
import { getExhibitorClient } from "@/lib/bm/exhibitor-client"
import { canSubmit as exhibitorSubmittable } from "@/lib/bm/profile-form-state"
import type { ApplicationStatus } from "@/lib/bm/types"

// 입장 전 랜딩(/welcome) 신청기간 중 액션 — "작성/수정"(폼=저장)과 "제출"을 분리한다(2026-06-30 결정).
// 폼은 드래프트 저장만 하고, 제출(application_status 전환)은 여기서 일어난다. 상태별 액션:
//   registered                      : 미완성=작성하기 / 완성(submittable)=수정하기 + 제출하기 (첫 제출도 여기서)
//   changes_requested               : 수정하기 / 다시 제출하기 (+ 폼 review_note 배너)
//   submitted · approved · rejected : 신청서 보기 (읽기전용 — 제출 후 잠금, 폼이 ProfileView로 렌더)
// 완성 여부는 클라 스토어(바이어=localStorage, 참가사=세션 메모리 mock)에서 읽는다(미입력=미완성=작성 전 취급).
// 실 세션(isReal)은 FastAPI(BFF 경유, getBuyerClient/getExhibitorClient(true))가 내려주는 저장된
// 프로필로 완성도를 판정하고, 제출도 서버가 최종 강제한다(mock 로컬 store는 실 세션에서 쓰지 않는다).
export function ApplicationActions({
  role,
  profileKey,
  status,
  isReal = false,
}: {
  role: "buyer" | "exhibitor"
  profileKey: string
  status: ApplicationStatus
  // 실 로그인 세션(참가사·바이어 공통)이면 true — getExhibitorClient/getBuyerClient(isReal)로
  // 실 백엔드를 쓴다. 기본값 false(기존 mock 동작 100% 보존).
  isReal?: boolean
}) {
  const router = useRouter()
  const t = useTranslations("welcome.actions")
  const formHref = role === "buyer" ? "/apply" : "/exhibitor/apply"
  // 제출 후 잠금 — submitted/approved/rejected는 읽기전용(신청서 보기). 편집은 registered·changes_requested만.
  const viewOnly =
    status === "submitted" || status === "approved" || status === "rejected"

  const [ready, setReady] = useState(viewOnly) // 읽기전용은 스토어를 읽을 필요 없음
  const [submittable, setSubmittable] = useState(false)
  const [busy, setBusy] = useState(false)

  // 편집 가능한 상태에서만 드래프트를 읽어 "제출 가능(완성) 여부"를 판단한다.
  useEffect(() => {
    if (viewOnly) return
    let alive = true
    async function read() {
      // dev: ?draft=empty(작성 전)|done(작성 완료) 오버라이드로 작성하기↔수정하기·제출을 스위처에서 바로 확인.
      // 참가사 in-memory STORE는 리로드 시 비어 항상 '작성하기'로 보이므로 테스트용 토글을 둔다. prod엔 무시.
      if (process.env.NODE_ENV !== "production") {
        const devDraft = new URLSearchParams(window.location.search).get("draft")
        if (devDraft === "empty" || devDraft === "done") {
          if (alive) {
            setSubmittable(devDraft === "done")
            setReady(true)
          }
          return
        }
      }
      if (role === "buyer") {
        if (isReal) {
          // 실 세션 — localStorage엔 안 쓰므로(components/apply/apply-form.tsx가 real이면 backend
          // 전용) peekProfile은 항상 빈값. backend 저장 프로필로 완성도를 판정한다(참가사 분기와 대칭).
          const { draft } = await getBuyerClient(true).getProfile(profileKey)
          if (alive) setSubmittable(buyerSubmittable(draft))
        } else {
          // peek(비-변경) — 없으면 작성 전(미완성). loadProfile은 빈 드래프트를 박아 이후 seed prefill을 막는다.
          const stored = peekProfile(profileKey)
          if (alive) setSubmittable(stored ? buyerSubmittable(stored.draft) : false)
        }
      } else {
        const draft = await getExhibitorClient(isReal).getProfile(profileKey)
        if (alive) setSubmittable(exhibitorSubmittable(draft))
      }
      if (alive) setReady(true)
    }
    read()
    return () => {
      alive = false
    }
  }, [role, profileKey, viewOnly, isReal])

  async function handleSubmit() {
    setBusy(true)
    try {
      if (role === "buyer") {
        // 서버 제출(검증·전이 권위, POST /api/buyer-apply). mock은 클라 store의 최종 draft를 실어
        // 보낸다. 실 세션은 draft를 안 실어 보낸다 — 백엔드가 이미 저장된 프로필로 검증한다(로컬
        // store에 draft가 없다, 위 read 참고). 서버가 거절하면 로컬 전이도 하지 않는다(상태 불일치 방지).
        const stored = isReal ? undefined : peekProfile(profileKey)
        const result = await submitProfileToServer(stored?.draft)
        if (!result.success) {
          setBusy(false)
          toast.error(
            result.error === "validation_failed"
              ? t("toastValidationFailed")
              : result.error === "submit_blocked"
                ? t("toastSubmitBlocked")
                : t("toastSubmitFailed"),
          )
          return
        }
        // 로컬 store 전이는 mock 전용 — 실 세션 상태는 서버(/api/me → fetchMe)가 권위이고 /welcome
        // 재진입 시 그걸 읽으므로(app/welcome/page.tsx), 여기서 손댈 필요도 없고 손대면 안 된다
        // (real org_event_role_id 키로 가짜 mock 엔트리가 생기는 걸 막는다).
        if (!isReal) submitProfile(profileKey)
      } else {
        await getExhibitorClient(isReal).submit(profileKey)
      }
      // dev: 제출 후 세션 상태도 submitted로 맞춰 /welcome이 갱신되게 한다(proxy가 ?status를 쿠키로 미러).
      // prod: ?status는 무시되고 FastAPI가 갱신한 실제 status를 읽는다.
      router.push("/welcome?status=submitted")
    } catch (e) {
      setBusy(false)
      toast.error(
        e instanceof SubmitBlockedError ? t("toastRejectedResubmit") : t("toastSubmitFailed"),
      )
    }
  }

  // 읽기전용(제출됨/승인/반려): 신청서 보기만.
  if (viewOnly) {
    return (
      <Button asChild variant="outline" className="w-full">
        <a href={formHref}>{t("viewApplication")}</a>
      </Button>
    )
  }

  // changes_requested는 이미 작성한 신청서 보완이라 항상 수정하기. registered는 완성됐을 때만 수정하기·제출 노출.
  const started = status === "changes_requested" || submittable
  const editLabel = started ? t("edit") : t("start")
  const submitLabel = status === "changes_requested" ? t("resubmit") : t("submit")

  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        asChild
        variant={started ? "outline" : "default"}
        className="w-full"
      >
        <a href={formHref}>{editLabel}</a>
      </Button>
      {started ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              className="w-full"
              disabled={!ready || !submittable || busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={handleSubmit}>
                {submitLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {started && ready && !submittable ? (
        <p className="text-center text-xs text-muted-foreground">{t("incompleteHint")}</p>
      ) : null}
    </div>
  )
}
