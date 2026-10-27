"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { HelpHint } from "@/components/help/help-hint"
import { ReviewDecisionActions } from "@/components/review-decision-actions"
import {
  createMember,
  deleteMember,
  exportMembersXlsx,
  getMemberDeletionImpact,
  patchMemberProfile,
  patchMemberStatus,
  setMemberPassword,
  type MemberDeleteResult,
} from "@/lib/organizer/member-actions"
import {
  MEMBER_NOT_FOUND_HINT,
  ORG_NOT_FOUND,
  describeDeletionBlockers,
} from "@/lib/organizer/member-deletion"
import {
  MemberDeleteDialog,
  type MemberDeleteOutcome,
} from "@/components/organizer/member-delete-dialog"
import {
  ContactPasswordDialog,
  ContactPasswordFields,
  checkPasswordPair,
} from "@/components/operator/contact-password"
import { OperatorApplicationPanel } from "@/components/operator/application-panel"
import {
  OPERATOR_CONFLICT_TITLE,
  OPERATOR_PROXY_CONFLICT_HINT,
  describeOperatorLoadError,
} from "@/components/operator/application-operator-sections"
import { useServerValue } from "@/components/operator/use-server-value"
import {
  createOrganizerApplicationTransport,
  createOrganizerMockApplicationTransport,
} from "@/lib/organizer/application-transport"
import {
  hasOrganizerProxyField,
  organizerProxyConflicts,
  organizerProxyHasName,
  organizerProxyServerValues,
  toOrganizerProfilePatch,
  type OrganizerProxyKey,
  type OrganizerProxyValues,
} from "@/lib/organizer/member-profile-patch"
import {
  createOperatorApplicationClient,
  type OperatorApplication,
  type OperatorApplicationTransport,
} from "@/lib/operator/application-client"
import {
  ArrowDownUp,
  ChevronDown,
  Download,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Label } from "@/components/ui/label"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BUSINESS_FIELD_LABELS, CONTENT_CATEGORY_LABELS, labelFor } from "@/lib/bm/fields"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { canReview, hasApplication } from "@/lib/application-status"
import {
  APPLICATION_STATUSES,
  categoryOptions,
  filterMembers,
  MEMBER_SORT_LABELS,
  MEMBER_SORTS,
  MEMBER_TAB_LABELS,
  MEMBER_TABS,
  ORGANIZER_STATUS_LABELS,
  pageCount,
  pageItems,
  paginate,
  sortMembers,
  type ApplicationStatus,
  type MemberRow,
  type MemberSort,
  type MemberTab,
} from "@/lib/organizer/members"
import { toMembersXls } from "@/lib/organizer/members-export"
import { RosterUploadButton } from "@/components/roster/roster-upload"
import type { PermissionLevel } from "@/lib/mock/session"
import type { MemberProfile } from "@/lib/organizer/member-profile"

const SEARCH_DEBOUNCE_MS = 300

interface MembersTableProps {
  members: MemberRow[]
  // 제출 B층 신청서(BM-004/005)의 조회용 픽스처 — **목업 모드 전용**이다(신청서 패널의 인메모리 시드).
  // 실 세션은 넘기지 않는다: 패널이 열 때마다 서버에서 새로 읽는다(목록과 함께 실려 온 값을 편집에 쓰지 않는다).
  profiles?: Record<string, MemberProfile>
  permissionLevel?: PermissionLevel // 기본 master. sub(무역관)는 본인 바이어만·심사 불가(ADR-0012/D20).
  realSession?: boolean
  tradeOffice?: string // sub 관할(등록주체) — 이 무역관이 등록한 바이어만 보인다.
}

// 비즈매칭 상태 배지 — 승인됨=강조, 반려=회색, 그 외=윤곽선(운영자 라벨).
function StatusBadge({ status }: { status: ApplicationStatus }) {
  const variant =
    status === "approved"
      ? "default"
      : status === "rejected"
        ? "secondary"
        : "outline"
  return <Badge variant={variant}>{ORGANIZER_STATUS_LABELS[status]}</Badge>
}

// 탭별 컬럼 정의(F-OP-002 D18). 공통(기업명 국/영·담당자·전화·이메일) +
// 참가사(사업분야) / 바이어(유형·관심분야·언어·체류정보·등록주체) + 상태.
type Column = {
  key: string
  header: string
  align?: "right"
  cell: (row: MemberRow) => ReactNode
}

// 국/영 병기 셀 — 국문(본문) + 영문(작게 아래).
function bilingual(ko?: string | null, en?: string | null): ReactNode {
  if (!ko && !en) return "-"
  return (
    <>
      <span className="font-medium text-foreground">{ko || "-"}</span>
      {en && <span className="block text-xs text-muted-foreground">{en}</span>}
    </>
  )
}

function columnsFor(
  tab: MemberTab,
  onReview: (row: MemberRow) => void
): Column[] {
  const status: Column = {
    key: "status",
    header: "비즈매칭 상태",
    cell: (r) => <StatusBadge status={r.applicationStatus} />,
  }
  // 비즈매칭 신청서 — 제출 이력 행에만 "신청서 조회" 버튼(모달). row 클릭과 충돌 방지로 stopPropagation.
  const review: Column = {
    key: "review",
    header: "비즈매칭 신청서",
    cell: (r) =>
      hasApplication(r.applicationStatus) ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={(e) => {
            e.stopPropagation()
            onReview(r)
          }}
        >
          신청서 조회
        </Button>
      ) : (
        "-"
      ),
  }

  if (tab === "exhibitor") {
    return [
      {
        key: "name",
        header: "기업명",
        cell: (r) => bilingual(r.name, r.nameEn),
      },
      {
        key: "contact",
        header: "담당자",
        cell: (r) => r.primaryContact || "-",
      },
      { key: "phone", header: "전화번호", cell: (r) => r.contactPhone || "-" },
      { key: "email", header: "이메일", cell: (r) => r.contactEmail || "-" },
      {
        key: "booth",
        header: "부스(홀·관·번호)",
        cell: (r) => r.boothLabel || "-",
      },
      {
        key: "contentCategory",
        header: "카테고리",
        cell: (r) => labelFor(CONTENT_CATEGORY_LABELS, r.contentCategory) || "미입력",
      },
      {
        key: "category",
        header: "사업분야",
        cell: (r) => r.productCategory || "-",
      },
      status,
      review,
    ]
  }
  // 바이어 — 사용자 지정 컬럼셋(2026-07-01). 이름/소속/직위는 국·영 병기.
  return [
    {
      key: "buyerName",
      header: "바이어 이름",
      cell: (r) => bilingual(r.primaryContact, r.primaryContactEn),
    },
    { key: "org", header: "소속", cell: (r) => bilingual(r.name, r.nameEn) },
    {
      key: "title",
      header: "직위",
      cell: (r) => bilingual(r.contactTitle, r.contactTitleEn),
    },
    { key: "email", header: "이메일", cell: (r) => r.contactEmail || "-" },
    { key: "buyerType", header: "유형", cell: (r) => r.buyerTypeLabel || "-" },
    {
      key: "category",
      header: "관심분야",
      cell: (r) => r.productCategory || "-",
    },
    { key: "language", header: "언어", cell: (r) => r.language || "-" },
    // 에이전트 4종·체류정보 컬럼은 뺐다(2026-09-10) — 백엔드에 저장소 자체가 없어 항상 "-"였고,
    // 표만 옆으로 길어져 정작 볼 값(담당자·관심분야·상태)이 밀렸다. 그 데이터를 실제로 받게 되면
    // MemberRow에 필드가 그대로 남아 있으니 컬럼만 다시 넣으면 된다.
    {
      key: "registeredBy",
      header: "등록 주체",
      cell: (r) => r.registeredBy || "-",
    },
    status,
    review,
  ]
}

