"use client"

// 신청서 편집 패널의 **운영자 전용 구획** — 참가자 폼에 없거나 참가자는 못 고치는 항목들.
// (참가자 폼에 있는 항목은 application-panel이 참가자 화면의 구획 편집 다이얼로그를 그대로 꽂는다.)
//
//   참가사: 기업명(국/영) · 부스 5칸(master 전용) · 담당자 추가 정보(성·부서·영문 직책·전화·메신저·
//           상담 언어 — 참가자 폼은 이름·직책·이메일·휴대폰만 다룬다) · 미팅 불가 시간(master 전용)
//   바이어: 사업자등록번호 · 웹사이트 · 주소
//   둘 다:  폼에 없는 과거 항목은 값이 있을 때만 읽기 전용으로 보여 준다(조회 창이 보여 주던 것을 잃지 않게).
//
// 저장 규칙은 패널과 같다 — 서버 확인 뒤에만 화면이 바뀌고(낙관적 갱신 없음), 실패하면 토스트로 알리고
// 다이얼로그와 입력을 그대로 둔다. 운영자 전용 다이얼로그는 **바뀐 칸만** 보낸다(비운 칸은 "지움").
// 미팅 불가 시간만 칸을 누르는 즉시 저장하는데(행사 설정·대리작성 화면과 같은 조작), 저장 중에는 격자를
// 잠그고 실패하면 방금 누른 칸을 되돌린다.
//
// 동시 수정: 저장할 때 "열 때의 스냅샷"(baseline)을 함께 넘긴다 — 어댑터가 저장 직전에 서버를 다시 읽어
// 그 사이 달라졌으면 보내지 않고 충돌로 끝낸다(lib/operator/application-client "동시 수정 검사"). 충돌은
// 일반 실패와 다른 문구로 알리고, 다이얼로그와 입력은 그대로 둔다(패널은 이미 최신으로 바뀌어 있다).

import { useId, useState, type ReactNode } from "react"
import { Pencil } from "lucide-react"
import { toast } from "sonner"

import { ChipToggleGroup } from "@/components/form/field-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import {
  BUSINESS_PERF_KOREA,
  TRAVELERS_KOREA,
  labelOf,
} from "@/lib/apply/options"
import type { BuyerAttendeeDraft, BuyerProfileDraft } from "@/lib/apply/types"
import {
  ACQUISITION_CHANNEL_LABELS,
  ORG_TYPE_LABELS,
  PARTICIPATION_ROUTE_LABELS,
  labelFor,
  labelsFor,
} from "@/lib/bm/fields"
import type { ExhibitorAttendee, ExhibitorProfile } from "@/lib/bm/types"
import {
  OperatorRequestError,
  isOperatorConflict,
  type BuyerOperatorPatch,
  type ExhibitorOperatorPatch,
  type OperatorBuyerApplication,
  type OperatorExhibitorApplication,
} from "@/lib/operator/application-client"
import {
  toggleUnavailableSlot,
  type UnavailableSlotGrid as SlotGridAxes,
} from "@/lib/operator/slot-grid"

import { UnavailableSlotGrid } from "./unavailable-slot-grid"

// ── 실패 안내 ────────────────────────────────────────────────────────────────
// 백엔드가 사유를 문장으로 준 경우(403 "부스 지정은 슈퍼관리자만…" 등)는 그대로 덧붙인다.
function reasonOf(error: OperatorRequestError): string {
  return error.code.startsWith("http_") || error.code === "network" ? "" : ` (${error.code})`
}

// 충돌 안내 — 일반 저장 실패와 구분한다: 오류가 아니라 "다른 곳에서 먼저 바뀌어 보내지 않았다"이다.
// 운영자가 자기 입력을 보고 옮겨 적을 수 있게 다이얼로그는 닫지 않는다.
export const OPERATOR_CONFLICT_TITLE = "다른 곳에서 먼저 수정됐어요"
export const OPERATOR_CONFLICT_HINT =
  "최신 내용을 불러왔습니다. 창을 닫고 다시 열어 확인한 뒤 수정해 주세요(입력은 그대로 남아 있습니다)."
