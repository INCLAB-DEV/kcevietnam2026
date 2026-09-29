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
  patchMemberProfile,
  patchMemberStatus,
  setMemberPassword,
} from "@/lib/organizer/member-actions"
import {
  ContactPasswordDialog,
  ContactPasswordFields,
  checkPasswordPair,
} from "@/components/operator/contact-password"
import { hasOrganizerProfilePatch, toOrganizerProfilePatch } from "@/lib/organizer/member-profile-patch"
import {
  ArrowDownUp,
  ChevronDown,
  Download,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
  profiles?: Record<string, MemberProfile> // 제출 B층 신청서(BM-004/005) — 신청서 조회 모달이 id로 찾는다.
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

// N2: 명단 목록 API(GET .../organizations)는 businessRegNo/website/address를 안 내려준다(A층
// 등록정보 전부는 상세/신청서 조회에만 있음) — MemberRow에 그 필드가 애초에 안 채워진 채로 수정
// 다이얼로그를 열면(initial=row) 저장은 되는데(PATCH) 재진입 시 빈칸으로 보이는 원인이었다.
// 이미 명단 화면이 신청서 조회용으로 불러와 둔 profiles(getMemberProfiles)에서 같은 필드를 채워
// 넣는다 — 별도 API 왕복 없이 프리필만 보강한다.
function withProfileFallback(row: MemberRow, profile?: MemberProfile): MemberRow {
  if (!profile) return row
  return {
    ...row,
    businessRegNo: row.businessRegNo ?? profile.businessRegNo,
    website: row.website ?? profile.website,
    address: row.address ?? profile.address,
    mainTel: row.mainTel ?? profile.mainTel,
  }
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

// 단건등록·수정 폼 입력(F-OP-002 D18). A층 등록 정보(요구사항 ②④/별첨2). 탭별 전용 필드 포함.
type MemberFormInput = {
  name: string
  nameEn?: string
  businessRegNo?: string
  primaryContact?: string
  contactPhone?: string
  mainTel?: string
  contactEmail?: string
  website?: string
  productCategory?: string
  contentCategory?: string | null
  hsCode?: string
  kstAvailableTime?: string
  address?: string
  boothLabel?: string // 참가사
  buyerTypeLabel?: string // 바이어
  language?: string // 바이어
  stayInfo?: string // 바이어
  // 담당자 계정 비밀번호(단건 등록 전용, 선택). 비우면 계정은 생기되 로그인은 안 된다.
  // MemberRow에는 담지 않는다 — 화면 상태로 새어나가지 않게 등록 요청에만 실어 보낸다.
  password?: string
}

// 폼 입력 → MemberRow 필드 패치(생성·수정 공용). 빈 값은 비움(연락 필드는 null, 선택 필드는 undefined).
function inputToFields(
  input: MemberFormInput,
  tab: MemberTab
): Partial<MemberRow> {
  const common: Partial<MemberRow> = {
    name: input.name,
    nameEn: input.nameEn || undefined,
    businessRegNo: input.businessRegNo || undefined,
    primaryContact: input.primaryContact || null,
    contactPhone: input.contactPhone || null,
    mainTel: input.mainTel || undefined,
    contactEmail: input.contactEmail || null,
    website: input.website || undefined,
    productCategory: input.productCategory || null,
    hsCode: input.hsCode || undefined,
    kstAvailableTime: input.kstAvailableTime || undefined,
    address: input.address || undefined,
  }
  return tab === "exhibitor"
    ? { ...common, ...(input.contentCategory !== undefined ? { contentCategory: input.contentCategory || null } : {}), boothLabel: input.boothLabel || undefined }
    : {
        ...common,
        buyerTypeLabel: input.buyerTypeLabel || undefined,
        language: input.language || undefined,
        stayInfo: input.stayInfo || null,
      }
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

  // 빠른 정정 / 비활성화·삭제는 인메모리 상태로 즉시 반영(낙관적). TODO(#50/실연동): FastAPI 영속.
  const [edits, setEdits] = useState<Record<string, Partial<MemberRow>>>({})
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<MemberRow | null>(null)
  const [deleting, setDeleting] = useState<MemberRow | null>(null)
  // 승인 심사 — 신청서 조회 모달에서 승인/반려/수정요청(master). 결정은 인메모리 오버라이드(낙관적).
  const [reviewing, setReviewing] = useState<MemberRow | null>(null)
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

  // 정정·비활성화/삭제를 반영한 유효 행. 삭제·비활성화된 행은 목록(=배정 대상)에서 빠진다.
  const effective = useMemo(
    () =>
      (realSession ? initialMembers : members)
        .filter((m) => !removedIds.has(m.id))
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
    [members, initialMembers, removedIds, edits, statusOverrides, isMaster, tradeOffice, realSession]
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

  // 정보 수정: 프로필 PATCH 성공 후 표시값을 갱신한다. 카테고리는 정규 코드로 영속한다.
  //
  // ⚠ H1(2026-09-12): 예전엔 이 함수가 setEdits만 하고 네트워크 요청을 전혀 내지 않아 새로고침하면
  // 수정 내용이 통째로 사라졌다. 이 폼(MemberFormInput)은 자유 텍스트 입력이라 신청서 스키마의
  // enum(Literal) 필드에 그대로 실으면 422가 나므로, toOrganizerProfilePatch가 안전한 필드만 골라
  // PATCH .../profile(또는 대리작성이면 POST .../proxy-profile)로 보낸다 — 나머지(사업분야·부스 등)
  // 는 대응하는 신청서 필드가 없어 여전히 로컬 정정으로만 남는다(지어내지 않는다, 주석 참고).
  async function editMember(input: MemberFormInput) {
    if (!editing) return
    const id = editing.id
    const tab = editing.tab
    // 대리작성 여부 — admin ProfileEditor(profile-editor.tsx)와 동일 판정: 아직 신청서를 내지 않은
    // (registered) 기업의 저장은 대리작성이다. master면 승인, sub면 승인 대기로 전환된다.
    const mode = editing.applicationStatus === "registered" ? "proxy" : "edit"
    const patch = inputToFields(input, tab)

    const profilePatch = toOrganizerProfilePatch(
      {
        businessRegNo: input.businessRegNo,
        website: input.website,
        primaryContact: input.primaryContact,
        contactEmail: input.contactEmail,
        mainTel: input.mainTel,
        address: input.address,
        language: input.language,
        contentCategory: input.contentCategory,
      },
      tab,
    )
    if (hasOrganizerProfilePatch(profilePatch)) {
      const result = await patchMemberProfile(id, tab, mode, profilePatch)
      if (!result.success) {
        toast.error("정보 저장에 실패했어요. 다시 시도해 주세요.")
        return
      }
    }
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }))
    if (mode === "proxy") {
      setStatusOverrides((prev) => ({
        ...prev,
        [id]: isMaster ? "approved" : "submitted",
      }))
    }
    toast(`'${input.name}' 정보를 수정했어요`)
    setEditing(null)
    if (realSession) router.refresh()
  }

  // 비활성화: 목록에서 제외 + 실행취소 가능(토스트). 배정 대상에서도 빠진다.
  function deactivate(row: MemberRow) {
    setRemovedIds((prev) => new Set(prev).add(row.id))
    toast(`'${row.name}'을(를) 비활성화했어요`, {
      description: "목록과 배정 대상에서 제외됩니다",
      action: {
        label: "실행 취소",
        onClick: () =>
          setRemovedIds((prev) => {
            const next = new Set(prev)
            next.delete(row.id)
            return next
          }),
      },
    })
  }

  // 삭제: 확정 다이얼로그 후 **서버 성공을 확인한 뒤에만** 목록에서 제거한다(서버-authoritative).
  // 낙관적으로 먼저 지우면 409(미팅 있음) 등 실패 때 "삭제된 것처럼 보이는데 실제론 안 됨" 오해가
  // 생기므로(사용자 피드백 2026-09-09), 삭제는 승인(decide)과 달리 서버 확정 후 반영한다.
  function confirmDelete() {
    if (!deleting) return
    const row = deleting
    setDeleting(null)
    void deleteMember(row.id).then((result) => {
      if (result.success) {
        setRemovedIds((prev) => new Set(prev).add(row.id))
        toast(`'${row.name}'을(를) 삭제했어요`)
      } else {
        toast.error(`'${row.name}'을(를) 삭제하지 못했어요`, {
          description:
            result.error === "ORG_HAS_MEETINGS"
              ? "이 기업은 미팅이 있어 삭제할 수 없어요. 미팅을 먼저 정리해 주세요."
              : "삭제에 실패했어요. 잠시 후 다시 시도해 주세요.",
        })
      }
    })
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
  async function registerMember(input: MemberFormInput) {
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
        return
      }
      toast(`'${input.name}'을(를) 등록했어요`, {
        description: input.password
          ? "담당자 이메일·비밀번호로 바로 로그인할 수 있어요"
          : undefined,
      })
      setRegisterOpen(false)
      router.refresh()
      return
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
      ...inputToFields(input, tab),
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

  const xlsName = `nabi-${tab}-명단.xls`

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
                              {/* 정보 수정 — A층 등록정보 전체 편집(노출 버튼). 신청서 조회는 "비즈매칭 신청서" 컬럼으로 이동. */}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs"
                                onClick={() =>
                                  setEditing(withProfileFallback(row, profiles?.[row.id]))
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
                                  <DropdownMenuItem
                                    onSelect={() => deactivate(row)}
                                  >
                                    비활성화
                                  </DropdownMenuItem>
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

        {/* 승인 심사 모달 (신청서 조회 = 심사) */}
        {reviewing && (
          <ReviewModal
            key={reviewing.id}
            row={reviewing}
            profile={profiles?.[reviewing.id] ?? null}
            canDecide={isMaster}
            onOpenChange={(open) => !open && setReviewing(null)}
            onDecide={decide}
          />
        )}

        {/* 정보 수정 다이얼로그 (A층 등록정보 전체 — 단건등록과 같은 폼, 편집 모드) */}
        {editing && (
          <MemberFormDialog
            key={editing.id}
            tab={editing.tab}
            mode="edit"
            initial={editing}
            open
            onOpenChange={(open) => !open && setEditing(null)}
            onSubmit={editMember}
          />
        )}

        {/* 삭제 확인 다이얼로그 */}
        <Dialog
          open={!!deleting}
          onOpenChange={(open) => !open && setDeleting(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>참가자 삭제</DialogTitle>
              <DialogDescription>
                {deleting
                  ? `'${deleting.name}'을(를) 명단에서 삭제합니다. `
                  : ""}
                목록과 배정 대상에서 제외되며 되돌릴 수 없습니다.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">취소</Button>
              </DialogClose>
              <Button variant="destructive" onClick={confirmDelete}>
                삭제
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Tabs>

      {/* 단건 등록 다이얼로그 (현재 탭 기준 — 참가사/바이어) */}
      <MemberFormDialog
        tab={tab}
        mode="create"
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

// 단건등록·수정 공용 폼(F-OP-002 D18). A층 등록정보(요구사항 ②④/별첨2)를 받는다 — B층 신청서 선언
// (연매출·관심분야·회사소개·예산·도입시기)은 회사가 직접 작성하므로 여기서 받지 않는다.
// mode="edit"면 initial로 프리필(행마다 key 리마운트해 초기값을 props로 직접 채운다).
function MemberFormDialog({
  tab,
  mode,
  initial,
  open,
  onOpenChange,
  onSubmit,
}: {
  tab: MemberTab
  mode: "create" | "edit"
  initial?: MemberRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: MemberFormInput) => void
}) {
  const isExhibitor = tab === "exhibitor"
  const [name, setName] = useState(initial?.name ?? "")
  const [nameEn, setNameEn] = useState(initial?.nameEn ?? "")
  const [businessRegNo, setBusinessRegNo] = useState(
    initial?.businessRegNo ?? ""
  )
  const [website, setWebsite] = useState(initial?.website ?? "")
  const [primaryContact, setPrimaryContact] = useState(
    initial?.primaryContact ?? ""
  )
  const [contactPhone, setContactPhone] = useState(initial?.contactPhone ?? "")
  const [mainTel, setMainTel] = useState(initial?.mainTel ?? "")
  const [contactEmail, setContactEmail] = useState(initial?.contactEmail ?? "")
  const [contentCategory, setContentCategory] = useState(initial?.contentCategory ?? "")
  const [productCategory, setProductCategory] = useState(
    initial?.productCategory ?? ""
  )
  const [hsCode, setHsCode] = useState(initial?.hsCode ?? "")
  const [kstAvailableTime, setKstAvailableTime] = useState(
    initial?.kstAvailableTime ?? ""
  )
  const [address, setAddress] = useState(initial?.address ?? "")
  const [boothLabel, setBoothLabel] = useState(initial?.boothLabel ?? "")
  const [buyerTypeLabel, setBuyerTypeLabel] = useState(
    initial?.buyerTypeLabel ?? ""
  )
  const [language, setLanguage] = useState(initial?.language ?? "")
  const [stayInfo, setStayInfo] = useState(initial?.stayInfo ?? "")
  // 담당자 계정 비밀번호 — 단건 등록에서만 받는다(등록 이후 변경은 행 작업 메뉴의 "비밀번호 설정").
  // 선택 입력: 비우면 계정은 생기되 로그인은 안 된다(백엔드 password_hash NULL).
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [attempted, setAttempted] = useState(false)
  const wantsPassword = password.length > 0 || passwordConfirm.length > 0
  const passwordState = checkPasswordPair(password, passwordConfirm, { required: false })
  // 비밀번호만 넣고 이메일을 비우면 걸 계정이 없어 백엔드가 422로 되돌린다
  // (PASSWORD_WITHOUT_CONTACT_EMAIL) — 왕복하기 전에 여기서 막고 이유를 보여준다.
  const passwordNeedsEmail = wantsPassword && contactEmail.trim().length === 0

  function reset() {
    setName("")
    setNameEn("")
    setBusinessRegNo("")
    setWebsite("")
    setPrimaryContact("")
    setContactPhone("")
    setMainTel("")
    setContactEmail("")
    setProductCategory("")
    setHsCode("")
    setKstAvailableTime("")
    setAddress("")
    setBoothLabel("")
    setBuyerTypeLabel("")
    setLanguage("")
    setStayInfo("")
    setPassword("")
    setPasswordConfirm("")
    setAttempted(false)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setAttempted(true)
    // 비밀번호 입력이 온전하지 않으면 제출하지 않는다 — 오타 하나로 로그인 불가 계정이 생기는 걸 막는다.
    if (mode === "create" && (!passwordState.ready || passwordNeedsEmail)) return
    onSubmit({
      name: name.trim(),
      nameEn: nameEn.trim(),
      businessRegNo: businessRegNo.trim(),
      website: website.trim(),
      primaryContact: primaryContact.trim(),
      contactPhone: contactPhone.trim(),
      mainTel: mainTel.trim(),
      contactEmail: contactEmail.trim(),
      productCategory: productCategory.trim(),
      ...(mode === "edit" && isExhibitor && contentCategory !== (initial?.contentCategory ?? "")
        ? { contentCategory: contentCategory || null } : {}),
      hsCode: hsCode.trim(),
      kstAvailableTime: kstAvailableTime.trim(),
      address: address.trim(),
      ...(isExhibitor
        ? { boothLabel: boothLabel.trim() }
        : {
            buyerTypeLabel: buyerTypeLabel.trim(),
            language: language.trim(),
            stayInfo: stayInfo.trim(),
          }),
      ...(mode === "create" && password ? { password } : {}),
    })
    if (mode === "create") reset()
  }

  const roleNoun = isExhibitor ? "참가사" : "바이어"
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && mode === "create") reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "edit"
              ? `${roleNoun} 정보 수정`
              : `${roleNoun} 단건 등록`}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "주관사가 준 등록정보(A층)를 정정합니다. 비즈매칭 신청서(연매출·관심분야·소개 등)는 회사가 직접 작성합니다."
              : "한 건씩 직접 등록합니다(A층 등록정보). 등록 직후 비즈매칭 신청 전까지 미신청 상태입니다."}
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
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-bizno">사업자등록번호</Label>
                <Input
                  id="reg-bizno"
                  value={businessRegNo}
                  onChange={(e) => setBusinessRegNo(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-website">웹사이트</Label>
                <Input
                  id="reg-website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-contact">담당자(참가자 성명)</Label>
              <Input
                id="reg-contact"
                value={primaryContact}
                onChange={(e) => setPrimaryContact(e.target.value)}
              />
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-phone">전화번호</Label>
                <Input
                  id="reg-phone"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-maintel">대표 전화번호</Label>
                <Input
                  id="reg-maintel"
                  value={mainTel}
                  onChange={(e) => setMainTel(e.target.value)}
                />
              </div>
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
            {/* 담당자 계정 비밀번호 — 단건 등록에서만. 선택 입력이라 비워두면 계정은 생기되
                로그인은 안 된다(명단 업로드에서 공통 비밀번호를 안 올린 것과 같은 상태). */}
            {mode === "create" && (
              <>
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
              </>
            )}
            {isExhibitor && mode === "edit" && (
              <Field>
                <FieldLabel htmlFor="reg-content-category">카테고리</FieldLabel>
                <Select value={contentCategory || "unset"} onValueChange={(v) => setContentCategory(v === "unset" ? "" : v)}>
                  <SelectTrigger id="reg-content-category"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="unset">미입력</SelectItem>
                    {Object.entries(CONTENT_CATEGORY_LABELS).map(([code, label]) => <SelectItem key={code} value={code}>{label}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
              </Field>
            )}
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-category">
                  {isExhibitor ? "사업분야" : "관심분야"}
                </Label>
                <Input
                  id="reg-category"
                  value={productCategory}
                  onChange={(e) => setProductCategory(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="reg-hscode">HS코드/품목설명</Label>
                <Input
                  id="reg-hscode"
                  value={hsCode}
                  onChange={(e) => setHsCode(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-kst">KST 상담 가능 시간</Label>
              <Input
                id="reg-kst"
                value={kstAvailableTime}
                onChange={(e) => setKstAvailableTime(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reg-address">주소</Label>
              <Input
                id="reg-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>

            {isExhibitor ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-booth">부스(홀·관·부스번호)</Label>
                  <Input
                    id="reg-booth"
                    value={boothLabel}
                    onChange={(e) => setBoothLabel(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex gap-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-type">바이어유형</Label>
                    <Input
                      id="reg-type"
                      placeholder="초청 / 사전등록 / 현장"
                      value={buyerTypeLabel}
                      onChange={(e) => setBuyerTypeLabel(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="reg-language">언어(통역)</Label>
                    <Input
                      id="reg-language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-stay">체류정보(항공·숙박·통역)</Label>
                  <Input
                    id="reg-stay"
                    placeholder="예: 항공 KE081 9/8 · 롯데호텔 9/8~9/12 · 통역 영어"
                    value={stayInfo}
                    onChange={(e) => setStayInfo(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!name.trim()}>
              {mode === "edit" ? "저장" : "등록"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 신청서 조회 내부 표시 헬퍼 — 라벨/값 한 줄.
function ProfileField({
  label,
  value,
}: {
  label: string
  value?: string | null
}) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">
        {value || "-"}
      </span>
    </div>
  )
}

function ProfileSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      <div className="flex flex-col gap-1.5 text-sm">{children}</div>
    </div>
  )
}

// 제출 B층 신청서(BM-004 바이어 / BM-005 참가사)를 섹션별로 그대로 표시한다.
function boolLabel(
  v: boolean | undefined,
  t: string,
  f: string
): string | undefined {
  return v == null ? undefined : v ? t : f
}

function ProfileView({
  tab,
  profile,
}: {
  tab: MemberTab
  profile: MemberProfile
}) {
  const isExhibitor = tab === "exhibitor"
  const slash = (a?: string, b?: string) =>
    [a, b].filter(Boolean).join(" / ") || undefined
  const hasStayOrAttendees =
    (profile.attendees?.length ?? 0) > 0 || !!profile.stayInfo

  return (
    <div className="flex flex-col gap-4">
      {isExhibitor ? (
        <>
          <ProfileSection title="기본정보">
            <ProfileField
              label="사업자등록번호"
              value={profile.businessRegNo}
            />
            <ProfileField
              label="대표자"
              value={slash(
                profile.representativeNameKo,
                profile.representativeNameEn
              )}
            />
            <ProfileField label="회사 이메일" value={profile.companyEmail} />
            <ProfileField label="대표 번호" value={profile.mainTel} />
            <ProfileField label="팩스" value={profile.fax} />
            <ProfileField label="주소" value={profile.address} />
            <ProfileField
              label="업태 / 종목"
              value={slash(profile.businessType, profile.businessItem)}
            />
            <ProfileField
              label="부스"
              value={
                [
                  profile.booth,
                  profile.boothType,
                  profile.boothCount ? `${profile.boothCount}개` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            />
          </ProfileSection>

          <ProfileSection title="회사소개·규모">
            <ProfileField label="웹사이트" value={profile.website} />
            <ProfileField
              label="참가자 구분"
              value={profile.orgTypes?.join(", ")}
            />
            <ProfileField label="연매출" value={profile.annualSales} />
            <ProfileField label="직원수" value={profile.employeeRange} />
            <ProfileField
              label="상담 가능 언어"
              value={profile.availableLanguages}
            />
            <ProfileField
              label="회사소개(국문)"
              value={profile.companyIntroKo}
            />
            <ProfileField
              label="회사소개(영문)"
              value={profile.companyIntroEn}
            />
          </ProfileSection>

          <ProfileSection title="사업분야">
            <ProfileField label="카테고리" value={labelFor(CONTENT_CATEGORY_LABELS, profile.contentCategory) || "미입력"} />
            <ProfileField label="사업분야" value={profile.categories.join(", ")} />
            {profile.products?.map((p, i) => (
              <div key={i} className="rounded-md border px-3 py-2">
                <div className="font-medium text-foreground">
                  {p.nameKo}
                  {p.nameEn ? ` (${p.nameEn})` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {[
                    p.category,
                    p.hsCode && `HS ${p.hsCode}`,
                    p.hsDescription,
                    p.priceRange,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "-"}
                </div>
              </div>
            ))}
          </ProfileSection>

          {(profile.preferredBuyerCountries ||
            profile.preferredBuyerTypes ||
            profile.unavailableSlots) && (
            <ProfileSection title="타겟·운영">
              <ProfileField
                label="선호 바이어 국가"
                value={profile.preferredBuyerCountries}
              />
              <ProfileField
                label="선호 바이어 구분"
                value={profile.preferredBuyerTypes}
              />
              <ProfileField
                label="미팅 불가 시간"
                value={profile.unavailableSlots}
              />
            </ProfileSection>
          )}
        </>
      ) : (
        <>
          <ProfileSection title="신청자(담당자)">
            <ProfileField
              label="성명"
              value={slash(profile.contactNameKo, profile.contactNameEn)}
            />
            <ProfileField
              label="직위"
              value={slash(profile.contactTitleKo, profile.contactTitleEn)}
            />
            <ProfileField label="이메일" value={profile.contactEmail} />
            <ProfileField label="전화" value={profile.contactPhone} />
            <ProfileField label="상담 언어" value={profile.contactLanguage} />
            <ProfileField
              label="통역 필요"
              value={boolLabel(profile.interpreterNeed, "필요", "불필요")}
            />
          </ProfileSection>

          <ProfileSection title="기관 정보">
            <ProfileField label="국가" value={profile.country} />
            <ProfileField
              label="참가자 구분"
              value={profile.orgTypes?.join(", ")}
            />
            <ProfileField label="연매출" value={profile.annualSales} />
            <ProfileField label="직원수" value={profile.employeeRange} />
            <ProfileField
              label="사업자등록번호"
              value={profile.businessRegNo}
            />
            <ProfileField label="웹사이트" value={profile.website} />
          </ProfileSection>

          <ProfileSection title="관심분야·소개">
            <ProfileField
              label="관심 분야"
              value={profile.categories.join(", ")}
            />
            <ProfileField
              label="회사소개(국문)"
              value={profile.companyIntroKo}
            />
            <ProfileField
              label="회사소개(영문)"
              value={profile.companyIntroEn}
            />
          </ProfileSection>

          <ProfileSection title="구매·참가">
            <ProfileField label="지출 예산" value={profile.budgetRange} />
            <ProfileField label="도입 시기" value={profile.adoptionTimeline} />
            <ProfileField
              label="참가 경로"
              value={profile.participationRoute}
            />
            <ProfileField
              label="KST 상담시간"
              value={profile.kstAvailableTime}
            />
          </ProfileSection>
        </>
      )}

      {hasStayOrAttendees && (
        <ProfileSection title={isExhibitor ? "담당자" : "참석자·체류"}>
          {!isExhibitor && (
            <ProfileField label="체류정보" value={profile.stayInfo} />
          )}
          {profile.attendees?.map((a, i) => (
            <div key={i} className="rounded-md border px-3 py-2 text-xs">
              <span className="font-medium text-foreground">{a.name}</span>{" "}
              <span className="text-muted-foreground">
                {[
                  a.division,
                  a.title,
                  a.email,
                  a.tel || a.mobile,
                  a.languages,
                  a.interpreterNeed ? "통역필요" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          ))}
        </ProfileSection>
      )}
    </div>
  )
}

// 신청서 조회 = 승인 심사 모달(F-OP-002 D19). 회사가 제출한 B층 신청서(BM-004/005)를 그대로 보여주고
// master가 승인/반려/수정요청한다. 심사 액션은 submitted(승인대기중)에서만 — canReview 정본 술어로 판정.
function ReviewModal({
  row,
  profile,
  canDecide,
  onOpenChange,
  onDecide,
}: {
  row: MemberRow
  profile?: MemberProfile | null
  canDecide: boolean
  onOpenChange: (open: boolean) => void
  onDecide: (status: ApplicationStatus, note?: string) => void
}) {
  // 심사 액션은 master(canDecide) + 승인대기중(canReview)에서만. sub는 읽기전용(닫기만).
  const reviewable = canDecide && canReview(row.applicationStatus)
  const title = row.nameEn ? `${row.name} (${row.nameEn})` : row.name

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>신청서 조회 · 심사</DialogTitle>
          <DialogDescription>
            {title} · {MEMBER_TAB_LABELS[row.tab]} · 현재 상태:{" "}
            {ORGANIZER_STATUS_LABELS[row.applicationStatus]}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5">
          {profile ? (
            <>
              <p className="text-xs text-muted-foreground">
                회사가 제출한 비즈매칭 신청서(
                {row.tab === "exhibitor" ? "BM-005" : "BM-004"}) 내용입니다.
              </p>
              <ProfileView tab={row.tab} profile={profile} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              제출된 신청서가 없습니다(명단만 등록된 상태).
            </p>
          )}
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