// 단건 등록 폼 입력(F-OP-002 D18). **폼에 보이는 칸 = 서버에 저장되는 칸**이다 — 등록과 대리작성은
// 보내는 요청이 달라 받는 칸도 다르다(예전엔 한 폼이 두 모드에 같은 칸을 보여, 어느 쪽에서도 저장되지
// 않는 칸이 여럿 있었다):
//   · 단건 등록(POST .../organizations)      : 기업명 국/영 · 담당자 성명·전화·이메일 · 비밀번호  ← 이 타입
//   · 대리작성(POST .../proxy-profile, 미신청): 기업명 국/영 · 사업자등록번호 · 웹사이트 · 대표 전화 ·
//       이메일 · 주소 · [참가사] 카테고리 · [바이어] 담당자 성명  ← OrganizerProxyValues
// 그 밖의 신청서 항목은 대리작성 직후 열리는 신청서 편집 패널에서 채운다.
type MemberFormInput = {
  name: string
  nameEn?: string
  primaryContact?: string
  contactPhone?: string
  contactEmail?: string
  // 담당자 계정 비밀번호(선택). 비우면 계정은 생기되 로그인은 안 된다.
  // MemberRow에는 담지 않는다 — 화면 상태로 새어나가지 않게 등록 요청에만 실어 보낸다.
  password?: string
}

// 등록 폼 입력 → MemberRow 필드 패치(목업 모드의 인메모리 명단에 반영 — 실 세션은 서버에서 다시 읽는다).
// 폼이 받은 칸만 옮긴다. 빈 값은 비움(연락 필드는 null, 선택 필드는 undefined).
function inputToFields(input: MemberFormInput): Partial<MemberRow> {
  const fields: Partial<MemberRow> = {
    name: input.name,
    nameEn: input.nameEn || undefined,
  }
  if (input.primaryContact !== undefined) fields.primaryContact = input.primaryContact || null
  if (input.contactPhone !== undefined) fields.contactPhone = input.contactPhone || null
  if (input.contactEmail !== undefined) fields.contactEmail = input.contactEmail || null
  return fields
}

// 대리작성 폼 값 → MemberRow 필드 패치(목업 모드 전용 — 실 세션은 서버에서 다시 읽는다).
// 이 역할의 폼에 있는 칸만 옮긴다. 비운 칸은 건드리지 않는다(대리작성의 빈 칸 = 안 건드림).
function proxyValuesToFields(form: OrganizerProxyValues, tab: MemberTab): Partial<MemberRow> {
  const fields: Partial<MemberRow> = {}
  const filled = (key: OrganizerProxyKey) => hasOrganizerProxyField(tab, key) && form[key].trim() !== ""
  if (filled("name")) fields.name = form.name.trim()
  if (filled("nameEn")) fields.nameEn = form.nameEn.trim()
  if (filled("primaryContact")) fields.primaryContact = form.primaryContact.trim()
  if (filled("contactEmail")) fields.contactEmail = form.contactEmail.trim()
  if (filled("businessRegNo")) fields.businessRegNo = form.businessRegNo.trim()
  if (filled("website")) fields.website = form.website.trim()
  if (filled("mainTel")) fields.mainTel = form.mainTel.trim()
  if (filled("address")) fields.address = form.address.trim()
  if (hasOrganizerProxyField(tab, "contentCategory")) {
    fields.contentCategory = form.contentCategory || null
  }
  return fields
}

function toggleIn<T>(setter: Dispatch<SetStateAction<Set<T>>>, value: T) {
  setter((prev) => {
    const next = new Set(prev)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  })
}