export const OPERATOR_CONFLICT_MESSAGE = `다른 곳에서 이 구획이 먼저 수정됐어요. ${OPERATOR_CONFLICT_HINT}`
// 대리작성 다이얼로그용 — 뒤에 최신 값을 보여 줄 패널이 없다(다시 열 때 서버에서 새로 읽는다).
export const OPERATOR_PROXY_CONFLICT_HINT =
  "고치신 항목이 그 사이 다른 곳에서 바뀌어 보내지 않았습니다. 창을 닫고 다시 열면 최신 내용이 보입니다 — 확인한 뒤 다시 수정해 주세요(입력은 그대로 남아 있습니다)."

export function describeOperatorError(error: unknown): string {
  if (!(error instanceof OperatorRequestError)) {
    return "저장하지 못했습니다. 입력은 그대로 남아 있으니 잠시 후 다시 시도해 주세요."
  }
  if (isOperatorConflict(error)) return OPERATOR_CONFLICT_MESSAGE
  if (error.code === "role_mismatch") {
    return "이 기업의 참가 역할이 바뀌었습니다. 저장하지 않았습니다 — 창을 닫고 목록을 새로고침해 주세요."
  }
  if (error.status === 403) {
    return `이 기업을 수정할 권한이 없습니다${reasonOf(error)}. 입력은 그대로 남아 있습니다.`
  }
  if (error.status === 0) {
    return "서버에 연결하지 못했습니다. 입력은 그대로 남아 있으니 연결을 확인하고 다시 저장해 주세요."
  }
  if (error.status === 401) {
    return "로그인이 만료됐습니다. 다시 로그인한 뒤 저장해 주세요(입력은 그대로 남아 있습니다)."
  }
  if (error.code === "name_required") {
    return "기업명(국문·영문)을 둘 다 비울 수는 없습니다. 하나는 남겨 주세요(입력은 그대로 남아 있습니다)."
  }
  if (error.status === 422) {
    return "서버가 입력값을 받지 않았습니다(형식 오류·담당자 이메일 중복 등). 내용을 확인해 주세요."
  }
  return `저장하지 못했습니다${reasonOf(error)}. 입력은 그대로 남아 있습니다.`
}

export function describeOperatorLoadError(error: unknown): string {
  if (!(error instanceof OperatorRequestError)) {
    return "신청서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
  }
  if (error.status === 403) return "이 기업을 열람할 권한이 없습니다(다른 운영자가 관리하는 바이어)."
  if (error.code === "role_mismatch") {
    return "이 기업의 참가 역할이 목록과 다릅니다(역할이 바뀌었을 수 있습니다). 목록을 새로고침해 주세요."
  }
  if (error.status === 0) return "서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도해 주세요."
  if (error.status === 401) return "로그인이 만료됐습니다. 다시 로그인해 주세요."
  if (error.status === 404) return "이 행사에서 기업을 찾을 수 없습니다. 목록을 새로고침해 주세요."
  return `신청서를 불러오지 못했습니다${reasonOf(error)}.`
}

// 운영자 전용 다이얼로그의 실패 토스트 — 충돌은 제목부터 다르게 알린다.
function toastSaveFailure(error: unknown) {
  if (isOperatorConflict(error)) {
    toast.error(OPERATOR_CONFLICT_TITLE, { description: OPERATOR_CONFLICT_HINT })
    return
  }
  toast.error("저장하지 못했어요", { description: describeOperatorError(error) })
}

// ── 표시 조각 ────────────────────────────────────────────────────────────────
function OperatorSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function ValueRow({ label, value }: { label: string; value?: string | number | null }) {
  const text = value == null ? "" : `${value}`.trim()
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{text || "-"}</span>
    </div>
  )
}

// ── 운영자 전용 항목 다이얼로그(텍스트 칸 묶음) ───────────────────────────────
interface OperatorField<K extends string> {
  key: K
  label: string
  placeholder?: string
  hint?: string
  numeric?: boolean
}

