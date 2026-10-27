"use client"

// 운영자 신청서 편집 패널 — 관리자 콘솔(/admin/organizations "신청서 편집" 시트)과 행사 운영 콘솔
// (/organizer/members "신청서 조회·심사" 다이얼로그)이 함께 쓰는 **유일한** 신청서 전체 보기·편집 UI다.
// 예전엔 같은 신청서를 다루는 편집 화면이 콘솔마다 따로 있었고 범위가 제각각이었다(관리자 시트는 일부
// 항목만, 행사 운영 콘솔은 조회만 + 저장되지 않는 입력 칸) — components/roster·contact-password와 같은
// 이유로 공용 모듈로 둔다.
//
// 구성 = 참가자 화면의 "전체 보기 + 구획별 수정"을 그대로 재조립한 것:
//   참가사: ProfileView(4탭) + ExhibitorSectionEditDialog(구획 = 작성 폼의 한 단계)
//   바이어: StepReview(요약 카드) + BuyerSectionEditDialog
// 필드 정의·라벨·선택지를 여기서 다시 만들지 않는다 — 참가자 신청서에 항목이 생기면 이 패널에도 생긴다.
// 그 위에 운영자 전용 구획(application-operator-sections)을 얹는다.
//
// 데이터 규칙(lib/operator/application-client):
//   · 패널을 열 때마다 서버에서 새로 읽는다. 목록 화면에 실려 온 값을 편집 초깃값으로 쓰지 않는다.
//   · 저장은 서버 확인 뒤에만 화면에 반영한다(낙관적 갱신 없음) — 응답으로 패널 전체를 다시 그린다.
//   · 저장 실패는 구획 다이얼로그가 토스트로 알리고 다이얼로그와 입력을 그대로 둔다.
//   · 저장 직전에 서버를 다시 읽어, 그 구획이 다이얼로그를 연 뒤 다른 곳에서 바뀌었으면 보내지 않는다
//     (충돌). 패널은 방금 읽은 최신으로 바뀌고, 다이얼로그는 입력을 남긴 채 "닫고 다시 열라"고 안내한다.
//     기준은 **다이얼로그를 열 때의 스냅샷**이다 — 같은 창에서 다시 눌러도 충돌이 풀리지 않는다.
//   · 직접 수정은 신청 상태를 바꾸지 않는다(승인된 신청서도 승인 그대로).
//   · 필수 항목이 비어 있어도 저장을 막지 않는다(운영자는 일부만 아는 채로 채워 간다) — 비어 있는
//     구획은 안내만 한다.
//
// 참가자 컴포넌트는 useTranslations로 문구를 뽑는다 — 두 콘솔의 레이아웃이 ko 고정 provider
// (components/operator/console-intl-provider)로 감싸므로 여기서도 한국어로 나온다.

import { useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { TriangleAlert } from "lucide-react"

import { BuyerSectionEditDialog } from "@/components/apply/profile-section-edit-dialog"
import { StepReview } from "@/components/apply/steps/step-review"
import { ProfileView } from "@/components/exhibitor/apply-form"
import { ExhibitorSectionEditDialog } from "@/components/exhibitor/profile-section-edit-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import type { ApplicationStatus } from "@/lib/application-status"
import { INPUT_STEPS, isStepComplete as isBuyerStepComplete } from "@/lib/apply/form-state"
import type { BuyerEditableStep, BuyerStepPatch } from "@/lib/apply/types"
import { EDITABLE_STEPS, STEP_META, completedSteps } from "@/lib/bm/profile-form-state"
import type { EditableStep, ExhibitorStepPatch } from "@/lib/bm/types"
import {
  isOperatorConflict,
  type OperatorApplication,
  type OperatorApplicationClient,
  type OperatorBuyerApplication,
  type OperatorBuyerClient,
  type OperatorExhibitorApplication,
  type OperatorExhibitorClient,
} from "@/lib/operator/application-client"

import {
  BuyerLegacySection,
  BuyerOperatorSection,
  ExhibitorAttendeeExtrasSection,
  ExhibitorLegacySection,
  ExhibitorOperatorSection,
  UnavailableSlotsSection,
  describeOperatorError,
  describeOperatorLoadError,
} from "./application-operator-sections"
import { useServerValue } from "./use-server-value"

interface SharedProps {
  // 신청서 편집 권한. false면 전체가 조회 전용(구획 '수정' 버튼이 없다).
  canEdit: boolean
  // master 여부 — 부스·미팅 불가 시간은 master만 고친다(sub에게는 값만 보인다).
  isMaster: boolean
  // 신청 상태 배지 문구 — 콘솔마다 쓰는 어휘가 달라(관리자 "승인" / 행사 운영 "승인됨") 받아 쓴다.
  statusLabels: Record<ApplicationStatus, string>
  // 저장이 서버에서 확정된 뒤 호출 — 콘솔이 목록을 다시 읽는다(router.refresh 등).
  onSaved?: (application: OperatorApplication) => void
}

interface PanelProps<TClient extends OperatorApplicationClient> extends SharedProps {
  client: TClient
}

// 저장 한 번 — 성공하면 서버 응답으로, 충돌이면 방금 다시 읽은 최신으로 패널을 다시 그린다(둘 다 서버가
// 확인해 준 값이다). 충돌·실패는 그대로 던진다 — 다이얼로그가 닫히지 않고 입력을 남긴 채 안내한다.
async function settle<T extends OperatorApplication>(
  task: () => Promise<T>,
  applied: (next: T) => void,
): Promise<void> {
  try {
    applied(await task())
  } catch (error) {
    // 이 패널의 클라이언트가 던진 충돌이므로 latest는 같은 역할의 스냅샷이다.
    if (isOperatorConflict(error)) applied(error.latest as T)
    throw error
  }
}

// 구획 편집 다이얼로그 하나 + "열 때의 스냅샷". 참가자 다이얼로그는 열 때 draft로 폼을 되돌리고 그 뒤로는
// draft가 바뀌어도 입력을 건드리지 않는다 — 그래서 충돌 검사의 기준도 "패널의 지금 값"이 아니라 "열 때 값"
// 이어야 한다. 충돌로 패널이 최신이 된 뒤 같은 창에서 다시 저장해도 옛 값에서 출발한 입력이 최신을 덮지
// 못하고, 닫았다 다시 열면(폼이 최신으로 채워진다) 기준도 최신이 된다.
function ExhibitorStepEditor({
  step,
  application,
  onSave,
}: {
  step: EditableStep
  application: OperatorExhibitorApplication
  onSave: (
    step: EditableStep,
    patch: ExhibitorStepPatch,
    baseline: OperatorExhibitorApplication,
  ) => Promise<void>
}) {
  const opened = useRef(application)
  return (
    <ExhibitorSectionEditDialog
      step={step}
      draft={application.profile}
      requireComplete={false}
      lockedNotice={
        <p className="text-xs text-muted-foreground">
          기업명·부스는 이 구획이 아니라 아래 &lsquo;운영자 전용 항목&rsquo;에서 고칩니다.
        </p>
      }
      describeSaveError={describeOperatorError}
      onOpenChange={(open) => {
        if (open) opened.current = application
      }}
      onSave={(target, patch) => onSave(target, patch, opened.current)}
    />
  )
}

function BuyerStepEditor({
  step,
  application,
  onSave,
}: {
  step: BuyerEditableStep
  application: OperatorBuyerApplication
  onSave: (
    step: BuyerEditableStep,
    patch: BuyerStepPatch,
    baseline: OperatorBuyerApplication,
  ) => Promise<void>
}) {
  const opened = useRef(application)
  return (
    <BuyerSectionEditDialog
      step={step}
      draft={application.draft}
      requireComplete={false}
      describeSaveError={describeOperatorError}
      onOpenChange={(open) => {
        if (open) opened.current = application
      }}
      onSave={(target, patch) => onSave(target, patch, opened.current)}
    />
  )
}

function LoadingOrError({
  state,
  onRetry,
}: {
  state: { status: "loading" } | { status: "error"; error: unknown }
  onRetry: () => void
}) {
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="신청서를 불러오는 중">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>신청서를 불러오지 못했어요</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{describeOperatorLoadError(state.error)}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          다시 불러오기
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function StatusLine({
  application,
  canEdit,
  statusLabels,
}: {
  application: OperatorApplication
  canEdit: boolean
  statusLabels: Record<ApplicationStatus, string>
}) {
  const variant =
    application.status === "approved"
      ? "default"
      : application.status === "rejected"
        ? "secondary"
        : "outline"
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
      <span>현재 신청 상태</span>
      <Badge variant={variant}>{statusLabels[application.status]}</Badge>
      {application.proxyWritten ? (
        <Badge variant="ghost" className="text-[10px]">
          운영자 작성
        </Badge>
      ) : null}
      <span className="basis-full">
        {canEdit
          ? "구획마다 '수정'으로 고치면 바로 저장됩니다. 여기서 고쳐도 신청 상태는 바뀌지 않습니다."
          : "조회 전용입니다 — 이 계정으로는 이 신청서를 고칠 수 없습니다."}
      </span>
    </div>
  )
}

function IncompleteNotice({ sections }: { sections: string[] }) {
  if (sections.length === 0) return null
  return (
    <p className="text-xs text-muted-foreground">
      필수 항목이 비어 있는 구획: {sections.join(", ")} — 저장은 막지 않습니다.
    </p>
  )
}

function OperatorOnlyHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Separator />
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">운영자 전용 항목</h3>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

function ExhibitorPanel({
  client,
  canEdit,
  isMaster,
  statusLabels,
  onSaved,
}: PanelProps<OperatorExhibitorClient>) {
  const t = useTranslations("applyExhibitor")
  const { state, setValue, retry } = useServerValue(client.getProfile)
  if (state.status !== "ready") return <LoadingOrError state={state} onRetry={retry} />

  const application = state.value
  const profile = application.profile
  const applied = (next: OperatorExhibitorApplication) => {
    setValue(next)
    onSaved?.(next)
  }
  const done = completedSteps(profile)
  const incomplete = EDITABLE_STEPS.filter((step) => !done.includes(step)).map((step) =>
    t(STEP_META[step - 1].titleKey),
  )

  return (
    <div className="flex flex-col gap-5">
      <StatusLine application={application} canEdit={canEdit} statusLabels={statusLabels} />
      <IncompleteNotice sections={incomplete} />

      {/* ProfileView 루트가 mx-auto max-w-3xl이라 flex 컨테이너 안에서 폭이 콘텐츠 크기로 줄어든다 —
          w-full 블록으로 감싸 항상 전체 폭을 채우게 한다(components/organizer/company-application과 같다). */}
      <div className="w-full min-w-0">
        <ProfileView
          draft={profile}
          canEdit={false}
          onEdit={() => {}}
          showHeader={false}
          lockedNotice={null}
          sectionAction={
            canEdit
              ? (step) => (
                  <ExhibitorStepEditor
                    step={step}
                    application={application}
                    onSave={(target, patch, baseline) =>
                      settle(() => client.saveStep(target, patch, baseline), applied)
                    }
                  />
                )
              : undefined
          }
        />
      </div>

      <OperatorOnlyHeading>
        참가자가 직접 고칠 수 없는 항목입니다(기업명·부스·담당자 추가 정보·미팅 불가 시간).
      </OperatorOnlyHeading>
      <ExhibitorOperatorSection
        profile={profile}
        baseline={application}
        canEdit={canEdit}
        isMaster={isMaster}
        onSave={(patch, baseline) =>
          settle(() => client.saveOperatorFields(patch, baseline), applied)
        }
      />
      <ExhibitorAttendeeExtrasSection
        attendees={profile.attendees ?? []}
        baseline={application}
        canEdit={canEdit}
        onSave={(attendees, baseline) =>
          settle(() => client.saveAttendees(attendees, baseline), applied)
        }
      />
      <UnavailableSlotsSection
        slots={profile.unavailableMeetingSlots ?? []}
        baseline={application}
        grid={application.slotGrid}
        editable={canEdit && isMaster}
        onSave={(slots, baseline) =>
          settle(() => client.saveUnavailableSlots(slots, baseline), applied)
        }
      />
      <ExhibitorLegacySection profile={profile} />
    </div>
  )
}

function BuyerPanel({
  client,
  canEdit,
  statusLabels,
  onSaved,
}: PanelProps<OperatorBuyerClient>) {
  const t = useTranslations("applyBuyer")
  const { state, setValue, retry } = useServerValue(client.getProfile)
  if (state.status !== "ready") return <LoadingOrError state={state} onRetry={retry} />

  const application = state.value
  const draft = application.draft
  const applied = (next: OperatorBuyerApplication) => {
    setValue(next)
    onSaved?.(next)
  }
  const incomplete = INPUT_STEPS.filter((step) => !isBuyerStepComplete(step, draft)).map((step) =>
    t(`stepTitles.${step}`),
  )

  return (
    <div className="flex flex-col gap-5">
      <StatusLine application={application} canEdit={canEdit} statusLabels={statusLabels} />
      <IncompleteNotice sections={incomplete} />

      <StepReview
        draft={draft}
        onEditStep={() => {}}
        readOnly
        sectionAction={
          canEdit
            ? (step) =>
                // 3(확인·제출)은 입력이 없는 요약 단계라 편집 진입점을 두지 않는다.
                step === 3 ? null : (
                  <BuyerStepEditor
                    step={step}
                    application={application}
                    onSave={(target, patch, baseline) =>
                      settle(() => client.saveStep(target, patch, baseline), applied)
                    }
                  />
                )
            : undefined
        }
      />

      <Separator />
      <BuyerOperatorSection
        draft={draft}
        baseline={application}
        canEdit={canEdit}
        onSave={(patch, baseline) =>
          settle(() => client.saveOperatorFields(patch, baseline), applied)
        }
      />
      <BuyerLegacySection draft={draft} />
    </div>
  )
}

export function OperatorApplicationPanel({
  createClient,
  ...shared
}: SharedProps & {
  // 이 기업 하나를 읽고 쓰는 클라이언트를 만드는 함수(콘솔이 자기 전송으로 만든다). **마운트당 한 번만**
  // 부른다 — 패널이 떠 있는 동안 클라이언트(와 그 안의 "서버가 확인해 준 마지막 값")가 바뀌지 않아야,
  // 목록 새로고침(router.refresh)으로 부모가 다시 그려져도 다시 읽기가 끼어들어 방금 저장한 값을 옛
  // 응답으로 덮는 일이 없다. 다른 기업을 열 때는 호출부가 key로 다시 마운트한다(= 새로 읽는다).
  createClient: () => OperatorApplicationClient
}) {
  const [client] = useState(createClient)
  return client.role === "exhibitor" ? (
    <ExhibitorPanel {...shared} client={client} />
  ) : (
    <BuyerPanel {...shared} client={client} />
  )
}