// 브라우저 다운로드 트리거(순수 직렬화는 members-export에서 테스트, 여기선 DOM 배선만).
// content가 Blob이면(서버가 만든 진짜 .xlsx) 그대로 쓰고, 문자열이면(CSV/간이 xls) mime으로 감싼다.
function download(filename: string, content: string | Blob, mime?: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// 백엔드/BFF 에러 코드 → 사람이 읽는 한 줄. 운영자 콘솔은 next-intl을 쓰지 않아(참가자 화면 전용)
// 한글 문구를 그대로 둔다. 모르는 코드는 undefined로 흘려 기본 문구를 쓰게 한다.
function passwordErrorHint(code?: string): string {
  switch (code) {
    case "PASSWORD_POLICY":
      return "비밀번호가 정책(8자 이상, 영문+숫자)에 맞지 않아요."
    case "OPERATOR_ACCOUNT":
      return "운영자 계정의 비밀번호는 이 화면에서 바꿀 수 없어요."
    case "NO_CONTACT_MEMBER":
      return "담당자 이메일이 없어 계정이 없습니다. 먼저 담당자 이메일을 등록해 주세요."
    case "http_403":
      return "관할 밖 기업이라 비밀번호를 바꿀 수 없어요."
    default:
      return "잠시 후 다시 시도해 주세요."
  }
}

// 삭제 거부·실패 안내 — 서버가 준 이유를 옮긴다("미팅이 있어요" 한마디로 뭉개지 않는다).
// 미팅 때문에 막힌 경우는 삭제 확인 다이얼로그와 같은 문구(상태별 건수 + 할 일)를 쓴다.
// "이 행사 명단에 없음"(구조화된 404 ORG_NOT_FOUND)은 실패가 아니라 여기로 오지 않는다(confirmDelete가 따로
// 다룬다). 평문 404(http_404 — 라우팅·배포 불일치 등)는 일반 실패로 여기 온다.
function deleteErrorHint(result: MemberDeleteResult): string {
  if (result.error === "ORG_HAS_MEETINGS") {
    const lines = describeDeletionBlockers({
      scheduledCount: result.scheduledCount ?? 0,
      completedCount: result.completedCount ?? 0,
    })
    if (lines.length > 0) return lines.join(" ")
    return result.message ?? "예정되었거나 완료된 미팅이 있어 삭제할 수 없습니다."
  }
  if (result.error === "ORG_DELETE_CONFLICT") {
    return result.message ?? "다른 작업과 겹쳐 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요."
  }
  if (result.status === 403) return "삭제는 슈퍼관리자만 할 수 있습니다."
  return "삭제에 실패했어요. 잠시 후 다시 시도해 주세요."
}

function createErrorHint(code?: string): string | undefined {
  switch (code) {
    case "PASSWORD_POLICY":
      return "비밀번호가 정책(8자 이상, 영문+숫자)에 맞지 않아요."
    case "PASSWORD_WITHOUT_CONTACT_EMAIL":
      return "비밀번호를 설정하려면 담당자 이메일이 필요해요."
    case "http_403":
    case "forbidden_sub":
      return "서브 운영자는 바이어만 등록할 수 있어요."
    case "http_409":
      return "이미 사용 중인 담당자 이메일이에요."
    default:
      return undefined
  }
}

export function MembersTable({
  members: initialMembers,
  profiles,
  permissionLevel = "master",
  tradeOffice,
  realSession = false,
}: MembersTableProps) {
  const router = useRouter()
  const th = useTranslations("help.hints")
  const isMaster = permissionLevel === "master"
  // sub(무역관)는 바이어 탭만 + 자기 관할 바이어만 본다. 심사(승인/반려/수정요청)는 master 전용.
  const visibleTabs: readonly MemberTab[] = isMaster ? MEMBER_TABS : ["buyer"]
  // 명단은 state — 업로드(멱등 병합)가 목록을 갱신한다. TODO(#50): 초기 시드도 FastAPI 조회로.
  const [members, setMembers] = useState<MemberRow[]>(initialMembers)
  const [tab, setTab] = useState<MemberTab>(isMaster ? "exhibitor" : "buyer")
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<Set<ApplicationStatus>>(new Set())
  const [categories, setCategories] = useState<Set<string>>(new Set())
  const [contentCategories, setContentCategories] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [hasMatchesOnly, setHasMatchesOnly] = useState(false)
  // 기본 정렬 = 승인 상태순 — 운영자가 처리할 것(승인대기중·승인됨)이 위로 오게 한다(가나다 기본은
  // 미신청 stub이 1페이지를 덮어 신청서 조회 버튼이 안 보이는 문제, 사용자 피드백 2026-07-01).
  const [sortBy, setSortBy] = useState<MemberSort>("status")
  const [page, setPage] = useState(1)

  // 목업 모드의 인메모리 정정(실 세션은 서버에서 다시 읽으므로 쓰지 않는다).
  const [edits, setEdits] = useState<Record<string, Partial<MemberRow>>>({})
  // **서버가 삭제를 확인한** 행 — 명단을 다시 읽어 오기 전까지 목록에서 가린다(목업 모드에는 다시 읽을
  // 서버가 없어 이 표시가 곧 삭제다). 서버에 저장되지 않는 "숨김"은 두지 않는다(예전 "비활성화"가 그랬다).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  // 대리작성 대상 — 미신청(registered) 행의 "수정"이 여는 간이 대리작성 다이얼로그.
  const [editing, setEditing] = useState<MemberRow | null>(null)
  const [deleting, setDeleting] = useState<MemberRow | null>(null)
  // 신청서 조회·심사·수정 — "신청서 조회"와 (신청서가 있는 행의) "수정"이 같은 다이얼로그를 연다.
  // 심사 결정(master)은 인메모리 오버라이드(낙관적).
  const [reviewing, setReviewing] = useState<MemberRow | null>(null)
  // 목업 모드의 신청서 저장소(기업별 인메모리 전송). 실 세션에서는 쓰지 않는다.
  const [mockTransports] = useState(() => new Map<string, OperatorApplicationTransport>())
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, ApplicationStatus>
  >({})

  // 단건 등록 — 참가사/바이어 모두. sub는 바이어 탭만 보이므로 자연히 바이어만 등록(ADR-0012/D20).
  const [registerOpen, setRegisterOpen] = useState(false)
  // 비밀번호 설정 대상 행 — 열려 있는 동안에만 값이 있다(평문은 다이얼로그 안에서만 산다).
  const [passwordTarget, setPasswordTarget] = useState<MemberRow | null>(null)
  const newIdRef = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [queryInput])

  // 탭 전환 시 패싯(상태·카테고리) 초기화 + 1페이지로. (탭마다 카테고리 셋이 다르다)
  function changeTab(value: string) {
    setTab(value as MemberTab)
    setStatuses(new Set())
    setCategories(new Set())
    setContentCategories(new Set())
    setPage(1)
  }

  // 정정·삭제를 반영한 유효 행. 서버가 삭제를 확인한 행은 목록에서 빠진다.
  const effective = useMemo(
    () =>
      (realSession ? initialMembers : members)
        .filter((m) => !deletedIds.has(m.id))
        // sub(무역관)는 자기 관할(등록주체 = 내 무역관)인 바이어만 본다(ADR-0012/D20).
        .filter(
          (m) =>
            isMaster || (m.tab === "buyer" && (realSession || m.registeredBy === tradeOffice))
        )
        .map((m) => {
          const e = edits[m.id]
          const s = statusOverrides[m.id]
          if (!e && !s) return m
          return { ...m, ...(e ?? {}), ...(s ? { applicationStatus: s } : {}) }
        }),
    [members, initialMembers, deletedIds, edits, statusOverrides, isMaster, tradeOffice, realSession]
  )

  const categoryOpts = categoryOptions()

  const sorted = useMemo(() => {
    const filtered = filterMembers(effective, tab, {
      query,
      statuses: [...statuses],
      categories: [...categories],
      contentCategories: [...contentCategories],
      hasMatchesOnly,
    })
    return sortMembers(filtered, sortBy)
  }, [effective, tab, query, statuses, categories, contentCategories, hasMatchesOnly, sortBy])

  const activeFacetCount =
    statuses.size + categories.size + contentCategories.size + (hasMatchesOnly ? 1 : 0)

  // 페이지네이션: 결과가 줄면 현재 페이지를 클램프해 빈 화면을 막는다(렌더 시점 보정).
  const totalPages = pageCount(sorted.length)
  const safePage = Math.min(page, totalPages)
  const pageRows = paginate(sorted, safePage)
  const columns = columnsFor(tab, setReviewing)

  function resetFilters() {
    setStatuses(new Set())
    setCategories(new Set())
    setContentCategories(new Set())
    setHasMatchesOnly(false)
    setPage(1)
  }

  // 기업 하나의 신청서 전송. 실 세션이면 같은 출처 BFF(→ FastAPI), 목업이면 명단 픽스처를 심은 인메모리.
  function transportFor(row: MemberRow): OperatorApplicationTransport {
    if (realSession) return createOrganizerApplicationTransport(row.id)
    let transport = mockTransports.get(row.id)
    if (!transport) {
      transport = createOrganizerMockApplicationTransport(row, profiles?.[row.id] ?? null)
      mockTransports.set(row.id, transport)
    }
    return transport
  }

  // 패널 저장이 서버에서 확정된 뒤 — 실 세션은 명단을 서버에서 다시 읽는다. 목업에는 다시 읽을 서버가
  // 없어, 저장 결과의 기업명만 인메모리 명단에 옮긴다.
  function applySavedApplication(id: string, application: OperatorApplication) {
    if (realSession) {
      router.refresh()
      return
    }
    const names =
      application.role === "exhibitor"
        ? { ko: application.profile.organizationNameKo, en: application.profile.organizationNameEn }
        : { ko: application.draft.organizationNameKo, en: application.draft.organizationNameEn }
    setEdits((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? {}),
        ...(names.ko ? { name: names.ko } : {}),
        nameEn: names.en || undefined,
      },
    }))
  }

  // 미신청(registered) 기업의 대리작성 — POST .../proxy-profile. master면 승인, sub면 승인 대기로 전환된다.
  //
  // **서버가 확인한 뒤에만** 화면을 바꾼다. 실패하면 다이얼로그와 입력을 그대로 둔다(false를 돌려준다).
  // 보낼 칸이 하나도 없어도 요청을 보낸다 — 대리작성의 본체는 상태 전이라, 보내지 않고 화면만
  // "승인됨"으로 바꾸면 저장된 척이 된다(예전에 그랬다: 보낼 필드가 없으면 요청을 생략하고도 상태 배지를 바꿨다).
  //
  // 본문에는 **다이얼로그를 열 때 읽은 서버 값(server)과 달라진 칸만** 싣는다. 미신청은 참가자가 신청서를
  // 작성하는 중일 수 있어, 폼에 값이 있다고 전부 보내면 참가자의 초안을 명단 값으로 덮는다(예전 동작).
  // 보내기 직전에 서버를 한 번 더 읽어, 보내려는 칸이 그 사이 달라졌으면 보내지 않고 충돌로 알린다
  // (클라이언트 쪽 검사 — lib/operator/application-client "동시 수정 검사"). 다시 읽지 못하면 보내지 않는다.
  //
  // 성공하면 곧바로 같은 기업의 신청서 편집 패널을 연다 — 이 폼에 없는 항목을 이어서 채울 수 있게.
  async function proxyWriteMember(
    form: OrganizerProxyValues,
    server: OrganizerProxyValues,
  ): Promise<boolean> {
    if (!editing) return false
    const row = editing
    const profilePatch = toOrganizerProfilePatch(form, server, row.tab)
    let latest: OrganizerProxyValues
    try {
      latest = organizerProxyServerValues((await transportFor(row).getDetail()).detail, row.tab)
    } catch (error) {
      toast.error("대리작성을 저장하지 못했어요", {
        description: `서버의 현재 값을 확인하지 못해 보내지 않았습니다. ${describeOperatorLoadError(error)} 입력은 그대로 남아 있습니다.`,
      })
      return false
    }
    if (organizerProxyConflicts(profilePatch, server, latest, row.tab).length > 0) {
      toast.error(OPERATOR_CONFLICT_TITLE, { description: OPERATOR_PROXY_CONFLICT_HINT })
      return false
    }
    const result = await patchMemberProfile(row.id, row.tab, profilePatch)
    if (!result.success) {
      toast.error("대리작성을 저장하지 못했어요", {
        description:
          result.error === "http_403"
            ? "이 기업을 수정할 권한이 없습니다. 입력은 그대로 남아 있습니다."
            : "입력은 그대로 남아 있으니 잠시 후 다시 시도해 주세요.",
      })
      return false
    }
    const nextStatus: ApplicationStatus = isMaster ? "approved" : "submitted"
    if (!realSession) {
      // 목업에는 저장할 서버가 없다 — 인메모리 명단과, 이어서 열리는 패널의 인메모리 전송에 반영한다.
      setEdits((prev) => ({
        ...prev,
        [row.id]: { ...(prev[row.id] ?? {}), ...proxyValuesToFields(form, row.tab) },
      }))
      await transportFor(row).patchProfile(row.tab, profilePatch)
    }
    setStatusOverrides((prev) => ({ ...prev, [row.id]: nextStatus }))
    toast(`'${row.name}' 신청서를 대리작성했어요`, {
      description: `상태가 '${ORGANIZER_STATUS_LABELS[nextStatus]}'(으)로 바뀌었습니다. 이어서 나머지 항목을 채울 수 있어요.`,
    })
    setEditing(null)
    setReviewing({ ...row, applicationStatus: nextStatus })
    if (realSession) router.refresh()
    return true
  }

  // 삭제: 확인 다이얼로그가 부른다. **서버가 삭제를 확인한 뒤에만** 목록에서 뺀다(서버-authoritative).
  // 낙관적으로 먼저 지우면 실패 때 "삭제된 것처럼 보이는데 실제론 안 됨" 오해가 생기므로(사용자 피드백
  // 2026-09-09), 삭제는 승인(decide)과 달리 서버 확정 후 반영한다.
  //
  // 서버가 거부하면 행과 다이얼로그를 그대로 두고 **서버가 준 이유**를 알린다. 다이얼로그가 미리보기를 읽은
  // 뒤 미팅이 확정으로 바뀐 경우도 여기로 온다(409 ORG_HAS_MEETINGS + 상태별 건수) — 그때는 다이얼로그도
  // 막힘 상태로 바뀐다(MemberDeleteDialog).
  //
  // 서버가 "이 행사 명단에 그 기업이 없다"(구조화된 404 ORG_NOT_FOUND)고 하면 실패가 아니다. 다만 404만으로는
  // 다른 운영자가 먼저 지웠는지, 다른 탭에서 행사가 바뀌어 요청이 다른 행사로 갔는지 모른다(선택 행사는 쿠키다).
  // 그래서 행을 임의로 숨기지 않고(deletedIds에 넣지 않는다) 다이얼로그를 내린 뒤 명단을 서버에서 다시 읽고,
  // 삭제 완료·실패와 다른 안내를 단정하지 않는 말로 띄운다.
  async function confirmDelete(row: MemberRow): Promise<MemberDeleteOutcome> {
    const result = await deleteMember(row.id)
    if (result.success) {
      setDeletedIds((prev) => new Set(prev).add(row.id))
      setDeleting(null)
      toast(`'${row.name}'을(를) 삭제했어요`)
      // 실 세션은 명단을 서버에서 다시 읽는다(목업 모드에는 다시 읽을 서버가 없다).
      if (realSession) router.refresh()
      return { status: "deleted" }
    }
    if (result.error === ORG_NOT_FOUND) {
      setDeleting(null)
      reloadMembers()
      toast.info(`'${row.name}'을(를) 이 행사 명단에서 찾을 수 없어요`, {
        description: MEMBER_NOT_FOUND_HINT,
      })
      return { status: "not_found" }
    }
    toast.error(`'${row.name}'을(를) 삭제하지 못했어요`, {
      description: deleteErrorHint(result),
    })
    const scheduledCount = result.scheduledCount ?? 0
    const completedCount = result.completedCount ?? 0
    if (result.error === "ORG_HAS_MEETINGS" && scheduledCount + completedCount > 0) {
      return { status: "blocked", scheduledCount, completedCount }
    }
    return { status: "failed" }
  }

  // 명단을 서버에서 다시 읽는다 — 삭제·삭제 영향 미리보기가 "이 행사 명단에 없음"(구조화된 404)일 때. 행을
  // 숨기지 않는다: 정말 지워졌으면 새 명단에서 빠지고, 행사가 바뀌었으면 바뀐 행사의 명단이 보인다.
  // 목업 모드에는 다시 읽을 서버가 없다(목업 BFF는 이 404를 내지 않는다).
  function reloadMembers() {
    if (realSession) router.refresh()
  }

  // 승인 심사 결정 — 신청서 조회 모달에서 승인/반려/수정요청(master). 인메모리 오버라이드로 즉시
  // 반영(낙관적) + PATCH로 서버 영속(새로고침 후 유지). 서버 실패는 토스트로만 알린다(비차단 —
  // 목업 단계에선 인메모리가 원래 소스라 화면 판정은 유지).
  function decide(status: ApplicationStatus, note?: string) {
    if (!reviewing) return
    const row = reviewing
    setStatusOverrides((prev) => ({ ...prev, [row.id]: status }))
    const verb =
      status === "approved"
        ? "승인"
        : status === "rejected"
          ? "반려"
          : "수정요청"
    toast(`'${row.name}' 신청서를 ${verb}했어요`, { description: note })
    setReviewing(null)
    if (
      status === "approved" ||
      status === "rejected" ||
      status === "changes_requested"
    ) {
      void patchMemberStatus(row.id, status, note).then((result) => {
        if (!result.success) {
          toast.error(`'${row.name}' 상태 저장에 실패했어요`, {
            description:
              "새로고침 시 이전 상태로 보일 수 있어요. 다시 시도해 주세요.",
          })
        }
      })
    }
  }

  // 단건 등록 — A층 폼 입력을 새 MemberRow(미신청)로 만들어 목록에 추가. 바이어는 등록주체를 자동 기록
  // (sub면 자기 무역관, master면 직접등록). B층 신청서는 회사가 직접 작성하므로 status는 registered.
  // 인메모리 낙관적 갱신 + 서버 영속(비차단 — decide()와 동일 원칙, 실패는 토스트만).
  // 등록됐으면 true — 폼은 이 값이 true일 때만 입력을 비운다(실 세션에서 실패하면 폼과 입력이 남는다).
  async function registerMember(input: MemberFormInput): Promise<boolean> {
    if (realSession) {
      const result = await createMember({
        name: input.name,
        nameEn: input.nameEn || undefined,
        role: tab,
        contactName: input.primaryContact || undefined,
        contactEmail: input.contactEmail || undefined,
        contactPhone: input.contactPhone || undefined,
        password: input.password || undefined,
      })
      if (!result.success) {
        toast.error("기업 등록에 실패했어요", {
          description: createErrorHint(result.error),
        })
        return false
      }
      toast(`'${input.name}'을(를) 등록했어요`, {
        description: input.password
          ? "담당자 이메일·비밀번호로 바로 로그인할 수 있어요"
          : undefined,
      })
      setRegisterOpen(false)
      router.refresh()
      return true
    }
    const row: MemberRow = {
      id: `new-${tab}-${++newIdRef.current}`,
      name: input.name,
      tab,
      applicationStatus: "registered",
      primaryContact: null,
      contactPhone: null,
      contactEmail: null,
      productCategory: null,
      importedAt: new Date().toISOString(),
      profileCompletion: 0,
      matchCount: 0,
      lastActivityAt: null,
      ...inputToFields(input),
      ...(tab === "buyer"
        ? { registeredBy: isMaster ? "직접등록" : (tradeOffice ?? "직접등록") }
        : {}),
    }
    setMembers((prev) => [row, ...prev])
    toast(`'${row.name}'을(를) 등록했어요`, {
      description: "미신청 상태로 추가됐습니다",
    })
    setRegisterOpen(false)
    void createMember({
      name: input.name,
      nameEn: input.nameEn || undefined,
      role: tab,
      contactName: input.primaryContact || undefined,
      contactEmail: input.contactEmail || undefined,
      contactPhone: input.contactPhone || undefined,
      password: input.password || undefined,
    }).then((result) => {
      if (!result.success) {
        toast.error(`'${row.name}' 등록이 서버에 반영되지 않았어요`, {
          description: createErrorHint(result.error) ?? "새로고침 시 사라질 수 있어요. 다시 시도해 주세요.",
        })
      }
    })
    return true
  }

  // 담당자 계정 비밀번호 설정/재설정 — 행 작업 메뉴에서 연다. 실패하면 다이얼로그를 열어둔 채
  // 토스트로 사유를 알린다(성공한 척 닫지 않는다 — "바꿨는데 로그인이 안 된다"를 만들지 않기 위해).
  async function submitPassword(row: MemberRow, password: string): Promise<boolean> {
    const result = await setMemberPassword(row.id, password)
    if (!result.success) {
      toast.error(`'${row.name}' 비밀번호 설정에 실패했어요`, {
        description: passwordErrorHint(result.error),
      })
      return false
    }
    toast(`'${row.name}' 담당자 비밀번호를 설정했어요`, {
      description: result.contactEmail
        ? `${result.contactEmail} 계정으로 바로 로그인할 수 있어요`
        : "새 비밀번호로 바로 로그인할 수 있어요",
    })
    return true
  }

  const xlsName = `sales-ai-${tab}-명단.xls`

  // 실 세션은 필터·전체 정렬 순서를 서버에 전달한다. mock에서만 로컬 파일을 만든다.
  async function handleExportExcel() {
    if (exporting) return
    if (!realSession) {
      download(xlsName, toMembersXls(sorted), "application/vnd.ms-excel")
      return
    }
    setExporting(true)
    try {
      const xlsx = await exportMembersXlsx({
        tab, query, statuses: [...statuses], content_categories: [...contentCategories],
        business_fields: [...categories].map((value) => Object.entries(BUSINESS_FIELD_LABELS).find(([code, label]) => code === value || label === value)?.[0] ?? value),
        has_matches_only: hasMatchesOnly, sort: sortBy, ordered_ids: sorted.map((r) => r.id),
      })
      if (!xlsx) { toast.error("엑셀 내보내기에 실패했어요. 다시 시도해 주세요."); return }
      download(`참가기업_명단_${tab}_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsx)
    } finally { setExporting(false) }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* 데이터 입출력 액션(업로드·내보내기) — 현재 탭 기준 내보내기. */}
      <div className="flex justify-end gap-2" data-tour="members-export">
        {/* 내보내기는 엑셀 하나로 — CSV는 서식이 없어 명단으로 쓰기 나빴다(2026-09-10 결정). */}
        <HelpHint hint={th("membersExport")} side="left">
          <Button
            variant="outline"
            size="sm"
            disabled={exporting}
            onClick={() => void handleExportExcel()}
          >
            <Download data-icon="inline-start" />
            엑셀로 내보내기
          </Button>
        </HelpHint>
        {/* 단건 등록 — POST .../organizations는 이 행사의 운영자(master·sub) 공용이다(명단 업로드와
            같은 규칙, 2026-09-21). sub는 바이어 탭만 보이므로 역할 선택이 자연히 바이어로 묶인다
            (백엔드 check_create_jurisdiction도 sub의 참가사 등록을 403으로 막는다). */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRegisterOpen(true)}
        >
          <Plus data-icon="inline-start" />
          단건 등록
        </Button>
        {/* 명단 업로드 — /admin/organizations와 같은 버튼·다이얼로그·API(components/roster). 행사는
            BFF가 운영자의 첫 행사로 정한다(이 화면의 명단 조회와 같은 해석). master+sub 공용(관할은
            백엔드가 행 단위로 거른다) — 여기선 감추지 않는다. */}
        <RosterUploadButton />
      </div>

      <Tabs value={tab} onValueChange={changeTab} className="w-full">
        <TabsList
          variant="line"
          className="w-full justify-start"
          data-tour="members-tabs"
        >
          {visibleTabs.map((t) => (
            <TabsTrigger key={t} value={t}>
              {MEMBER_TAB_LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>

        {visibleTabs.map((t) => (
          <TabsContent key={t} value={t} className="flex flex-col gap-4 pt-2">
            {/* 검색 */}
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="기업명(국/영)으로 검색"
                value={queryInput}
                onChange={(e) => {
                  setQueryInput(e.target.value)
                  setPage(1)
                }}
                className="pl-9"
                data-tour="members-search"
              />
            </div>

            {/* 필터 */}
            <div
              className="flex flex-wrap items-center gap-2"
              data-tour="members-filters"
            >
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="승인 상태">
                    승인 상태
                    {statuses.size > 0 && (
                      <Badge variant="secondary" className="ml-1 px-1.5">
                        {statuses.size}
                      </Badge>
                    )}
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {APPLICATION_STATUSES.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s}
                      checked={statuses.has(s)}
                      onCheckedChange={() => {
                        toggleIn(setStatuses, s)
                        setPage(1)
                      }}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {ORGANIZER_STATUS_LABELS[s]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {tab === "exhibitor" && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="카테고리">
                      카테고리
                      {contentCategories.size > 0 && <Badge variant="secondary">{contentCategories.size}</Badge>}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuGroup>
                      {Object.entries(CONTENT_CATEGORY_LABELS).map(([code, label]) => (
                        <DropdownMenuCheckboxItem key={code} checked={contentCategories.has(code)}
                          onCheckedChange={() => { toggleIn(setContentCategories, code); setPage(1) }}
                          onSelect={(e) => e.preventDefault()}>{label}</DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {categoryOpts.length > 0 && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      {tab === "exhibitor" ? "사업분야" : "관심분야"}
                      {categories.size > 0 && (
                        <Badge variant="secondary" className="ml-1 px-1.5">
                          {categories.size}
                        </Badge>
                      )}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuGroup>
                    {categoryOpts.map((opt) => (
                      <DropdownMenuCheckboxItem
                        key={opt}
                        checked={categories.has(opt)}
                        onCheckedChange={() => {
                          toggleIn(setCategories, opt)
                          setPage(1)
                        }}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {opt}
                      </DropdownMenuCheckboxItem>
                    ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <Button
                type="button"
                size="sm"
                variant={hasMatchesOnly ? "default" : "outline"}
                aria-pressed={hasMatchesOnly}
                onClick={() => {
                  setHasMatchesOnly((v) => !v)
                  setPage(1)
                }}
              >
                매칭 보유만
              </Button>
              {activeFacetCount > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={resetFilters}
                >
                  초기화
                </Button>
              )}

              {/* 정렬 (우측) */}
              <div className="ml-auto flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <ArrowDownUp data-icon="inline-start" />
                      {MEMBER_SORT_LABELS[sortBy]}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={sortBy}
                      onValueChange={(v) => {
                        setSortBy(v as MemberSort)
                        setPage(1)
                      }}
                    >
                      {MEMBER_SORTS.map((s) => (
                        <DropdownMenuRadioItem key={s} value={s}>
                          {MEMBER_SORT_LABELS[s]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* 목록 */}
            {sorted.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>검색 결과가 없습니다</EmptyTitle>
                  <EmptyDescription>
                    다른 검색어나 필터를 시도해보세요.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  {sorted.length}개 기업
                  {totalPages > 1 && ` · ${safePage}/${totalPages} 페이지`}
                </span>
                <div className="overflow-x-auto rounded-lg border">
                  <Table
                    className={
                      tab === "buyer" ? "min-w-[1600px]" : "min-w-[1000px]"
                    }
                    data-tour="members-table"
                  >
                    <TableHeader>
                      <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                        {columns.map((c) => (
                          <TableHead
                            key={c.key}
                            className={
                              c.align === "right" ? "text-right" : undefined
                            }
                          >
                            {c.header}
                          </TableHead>
                        ))}
                        <TableHead className="w-10" aria-label="작업" />
                      </TableRow>
                    </TableHeader>
                    <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
                      {pageRows.map((row) => (
                        <TableRow
                          key={row.id}
                          className={`cursor-pointer ${row.applicationStatus === "rejected" ? "opacity-60" : ""}`}
                          onClick={() =>
                            router.push(`/organizer/members/${row.id}`)
                          }
                        >
                          {columns.map((c) => (
                            <TableCell
                              key={c.key}
                              className={`${c.align === "right" ? "text-right tabular-nums" : ""} ${
                                c.key === "name" ? "" : "text-muted-foreground"
                              }`}
                            >
                              {c.cell(row)}
                            </TableCell>
                          ))}
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              {/* 수정 — 신청서가 있는 행(제출·보완요청·승인·반려)은 "신청서 조회"와 같은
                                  패널을 열어 모든 항목을 고친다. 미신청 행은 대리작성(상태 전이)이 먼저다. */}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs"
                                onClick={() =>
                                  row.applicationStatus === "registered"
                                    ? setEditing(row)
                                    : setReviewing(row)
                                }
                              >
                                수정
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`${row.name} 작업`}
                                  >
                                    <MoreHorizontal />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {/* 비밀번호 설정 — 담당자 계정의 로그인 비밀번호를 새로 정한다.
                                      master는 모든 행, sub는 자기 관할 바이어만(백엔드가 관할을
                                      판정하지만 눌러서 403만 보는 버튼은 애초에 감춘다). */}
                                  {(isMaster || row.tab === "buyer") && (
                                    <DropdownMenuItem
                                      onSelect={() => setPasswordTarget(row)}
                                    >
                                      비밀번호 설정
                                    </DropdownMenuItem>
                                  )}
                                  {/* "비활성화"는 없앴다 — 화면에서 행만 숨기고 서버에는 아무것도 저장하지
                                      않아, 새로고침하면 돌아오고 배정 대상에서도 빠지지 않았다(2026-10-08). */}
                                  {/* 삭제 — DELETE .../organizations/{id}도 require_event_master 전용
                                      (app/admin/router.py). sub에겐 눌러도 403인 버튼을 감춘다. */}
                                  {isMaster && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() => setDeleting(row)}
                                      >
                                        삭제
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {totalPages > 1 && (
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          text="이전"
                          href="#"
                          aria-disabled={safePage === 1}
                          className={
                            safePage === 1
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                          onClick={(e) => {
                            e.preventDefault()
                            setPage((p) => Math.max(1, p - 1))
                          }}
                        />
                      </PaginationItem>
                      {pageItems(safePage, totalPages).map((item, i) =>
                        item === "ellipsis" ? (
                          <PaginationItem key={`e-${i}`}>
                            <PaginationEllipsis />
                          </PaginationItem>
                        ) : (
                          <PaginationItem key={item}>
                            <PaginationLink
                              href="#"
                              isActive={item === safePage}
                              onClick={(e) => {
                                e.preventDefault()
                                setPage(item)
                              }}
                            >
                              {item}
                            </PaginationLink>
                          </PaginationItem>
                        )
                      )}
                      <PaginationItem>
                        <PaginationNext
                          text="다음"
                          href="#"
                          aria-disabled={safePage === totalPages}
                          className={
                            safePage === totalPages
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                          onClick={(e) => {
                            e.preventDefault()
                            setPage((p) => Math.min(totalPages, p + 1))
                          }}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                )}
              </>
            )}
          </TabsContent>
        ))}

        {/* 신청서 조회 · 심사 · 수정 — 본문은 관리자 콘솔과 함께 쓰는 패널(열 때마다 서버에서 새로 읽는다).
            머리말·심사 버튼은 명단의 현재 행(심사 결정·새로고침이 반영된 값)을 따른다. */}
        {reviewing && (
          <ReviewModal
            key={reviewing.id}
            row={effective.find((m) => m.id === reviewing.id) ?? reviewing}
            createTransport={() => transportFor(reviewing)}
            canDecide={isMaster}
            isMaster={isMaster}
            onOpenChange={(open) => !open && setReviewing(null)}
            onDecide={decide}
            onSaved={(application) => applySavedApplication(reviewing.id, application)}
          />
        )}

        {/* 대리작성 다이얼로그 — 미신청 행 전용(저장되는 칸만). 행마다 key로 다시 마운트해, 열 때마다
            서버의 현재 프로필을 읽는다. */}
        {editing && (
          <ProxyMemberDialog
            key={editing.id}
            row={editing}
            approveImmediately={isMaster}
            loadServerValues={async () =>
              organizerProxyServerValues((await transportFor(editing).getDetail()).detail, editing.tab)
            }
            onOpenChange={(open) => !open && setEditing(null)}
            onSubmit={proxyWriteMember}
          />
        )}

        {/* 삭제 확인 다이얼로그 — 열 때마다(닫으면 내려가고, 대상이 바뀌면 key로 다시 마운트) 서버에서 삭제
            영향을 읽어, 무엇이 막는지·무엇이 함께 지워지는지 보여 준 뒤에만 삭제를 받는다. 이 행사 명단에 없는
            기업이면(미리보기 404 ORG_NOT_FOUND) 다이얼로그가 안내를 띄우고 reloadMembers로 명단을 다시 읽는다. */}
        {deleting && (
          <MemberDeleteDialog
            key={deleting.id}
            name={deleting.name}
            loadImpact={() => getMemberDeletionImpact(deleting.id)}
            onOpenChange={(open) => !open && setDeleting(null)}
            onConfirm={() => confirmDelete(deleting)}
            reloadMembers={reloadMembers}
          />
        )}
      </Tabs>

      {/* 단건 등록 다이얼로그 (현재 탭 기준 — 참가사/바이어) */}
      <MemberFormDialog
        tab={tab}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onSubmit={registerMember}
      />

      {/* 비밀번호 설정 다이얼로그 — 대상이 있을 때만 마운트해(key=행 id) 입력이 행 사이에 남지 않게 한다. */}
      {passwordTarget && (
        <ContactPasswordDialog
          key={passwordTarget.id}
          open
          onOpenChange={(open) => !open && setPasswordTarget(null)}
          orgName={passwordTarget.name}
          contactEmail={passwordTarget.contactEmail}
          onSubmit={(password) => submitPassword(passwordTarget, password)}
        />
      )}
    </div>
  )
}

// 단건 등록 폼(F-OP-002 D18) — 한 건을 미신청 상태로 등록한다. **서버에 저장되는 칸만** 그린다
// (MemberFormInput 주석). 신청서 항목은 받지 않는다 — 등록 뒤 행의 "수정"(대리작성)이나 기업이 직접
// 작성하는 신청서에서 입력한다.
// onSubmit은 서버 확인까지 기다려 성공 여부를 돌려준다 — 실패하면 폼과 입력을 유지한다.
function MemberFormDialog({
  tab,
  open,
  onOpenChange,
  onSubmit,
}: {
  tab: MemberTab
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: MemberFormInput) => Promise<boolean>
}) {
  const isExhibitor = tab === "exhibitor"
  const [name, setName] = useState("")
  const [nameEn, setNameEn] = useState("")
  const [primaryContact, setPrimaryContact] = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [contactEmail, setContactEmail] = useState("")
  // 담당자 계정 비밀번호 — 등록 이후 변경은 행 작업 메뉴의 "비밀번호 설정".
  // 선택 입력: 비우면 계정은 생기되 로그인은 안 된다(백엔드 password_hash NULL).
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [attempted, setAttempted] = useState(false)
  // 서버 응답을 기다리는 동안 — 등록 버튼 재클릭과 닫기를 막는다.
  const [submitting, setSubmitting] = useState(false)
  const wantsPassword = password.length > 0 || passwordConfirm.length > 0
  const passwordState = checkPasswordPair(password, passwordConfirm, { required: false })
  // 비밀번호만 넣고 이메일을 비우면 걸 계정이 없어 백엔드가 422로 되돌린다
  // (PASSWORD_WITHOUT_CONTACT_EMAIL) — 왕복하기 전에 여기서 막고 이유를 보여준다.
  const passwordNeedsEmail = wantsPassword && contactEmail.trim().length === 0

  function reset() {
    setName("")
    setNameEn("")
    setPrimaryContact("")
    setContactPhone("")
    setContactEmail("")
    setPassword("")
    setPasswordConfirm("")
    setAttempted(false)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setAttempted(true)
    // 비밀번호 입력이 온전하지 않으면 제출하지 않는다 — 오타 하나로 로그인 불가 계정이 생기는 걸 막는다.
    if (!passwordState.ready || passwordNeedsEmail) return
    const input: MemberFormInput = {
      name: name.trim(),
      nameEn: nameEn.trim(),
      primaryContact: primaryContact.trim(),
      contactPhone: contactPhone.trim(),
      contactEmail: contactEmail.trim(),
      ...(password ? { password } : {}),
    }
    setSubmitting(true)
    let saved = false
    try {
      saved = await onSubmit(input)
    } finally {
      setSubmitting(false)
    }
    // 등록이 실패하면 입력을 비우지 않는다 — 폼이 열린 채 남아 그 자리에서 다시 시도할 수 있다.
    if (saved) reset()
  }

  const roleNoun = isExhibitor ? "참가사" : "바이어"
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 저장 결과를 보기 전에 닫히면 입력이 사라진다 — 응답이 올 때까지 닫지 않는다.
        if (submitting) return
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`${roleNoun} 단건 등록`}</DialogTitle>
          <DialogDescription>
            {"한 건씩 직접 등록합니다. 등록 직후 비즈매칭 신청 전까지 미신청 상태이며, 사업자등록번호·주소 등 신청서 항목은 등록 후 행의 '수정'(대리작성)이나 기업이 직접 작성하는 신청서에서 입력합니다."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5">
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-name">기업명(국문)</Label>
                <Input
                  id="reg-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-name-en">기업명(영문)</Label>
                <Input
                  id="reg-name-en"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                />
              </div>
            </div>
            {/* 담당자 성명 — 담당자 계정의 이름. */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-contact">담당자(참가자 성명)</Label>
              <Input
                id="reg-contact"
                value={primaryContact}
                onChange={(e) => setPrimaryContact(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-phone">전화번호</Label>
              <Input
                id="reg-phone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-email">이메일</Label>
              <Input
                id="reg-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </div>
            {/* 담당자 계정 비밀번호 — 선택 입력이라 비워두면 계정은 생기되 로그인은 안 된다
                (명단 업로드에서 공통 비밀번호를 안 올린 것과 같은 상태). */}
            <ContactPasswordFields
              idPrefix="reg"
              password={password}
              confirm={passwordConfirm}
              onPasswordChange={setPassword}
              onConfirmChange={setPasswordConfirm}
              attempted={attempted}
              required={false}
              label="비밀번호(선택)"
              hint="비우면 이 담당자는 로그인할 수 없어요(나중에 '비밀번호 설정'으로 정할 수 있습니다). 입력하면 최소 8자, 영문과 숫자를 포함해야 합니다."
            />
            {attempted && passwordNeedsEmail && (
              <p role="alert" className="text-xs font-medium text-destructive">
                비밀번호를 설정하려면 담당자 이메일이 필요해요.
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                취소
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              등록
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 미신청 기업의 간이 대리작성 폼 — 운영자가 신청서를 대신 낸다. 저장하면 상태가 바뀐다(master 승인 /
// sub 승인 대기). 여기 없는 항목은 저장 직후 열리는 신청서 편집 패널에서 채운다.
//
// 값의 기준은 명단이 아니라 **서버의 현재 프로필**이다(lib/organizer/member-profile-patch 머리말):
// 열 때 서버에서 읽은 값이 그대로 초깃값이고(서버에 없는 칸은 빈 칸 — 명단 값으로 채우지 않는다), 저장할 때
// 그 서버 값을 함께 올려 "달라진 칸만"(= 운영자가 입력하거나 고친 칸만) 보내게 한다. 읽지 못하면 폼을
// 그리지 않고 저장을 막는다 — 서버 값을 모르는 채로 보내면 참가자가 써 둔 초안을 덮는다.
function ProxyMemberDialog({
  row,
  approveImmediately,
  loadServerValues,
  onOpenChange,
  onSubmit,
}: {
  row: MemberRow
  // master면 저장과 동시에 승인, sub면 승인 대기(버튼·안내 문구가 갈린다).
  approveImmediately: boolean
  // 서버의 현재 프로필을 폼 칸 값으로 읽는다. 마운트할 때의 함수를 붙잡아 한 번 부른다
  // (= 열 때 읽는다. 부모가 key로 행마다 다시 마운트한다).
  loadServerValues: () => Promise<OrganizerProxyValues>
  onOpenChange: (open: boolean) => void
  // (폼 값, 열 때 읽은 서버 값) → 서버가 저장을 확인하면 true. false면 다이얼로그와 입력을 유지한다.
  onSubmit: (form: OrganizerProxyValues, server: OrganizerProxyValues) => Promise<boolean>
}) {
  const tab = row.tab
  const isExhibitor = tab === "exhibitor"
  const [load] = useState(() => loadServerValues)
  const { state, retry } = useServerValue(load)
  const [values, setValues] = useState<OrganizerProxyValues | null>(null)
  // 읽어 온 서버 값으로 폼을 한 번 채운다(값이 도착하면 렌더 중에 state를 맞춘다).
  const [seeded, setSeeded] = useState<OrganizerProxyValues | null>(null)
  if (state.status === "ready" && seeded !== state.value) {
    setSeeded(state.value)
    setValues({ ...state.value })
  }
  // 서버 응답을 기다리는 동안 — 저장 버튼 재클릭(대리작성 두 번째 요청은 409다)과 닫기를 막는다.
  const [submitting, setSubmitting] = useState(false)
  // 저장 전 검사에 걸린 이유(있으면 보내지 않는다).
  const [problem, setProblem] = useState<string | null>(null)

  const set = (key: OrganizerProxyKey, value: string) => {
    setProblem(null)
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (submitting || state.status !== "ready" || !values) return
    // 대리작성은 저장과 함께 상태가 전이한다(master면 즉시 승인 → 매칭 대상). 서버에 기업명이 하나도 없고
    // 폼에도 입력이 없으면 이름 없는 기업이 승인되므로 보내지 않는다.
    if (!organizerProxyHasName(values, state.value)) {
      setProblem("기업명을 입력해 주세요 — 국문·영문 중 하나는 있어야 대리작성할 수 있습니다.")
      return
    }
    setProblem(null)
    setSubmitting(true)
    try {
      // 성공하면 부모가 이 다이얼로그를 내리고 신청서 편집 패널을 연다. 실패하면 그대로 남는다.
      await onSubmit(values, state.value)
    } finally {
      setSubmitting(false)
    }
  }

  const roleNoun = isExhibitor ? "참가사" : "바이어"
  const proxyOutcome = approveImmediately
    ? "저장하면 운영자 대리작성으로 처리되어 상태가 '승인됨'으로 바뀌고 매칭 대상에 포함됩니다."
    : "저장하면 운영자 대리작성으로 처리되어 상태가 '승인대기중'으로 바뀌고 슈퍼관리자 승인 대기열에 들어갑니다."
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // 저장 결과를 보기 전에 닫히면 입력이 사라진다 — 응답이 올 때까지 닫지 않는다.
        if (submitting) return
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`${roleNoun} 신청서 대리작성`}</DialogTitle>
          <DialogDescription>
            {`아직 비즈매칭 신청서를 내지 않은 기업입니다. ${proxyOutcome} 여기 없는 항목은 저장 직후 열리는 신청서 화면에서 이어서 채웁니다.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5">
            {state.status === "loading" && (
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="신청서를 불러오는 중">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            )}
            {state.status === "error" && (
              <Alert variant="destructive">
                <AlertTitle>신청서를 불러오지 못했어요</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3">
                  <span>
                    {describeOperatorLoadError(state.error)} 서버의 현재 값을 확인해야 대리작성할 수
                    있습니다.
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={retry}>
                    다시 불러오기
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {state.status === "ready" && values && (
              <>
                <p className="text-xs text-muted-foreground">
                  칸의 값은 서버에 저장된 신청서 값입니다(비어 있는 칸은 아직 값이 없는 칸입니다).
                  저장하면 입력하거나 고친 칸만 반영되고, 비운 칸은 건드리지 않습니다.
                </p>
                <div className="flex gap-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-name">기업명(국문)</Label>
                    <Input
                      id="reg-name"
                      value={values.name}
                      onChange={(e) => set("name", e.target.value)}
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-name-en">기업명(영문)</Label>
                    <Input
                      id="reg-name-en"
                      value={values.nameEn}
                      onChange={(e) => set("nameEn", e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-bizno">사업자등록번호</Label>
                    <Input
                      id="reg-bizno"
                      value={values.businessRegNo}
                      onChange={(e) => set("businessRegNo", e.target.value)}
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-website">웹사이트</Label>
                    <Input
                      id="reg-website"
                      value={values.website}
                      onChange={(e) => set("website", e.target.value)}
                    />
                  </div>
                </div>
                {/* 담당자 성명 — 바이어 신청자 성명. 참가사에는 없다: 참가사 담당자는 여러 명을 통째로
                    교체하는 목록이라 신청서 화면에서 다룬다. */}
                {!isExhibitor && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reg-contact">담당자(참가자 성명)</Label>
                    <Input
                      id="reg-contact"
                      value={values.primaryContact}
                      onChange={(e) => set("primaryContact", e.target.value)}
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-maintel">대표 전화번호</Label>
                  <Input
                    id="reg-maintel"
                    value={values.mainTel}
                    onChange={(e) => set("mainTel", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-email">{isExhibitor ? "회사 이메일" : "이메일"}</Label>
                  <Input
                    id="reg-email"
                    type="email"
                    value={values.contactEmail}
                    onChange={(e) => set("contactEmail", e.target.value)}
                  />
                </div>
                {isExhibitor && (
                  <Field>
                    <FieldLabel htmlFor="reg-content-category">카테고리</FieldLabel>
                    <Select
                      value={values.contentCategory || "unset"}
                      onValueChange={(v) => set("contentCategory", v === "unset" ? "" : v)}
                    >
                      <SelectTrigger id="reg-content-category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="unset">미입력</SelectItem>
                          {Object.entries(CONTENT_CATEGORY_LABELS).map(([code, label]) => (
                            <SelectItem key={code} value={code}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-address">주소</Label>
                  <Input
                    id="reg-address"
                    value={values.address}
                    onChange={(e) => set("address", e.target.value)}
                  />
                </div>
                {problem && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {problem}
                  </p>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                취소
              </Button>
            </DialogClose>
            <Button type="submit" disabled={state.status !== "ready" || !values || submitting}>
              {approveImmediately ? "대리작성 후 승인" : "대리작성 후 제출"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 신청서 조회 = 승인 심사 = 신청서 수정 모달(F-OP-002 D19). 본문은 관리자 콘솔(/admin/organizations)과
// 함께 쓰는 신청서 편집 패널이다 — 회사가 제출한 신청서의 모든 항목을 보여 주고, 승인된 건을 포함해
// 구획별로 고칠 수 있다(직접 수정은 신청 상태를 바꾸지 않는다). master는 승인대기중(submitted) 건을
// 여기서 승인/반려/수정요청한다 — canReview 정본 술어로 판정.
function ReviewModal({
  row,
  createTransport,
  canDecide,
  isMaster,
  onOpenChange,
  onDecide,
  onSaved,
}: {
  row: MemberRow
  // 이 기업의 신청서 전송을 만드는 함수(실 세션 = BFF, 목업 = 인메모리). 패널이 마운트될 때 한 번 부른다.
  createTransport: () => OperatorApplicationTransport
  canDecide: boolean
  // 부스·미팅 불가 시간은 master만 고친다(sub에게는 값만 보인다).
  isMaster: boolean
  onOpenChange: (open: boolean) => void
  onDecide: (status: ApplicationStatus, note?: string) => void
  onSaved: (application: OperatorApplication) => void
}) {
  // 심사 액션은 master(canDecide) + 승인대기중(canReview)에서만.
  const reviewable = canDecide && canReview(row.applicationStatus)
  const title = row.nameEn ? `${row.name} (${row.nameEn})` : row.name

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>신청서 조회 · 심사</DialogTitle>
          <DialogDescription>
            {title} · {MEMBER_TAB_LABELS[row.tab]} · 현재 상태:{" "}
            {ORGANIZER_STATUS_LABELS[row.applicationStatus]}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-1">
          {/* 이 콘솔에 보이는 행은 이미 관할 안이다(sub는 자기 바이어만 본다) — 수정 권한의 최종 판정은
              백엔드가 한다(관할 밖이면 403, 패널이 안내하고 입력을 유지한다). */}
          <OperatorApplicationPanel
            createClient={() =>
              createOperatorApplicationClient(row.tab, createTransport(), {
                canAssignBooth: isMaster,
              })
            }
            canEdit
            isMaster={isMaster}
            statusLabels={ORGANIZER_STATUS_LABELS}
            onSaved={onSaved}
          />
          {/* 결정 UI(사유 입력 + 승인/반려/수정요청)는 admin 콘솔(organizations-console)과 공유
              (components/review-decision-actions) — 같은 백엔드 엔드포인트를 향하는 같은 결정이다. */}
          {reviewable && <ReviewDecisionActions onDecide={onDecide} />}
        </div>
        {!reviewable && (
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">닫기</Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
