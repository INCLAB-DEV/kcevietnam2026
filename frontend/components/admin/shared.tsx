"use client"

import { useEffect, useState, type ReactNode } from "react"
import { ChevronDown, Search } from "lucide-react"
import { zonedParts } from "@/lib/timezone"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ADMIN_STATUS_LABELS } from "@/lib/admin/proxy-profile"
import {
  ADMIN_MEETING_STATUS_LABELS,
  type AdminMatchingType,
  type AdminMeetingStatus,
} from "@/lib/admin/types"
import type { ApplicationStatus } from "@/lib/application-status"

// 슈퍼어드민 콘솔 공용 조각. 7개 섹션이 같은 테이블/필터/배지 어휘를 쓰도록 한 곳에 모은다.

// ── 배지 ─────────────────────────────────────────────────────────────────────

// 신청 상태 배지 — 승인=강조, 반려=흐림, 그 외=윤곽선. 운영자 콘솔의 StatusBadge와 같은 시각 규칙.
export function StatusBadge({
  status,
  proxyWritten,
}: {
  status: ApplicationStatus
  proxyWritten?: boolean
}) {
  const variant =
    status === "approved" ? "default" : status === "rejected" ? "secondary" : "outline"
  return (
    <span className="flex items-center gap-1">
      <Badge variant={variant}>{ADMIN_STATUS_LABELS[status]}</Badge>
      {/* 신청 상태와 작성 주체는 별도 축이다. 액션명과 혼동되지 않게 출처를 명시한다. */}
      {proxyWritten && (
        <Badge variant="ghost" className="text-[10px]">
          운영자 작성
        </Badge>
      )}
    </span>
  )
}

export function MeetingStatusBadge({ status }: { status: AdminMeetingStatus }) {
  const variant =
    status === "scheduled"
      ? "default"
      : status === "cancelled"
        ? "secondary"
        : status === "noshow"
          ? "destructive"
          : "outline"
  return <Badge variant={variant}>{ADMIN_MEETING_STATUS_LABELS[status]}</Badge>
}

// 강제/포화 배정 배지 — 운영자가 개입한 미팅(강제배정) · AI가 남은 슬롯을 일괄 채운 미팅(포화배정)을
// 구분 표시한다. open(자유 신청)·on_site(현장)는 배지 없음(기본 경로라 표시할 것이 없다). "ai"를
// 포화배정으로 근사하는 이유는 lib/admin/types.ts의 AdminMatchingType 주석 참고.
export function MatchingTypeBadge({ matchingType }: { matchingType?: AdminMatchingType }) {
  if (matchingType === "forced") return <Badge variant="outline">강제배정</Badge>
  if (matchingType === "ai") return <Badge variant="outline">포화배정</Badge>
  return null
}

// ── 검색 ─────────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300

// 디바운스된 검색 입력. 타이핑마다 필터를 다시 도는 대신 300ms 뒤 한 번만 반영한다.
export function SearchField({
  placeholder,
  onChange,
}: {
  placeholder: string
  onChange: (value: string) => void
}) {
  const [value, setValue] = useState("")

  useEffect(() => {
    const id = setTimeout(() => onChange(value), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
    // onChange는 호출부에서 매 렌더 새로 만들어질 수 있어 의존성에서 뺀다(값 변화만 트리거).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="pl-9"
      />
    </div>
  )
}

// ── 다중 선택 필터 ───────────────────────────────────────────────────────────

// 체크박스 드롭다운 패싯. 운영자 콘솔(members-table)의 필터와 같은 상호작용.
export function FacetFilter<T extends string>({
  label,
  options,
  labels,
  selected,
  onToggle,
}: {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  selected: Set<T>
  onToggle: (value: T) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={label}>
          {label}
          {selected.size > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {selected.size}
            </Badge>
          )}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={selected.has(opt)}
            onCheckedChange={() => onToggle(opt)}
            onSelect={(e) => e.preventDefault()}
          >
            {labels[opt]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Set 토글 헬퍼 — 콘솔 전반에서 패싯 상태를 다룰 때 쓴다.
export function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

// ── 빈 상태 ──────────────────────────────────────────────────────────────────

export function EmptyResult({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

// ── 폼 조각 ──────────────────────────────────────────────────────────────────

// 라벨 + 입력 한 줄. 신청서 편집·행사 폼이 같은 간격·타이포를 쓰게 한다.
export function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  hint?: string
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

// 값 표시 한 줄(읽기 전용 뷰).
export function ReadField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value || "-"}</span>
    </div>
  )
}

// ── 다운로드 ─────────────────────────────────────────────────────────────────

// 브라우저 다운로드 트리거. 직렬화(순수)는 lib/admin/export에서 테스트하고 여기선 DOM 배선만 한다.
export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── 날짜 표시 ────────────────────────────────────────────────────────────────

// ISO8601 → "MM/DD HH:MM" (행사 현지 타임존 기준). 이력 테이블의 시각 표기를 한 곳에서 맞춘다.
// ⚠ Date.getHours() 등 로컬 게터는 쓰지 않는다 — 클라이언트 컴포넌트에서 쓰면 SSR(서버 TZ)과
// 하이드레이션(브라우저 TZ)이 갈려 React #418 hydration 에러가 난다(#M2, timezone-analysis.md §1.5).
export function formatDateTime(iso: string, timeZone: string): string {
  const { date, time } = zonedParts(iso, timeZone)
  if (!date) return iso
  const [, month, day] = date.split("-")
  return `${month}/${day} ${time}`
}