function OperatorFieldsDialog<K extends string, B>({
  triggerLabel,
  title,
  description,
  fields,
  values,
  baseline,
  validate,
  onSave,
}: {
  triggerLabel: string
  title: string
  description: string
  fields: readonly OperatorField<K>[]
  // 서버가 확인해 준 현재 값 — 열 때마다 이 값으로 폼을 되돌린다(취소 후 재진입 시 편집이 남지 않게).
  values: Record<K, string>
  // 패널이 지금 들고 있는 스냅샷. **열 때의 것**을 기억해 뒀다가 저장할 때 함께 넘긴다(충돌 검사의 기준).
  baseline: B
  // 저장 전 검사. 문제를 문장으로 돌려주면 저장하지 않고 그 문장을 보여 준다.
  validate?: (draft: Record<K, string>) => string | null
  // 바뀐 칸만 받는다. 빈 문자열은 "지움"이다. 실패는 reject — 다이얼로그가 토스트를 띄우고 입력을 유지한다.
  onSave: (changed: Partial<Record<K, string>>, baseline: B) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<K, string>>(values)
  // 열 때의 값과 스냅샷 — "바뀐 칸"은 운영자가 본 값 기준으로 가린다(충돌로 패널이 최신이 된 뒤에도
  // 이 창의 기준은 그대로다. 닫았다 다시 열어야 최신에서 출발한다).
  const [opened, setOpened] = useState({ values, baseline })
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const baseId = useId()

  function handleOpenChange(next: boolean) {
    if (saving) return // 저장 중에는 닫지 않는다 — 결과를 보기 전에 입력이 사라지면 안 된다.
    if (next) {
      setDraft(values)
      setOpened({ values, baseline })
      setProblem(null)
    }
    setOpen(next)
  }

  async function handleSave() {
    const changed: Partial<Record<K, string>> = {}
    for (const field of fields) {
      const next = draft[field.key].trim()
      if (next !== opened.values[field.key].trim()) changed[field.key] = next
    }
    if (Object.keys(changed).length === 0) {
      toast("바뀐 내용이 없습니다")
      setOpen(false)
      return
    }
    const invalid = validate?.(draft) ?? null
    if (invalid) {
      setProblem(invalid)
      return
    }
    setProblem(null)
    setSaving(true)
    try {
      await onSave(changed, opened.baseline)
      toast.success("저장했어요")
      setOpen(false)
    } catch (error) {
      toastSaveFailure(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="size-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-1">
          {fields.map((field) => {
            const id = `${baseId}-${field.key}`
            return (
              <div key={field.key} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                <Input
                  id={id}
                  value={draft[field.key]}
                  inputMode={field.numeric ? "numeric" : undefined}
                  placeholder={field.placeholder}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                />
                {field.hint ? (
                  <p className="text-xs text-muted-foreground">{field.hint}</p>
                ) : null}
              </div>
            )
          })}
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter className="justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => handleOpenChange(false)}
          >
            취소
          </Button>
          <Button type="button" disabled={saving} onClick={handleSave}>
            {saving ? <Spinner className="size-4" /> : null}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const text = (value: string | number | null | undefined): string =>
  value == null ? "" : `${value}`

// ── 참가사: 기업명 · 부스 ─────────────────────────────────────────────────────
const NAME_FIELDS = [
  { key: "organizationNameKo", label: "기업명(국문)" },
  { key: "organizationNameEn", label: "기업명(영문)" },
] as const

const BOOTH_FIELDS = [
  { key: "hall", label: "Hall", placeholder: "예: 7" },
  { key: "pavilion", label: "관", placeholder: "예: 콘텐츠관" },
  {
    key: "boothLocation",
    label: "부스위치",
    placeholder: "예: 01",
    hint: "미팅 신청 화면에 '참가기업 부스 01 미팅'처럼 표시됩니다.",
  },
  { key: "boothType", label: "부스타입", placeholder: "예: 독립부스" },
  { key: "boothCount", label: "부스개수", placeholder: "예: 2", numeric: true },
] as const

export function ExhibitorOperatorSection({
  profile,
  baseline,
  canEdit,
  isMaster,
  onSave,
}: {
  profile: ExhibitorProfile
  // 패널의 현재 스냅샷 — 다이얼로그가 열 때의 것을 기억했다가 onSave에 함께 넘긴다.
  baseline: OperatorExhibitorApplication
  canEdit: boolean
  // 부스는 master 전용 쓰기다 — sub에게는 값만 보인다(보내면 백엔드가 요청 전체를 403으로 거부한다).
  isMaster: boolean
  onSave: (patch: ExhibitorOperatorPatch, baseline: OperatorExhibitorApplication) => Promise<void>
}) {
  const nameValues = {
    organizationNameKo: text(profile.organizationNameKo),
    organizationNameEn: text(profile.organizationNameEn),
  }
  const boothValues = {
    hall: text(profile.hall),
    pavilion: text(profile.pavilion),
    boothLocation: text(profile.boothLocation),
    boothType: text(profile.boothType),
    boothCount: text(profile.boothCount),
  }

  return (
    <>
      <OperatorSection
        title="기업명"
        description="기업명은 행사 공통 정보입니다 — 이 기업이 참가한 다른 행사에도 같이 바뀝니다."
        action={
          canEdit ? (
            <OperatorFieldsDialog
              triggerLabel="기업명 수정"
              title="기업명 수정"
              description="저장하면 바로 반영됩니다. 신청 상태는 바뀌지 않습니다."
              fields={NAME_FIELDS}
              values={nameValues}
              baseline={baseline}
              validate={(draft) =>
                draft.organizationNameKo.trim() || draft.organizationNameEn.trim()
                  ? null
                  : "기업명(국문)과 기업명(영문)을 둘 다 비울 수는 없습니다."
              }
              onSave={(changed, opened) => onSave(changed, opened)}
            />
          ) : null
        }
      >
        <ValueRow label="기업명(국문)" value={profile.organizationNameKo} />
        <ValueRow label="기업명(영문)" value={profile.organizationNameEn} />
      </OperatorSection>

      <OperatorSection
        title="부스"
        description={
          isMaster
            ? "운영자가 지정합니다. 부스위치는 미팅 신청 화면의 장소 문구에 그대로 쓰입니다."
            : "부스는 슈퍼관리자가 지정합니다 — 이 계정에서는 조회만 됩니다."
        }
        action={
          canEdit && isMaster ? (
            <OperatorFieldsDialog
              triggerLabel="부스 수정"
              title="부스 수정"
              description="비운 칸은 '지정 안 함'으로 저장됩니다. 신청 상태는 바뀌지 않습니다."
              fields={BOOTH_FIELDS}
              values={boothValues}
              baseline={baseline}
              validate={(draft) =>
                /^\d*$/.test(draft.boothCount.trim())
                  ? null
                  : "부스개수는 숫자만 입력해 주세요."
              }
              onSave={({ boothCount, ...rest }, opened) =>
                onSave(
                  {
                    ...rest,
                    // 숫자 칸 — 비우면 지움(null), 아니면 정수로 보낸다(백엔드 booth_count: int).
                    ...(boothCount === undefined
                      ? {}
                      : { boothCount: boothCount === "" ? null : Number(boothCount) }),
                  },
                  opened,
                )
              }
            />
          ) : null
        }
      >
        <ValueRow label="Hall" value={profile.hall} />
        <ValueRow label="관" value={profile.pavilion} />
        <ValueRow label="부스위치" value={profile.boothLocation} />
        <ValueRow label="부스타입" value={profile.boothType} />
        <ValueRow label="부스개수" value={profile.boothCount} />
      </OperatorSection>
    </>
  )
}

// ── 참가사: 담당자 추가 정보 ──────────────────────────────────────────────────
// 참가자 폼의 담당자 칸은 이름(국/영)·직책·이메일·휴대폰 다섯 개다. 나머지(성·부서·영문 직책·전화·
// 메신저·상담 언어)는 저장 컬럼은 있지만 폼에 없어, 운영자가 여기서 본다/고친다.
// 상담 언어 선택지는 백엔드 Lang 7종(app/bm/schemas.py) — 참가자 화면의 2종(영어·베트남어)과 다르다.
const ATTENDEE_LANGUAGE_OPTIONS = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "영어" },
  { code: "zh", label: "중국어" },
  { code: "ja", label: "일본어" },
  { code: "ru", label: "러시아어" },
  { code: "vi", label: "베트남어" },
  { code: "other", label: "기타" },
]
const ATTENDEE_LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  ATTENDEE_LANGUAGE_OPTIONS.map((o) => [o.code, o.label]),
)

const ATTENDEE_EXTRA_FIELDS = [
  { key: "lastNameKo", label: "성(국문)" },
  { key: "lastNameEn", label: "성(영문)" },
  { key: "divisionKo", label: "부서(국문)" },
  { key: "divisionEn", label: "부서(영문)" },
  { key: "titleEn", label: "직책(영문)" },
  { key: "tel", label: "전화" },
  { key: "whatsappId", label: "WhatsApp ID" },
] as const
type AttendeeExtraKey = (typeof ATTENDEE_EXTRA_FIELDS)[number]["key"]

function attendeeHeading(attendee: ExhibitorAttendee, index: number): string {
  const name = [attendee.firstNameKo, attendee.firstNameEn].filter(Boolean).join(" / ")
  return [`담당자 ${index + 1}`, name, attendee.email].filter(Boolean).join(" · ")
}

function attendeeExtraSummary(attendee: ExhibitorAttendee): string {
  const parts = [
    attendee.lastNameKo && `성 ${attendee.lastNameKo}`,
    attendee.lastNameEn && `성(영문) ${attendee.lastNameEn}`,
    [attendee.divisionKo, attendee.divisionEn].filter(Boolean).join(" / "),
    attendee.titleEn && `직책(영문) ${attendee.titleEn}`,
    attendee.tel && `전화 ${attendee.tel}`,
    attendee.whatsappId && `WhatsApp ${attendee.whatsappId}`,
    (attendee.languages?.length ?? 0) > 0 &&
      `언어 ${labelsFor(ATTENDEE_LANGUAGE_LABELS, attendee.languages).join(", ")}`,
  ].filter(Boolean)
  return parts.join(" · ")
}

function AttendeeExtrasDialog({
  attendees,
  baseline,
  onSave,
}: {
  attendees: ExhibitorAttendee[]
  // 패널의 현재 스냅샷 — 열 때의 것을 기억했다가 저장할 때 함께 넘긴다(충돌 검사의 기준).
  baseline: OperatorExhibitorApplication
  // 담당자 **전체 목록**을 받는다(백엔드가 전체 교체라 일부만 보내면 나머지가 삭제된다).
  onSave: (attendees: ExhibitorAttendee[], baseline: OperatorExhibitorApplication) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ExhibitorAttendee[]>(attendees)
  const [opened, setOpened] = useState(baseline)
  const [saving, setSaving] = useState(false)
  const baseId = useId()

  function handleOpenChange(next: boolean) {
    if (saving) return
    if (next) {
      setDraft(attendees)
      setOpened(baseline)
    }
    setOpen(next)
  }

  function update(index: number, patch: Partial<ExhibitorAttendee>) {
    setDraft((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)))
  }

  async function handleSave() {
    setSaving(true)
    try {
      // 목록 전체를 보낸다 — 그 사이 다른 곳에서 담당자가 추가·삭제됐다면 어댑터가 충돌로 막는다
      // (보내면 이 창을 열 때의 목록으로 통째 교체돼 추가분이 사라진다).
      await onSave(draft, opened)
      toast.success("저장했어요")
      setOpen(false)
    } catch (error) {
      toastSaveFailure(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="size-3.5" />
          담당자 추가 정보 수정
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>담당자 추가 정보 수정</DialogTitle>
          <DialogDescription>
            이름·직책·이메일·휴대폰과 담당자 추가·삭제는 아래 &lsquo;기본정보&rsquo; 구획에서 합니다.
            여기서는 그 밖의 칸만 고칩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-1">
          {draft.map((attendee, index) => (
            <fieldset key={index} className="flex flex-col gap-3 rounded-lg border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                {attendeeHeading(attendee, index)}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {ATTENDEE_EXTRA_FIELDS.map((field) => {
                  const id = `${baseId}-${index}-${field.key}`
                  return (
                    <div key={field.key} className="flex flex-col gap-1.5">
                      <Label htmlFor={id}>{field.label}</Label>
                      <Input
                        id={id}
                        value={attendee[field.key as AttendeeExtraKey] ?? ""}
                        disabled={saving}
                        onChange={(e) =>
                          update(index, {
                            // 비운 칸은 값 없음으로 — 목록 전체 교체라 빈 문자열을 남기지 않는다.
                            [field.key]: e.target.value === "" ? undefined : e.target.value,
                          })
                        }
                      />
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">상담 언어</span>
                <ChipToggleGroup
                  options={ATTENDEE_LANGUAGE_OPTIONS}
                  values={attendee.languages as string[] | undefined}
                  onToggle={(code) => {
                    const current = (attendee.languages as string[] | undefined) ?? []
                    const next = current.includes(code)
                      ? current.filter((c) => c !== code)
                      : [...current, code]
                    update(index, { languages: next as ExhibitorAttendee["languages"] })
                  }}
                />
              </div>
            </fieldset>
          ))}
        </div>
        <DialogFooter className="justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => handleOpenChange(false)}
          >
            취소
          </Button>
          <Button type="button" disabled={saving} onClick={handleSave}>
            {saving ? <Spinner className="size-4" /> : null}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExhibitorAttendeeExtrasSection({
  attendees,
  baseline,
  canEdit,
  onSave,
}: {
  attendees: ExhibitorAttendee[]
  baseline: OperatorExhibitorApplication
  canEdit: boolean
  onSave: (attendees: ExhibitorAttendee[], baseline: OperatorExhibitorApplication) => Promise<void>
}) {
  if (attendees.length === 0) return null
  return (
    <OperatorSection
      title="담당자 추가 정보"
      description="참가자 신청서에 없는 담당자 칸입니다(성·부서·영문 직책·전화·메신저·상담 언어)."
      action={
        canEdit ? (
          <AttendeeExtrasDialog attendees={attendees} baseline={baseline} onSave={onSave} />
        ) : null
      }
    >
      {attendees.map((attendee, index) => (
        <div key={index} className="flex flex-col gap-0.5 text-sm">
          <span className="font-medium">{attendeeHeading(attendee, index)}</span>
          <span className="break-words text-xs text-muted-foreground">
            {attendeeExtraSummary(attendee) || "추가 정보 없음"}
          </span>
        </div>
      ))}
    </OperatorSection>
  )
}

// ── 참가사: 미팅 불가 시간 ────────────────────────────────────────────────────
export function UnavailableSlotsSection({
  slots,
  baseline,
  grid,
  editable,
  onSave,
}: {
  // 서버가 확인해 준 현재 불가 시간 전체.
  slots: string[]
  // 패널의 현재 스냅샷 — 칸을 누른 순간의 것을 onSave에 함께 넘긴다(충돌 검사의 기준).
  baseline: OperatorExhibitorApplication
  grid: SlotGridAxes | null
  // master + 편집 권한일 때만 true. 아니면 칸은 보이되 눌리지 않는다.
  editable: boolean
  // 전체 목록을 저장한다(전체 치환). 실패는 reject — 방금 누른 칸을 되돌리고 토스트로 알린다.
  onSave: (slots: string[], baseline: OperatorExhibitorApplication) => Promise<void>
}) {
  // 저장 중에만 쓰는 화면 값. 성공하면 서버 응답(slots)이, 실패하면 옛 값(slots)이 다시 보인다.
  const [pending, setPending] = useState<string[] | null>(null)
  const shown = pending ?? slots
  const visible = new Set(
    grid ? grid.dateIds.flatMap((dateId) => grid.times.map((time) => `${dateId}T${time}`)) : [],
  )
  const offGrid = grid ? shown.filter((slot) => !visible.has(slot)).length : 0

  async function toggle(slot: string) {
    if (!editable || pending) return
    setPending(toggleUnavailableSlot(slots, slot))
    try {
      await onSave(toggleUnavailableSlot(slots, slot), baseline)
    } catch (error) {
      if (isOperatorConflict(error)) {
        // 누른 칸은 저장하지 않았다 — 격자는 패널이 방금 받은 최신 목록으로 이미 바뀌었다.
        toast.error("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요", {
          description: "최신 내용을 불러왔습니다. 방금 누른 칸은 저장하지 않았으니 확인하고 다시 눌러 주세요.",
        })
      } else {
        toast.error("미팅 불가 시간 저장에 실패했어요", {
          description: `${describeOperatorError(error)} 방금 누른 칸은 되돌렸습니다.`,
        })
      }
    } finally {
      setPending(null)
    }
  }

  return (
    <OperatorSection
      title="미팅 불가 시간"
      description={
        editable
          ? "칸을 누르면 바로 저장됩니다. 표시된 칸은 배정 엔진이 비워 둡니다."
          : "미팅 불가 시간은 슈퍼관리자가 지정합니다 — 이 계정에서는 조회만 됩니다."
      }
      action={<Badge variant="outline">불가 {shown.length}칸</Badge>}
    >
      <UnavailableSlotGrid
        grid={grid}
        blocked={shown}
        onToggle={toggle}
        readOnly={!editable || pending !== null}
      />
      {offGrid > 0 ? (
        <p className="text-xs text-muted-foreground">
          현재 격자에 없는 불가 시간이 {offGrid}칸 있습니다(행사 설정이 바뀌어 어긋난 칸) — 표에는 보이지
          않지만 그대로 저장돼 있습니다.
        </p>
      ) : null}
    </OperatorSection>
  )
}

// ── 참가사: 폼에 없는 과거 항목(읽기 전용) ────────────────────────────────────
export function ExhibitorLegacySection({ profile }: { profile: ExhibitorProfile }) {
  const orgTypes = labelsFor(ORG_TYPE_LABELS, profile.orgTypes).join(", ")
  const legacyProducts = (profile.products ?? []).filter(
    (p) => p.categoryKo || p.categoryEn || p.hsDescription,
  )
  if (!orgTypes && legacyProducts.length === 0) return null
  return (
    <OperatorSection
      title="그 밖의 신청 정보"
      description="지금 신청서 양식에는 없는 과거 항목입니다(조회 전용 — 저장해도 값은 그대로 보존됩니다)."
    >
      {orgTypes ? <ValueRow label="참가자 구분" value={orgTypes} /> : null}
      {legacyProducts.map((product, index) => (
        <ValueRow
          key={index}
          label={product.nameKo}
          value={[
            product.categoryKo && `구 카테고리 ${product.categoryKo}`,
            product.categoryEn && `(${product.categoryEn})`,
            product.hsDescription && `HS 품목설명 ${product.hsDescription}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </OperatorSection>
  )
}

// ── 바이어: 사업자등록번호 · 웹사이트 · 주소 ──────────────────────────────────
const BUYER_FIELDS = [
  { key: "businessRegNo", label: "사업자등록번호" },
  { key: "website", label: "웹사이트", placeholder: "https://" },
  { key: "address1", label: "주소" },
  { key: "address2", label: "상세 주소" },
] as const

export function BuyerOperatorSection({
  draft,
  baseline,
  canEdit,
  onSave,
}: {
  draft: BuyerProfileDraft
  // 패널의 현재 스냅샷 — 다이얼로그가 열 때의 것을 기억했다가 onSave에 함께 넘긴다.
  baseline: OperatorBuyerApplication
  canEdit: boolean
  onSave: (patch: BuyerOperatorPatch, baseline: OperatorBuyerApplication) => Promise<void>
}) {
  const values = {
    businessRegNo: draft.businessRegNo,
    website: draft.website,
    address1: draft.address1,
    address2: draft.address2,
  }
  return (
    <OperatorSection
      title="운영자 전용 항목"
      description="바이어 신청서 양식에는 없는 칸입니다. 기업명(소속)은 위 '기본정보' 구획에서 고칩니다. 기업명·사업자등록번호·웹사이트는 행사 공통 정보라 이 기업이 참가한 다른 행사에도 같이 바뀝니다."
      action={
        canEdit ? (
          <OperatorFieldsDialog
            triggerLabel="운영자 전용 항목 수정"
            title="운영자 전용 항목 수정"
            description="저장하면 바로 반영됩니다. 비운 칸은 값이 지워지고, 신청 상태는 바뀌지 않습니다."
            fields={BUYER_FIELDS}
            values={values}
            baseline={baseline}
            onSave={(changed, opened) => onSave(changed, opened)}
          />
        ) : null
      }
    >
      <ValueRow label="사업자등록번호" value={draft.businessRegNo} />
      <ValueRow label="웹사이트" value={draft.website} />
      <ValueRow label="주소" value={draft.address1} />
      <ValueRow label="상세 주소" value={draft.address2} />
    </OperatorSection>
  )
}

// ── 바이어: 폼에 없는 과거 항목(읽기 전용) ────────────────────────────────────
function buyerAttendeeLine(attendee: BuyerAttendeeDraft): string {
  return [
    [attendee.firstName, attendee.lastName].filter(Boolean).join(" "),
    attendee.division,
    attendee.jobTitle,
    attendee.email,
    attendee.tel || attendee.mobile,
    attendee.whatsappId && `WhatsApp ${attendee.whatsappId}`,
    attendee.messengerId && `메신저 ${attendee.messengerId}`,
    attendee.languages.length > 0 &&
      `언어 ${labelsFor(ATTENDEE_LANGUAGE_LABELS, attendee.languages).join(", ")}`,
    attendee.interpreterNeed &&
      `통역 필요${
        attendee.interpreterLanguages.length > 0
          ? `(${labelsFor(ATTENDEE_LANGUAGE_LABELS, attendee.interpreterLanguages).join(", ")})`
          : ""
      }`,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function BuyerLegacySection({ draft }: { draft: BuyerProfileDraft }) {
  const rows: [string, string][] = (
    [
      ["대륙", draft.continent],
      ["도시/주", draft.cityState],
      ["우편번호", draft.zipCode],
      ["전년도 우수 바이어", draft.lastYearBestBuyer],
      ["한국 거래 실적(3년)", labelOf(BUSINESS_PERF_KOREA, draft.businessPerfKorea3y)],
      ["방한 인원(3년)", labelOf(TRAVELERS_KOREA, draft.travelersKorea3y)],
      ["참가 경로", labelFor(PARTICIPATION_ROUTE_LABELS, draft.participationRoute) ?? ""],
      ["신규 유입 경로", labelFor(ACQUISITION_CHANNEL_LABELS, draft.newAcquisitionChannel) ?? ""],
      ["KST 상담시간", draft.kstAvailableTime],
      ["비고", draft.note],
    ] as [string, string][]
  ).filter(([, value]) => value.trim() !== "")

  if (rows.length === 0 && draft.attendees.length === 0 && draft.recommendedBuyers.length === 0) {
    return null
  }
  return (
    <OperatorSection
      title="그 밖의 신청 정보"
      description="지금 신청서 양식에는 없는 과거 항목입니다(조회 전용 — 저장해도 값은 그대로 보존됩니다)."
    >
      {rows.map(([label, value]) => (
        <ValueRow key={label} label={label} value={value} />
      ))}
      {draft.attendees.map((attendee, index) => (
        <ValueRow key={`a-${index}`} label={`참석자 ${index + 1}`} value={buyerAttendeeLine(attendee)} />
      ))}
      {draft.recommendedBuyers.map((buyer, index) => (
        <ValueRow
          key={`r-${index}`}
          label={`추천 바이어 ${index + 1}`}
          value={[
            buyer.organization,
            buyer.personInCharge,
            [buyer.continent, buyer.country].filter(Boolean).join(" "),
            buyer.email,
            buyer.tel,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </OperatorSection>
  )
}
