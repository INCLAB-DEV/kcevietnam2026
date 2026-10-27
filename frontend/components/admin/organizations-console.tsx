"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowDownUp, Download, Repeat, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { pageCount, pageItems, paginate } from "@/lib/organizer/members"
import {
  ADMIN_ORG_ROLE_LABELS,
  ADMIN_ORG_ROLES,
  type AdminOrganization,
  type AdminOrgProfile,
  type AdminOrgRole,
} from "@/lib/admin/types"
import { APPLICATION_STATUSES, canReview, type ApplicationStatus } from "@/lib/application-status"
import { ReviewDecisionActions, type ReviewDecision } from "@/components/review-decision-actions"
import { BUSINESS_FIELD_LABELS, CONTENT_CATEGORY_LABELS } from "@/lib/bm/fields"
import {
  ADMIN_ORG_SORT_LABELS,
  ADMIN_ORG_SORTS,
  EMPTY_ORG_FILTERS,
  filterOrganizations,
  sortOrganizations,
  switchOrgRole,
  type AdminOrgSort,
} from "@/lib/admin/organizations"
import { ADMIN_STATUS_LABELS, applyProxyWrite } from "@/lib/admin/proxy-profile"
import { organizationsToCsv, organizationsToXls } from "@/lib/admin/export"
import {
  isAdminHttpMode,
  patchOrganizationRole,
  postProxyProfile,
  reviewOrganization,
  setOrganizationContactPassword,
} from "@/lib/admin/admin-actions"
import {
  createAdminApplicationTransport,
  createAdminMockApplicationTransport,
} from "@/lib/admin/application-transport"
import {
  createOperatorApplicationClient,
  type OperatorApplication,
  type OperatorApplicationTransport,
} from "@/lib/operator/application-client"
import { buildUnavailableSlotGrid } from "@/lib/operator/slot-grid"
import { OperatorApplicationPanel } from "@/components/operator/application-panel"
import {
  OPERATOR_CONFLICT_TITLE,
  OPERATOR_PROXY_CONFLICT_HINT,
  describeOperatorLoadError,
} from "@/components/operator/application-operator-sections"
import { ContactPasswordDialog } from "@/components/operator/contact-password"
import {
  EmptyResult,
  FacetFilter,
  SearchField,
  StatusBadge,
  download,
  toggleSet,
} from "./shared"
import {
  proxyPatchConflicts,
  toFormState,
  toProxyProfilePatch,
  type ProfileFormState,
} from "./proxy-profile-form"
import type { AdminEvent, AdminEventSettings } from "@/lib/admin/types"
import { RosterUploadButton } from "@/components/roster/roster-upload"
import { ProxyWriteDialog } from "./proxy-write-dialog"
import type { BusinessFieldCode, ContentCategoryCode } from "@/lib/bm/types"

// 카테고리·사업분야 드롭다운 옵션 — FacetFilter는 코드 배열을 받는다(라벨은 BUSINESS_FIELD_LABELS/
// CONTENT_CATEGORY_LABELS가 단일 정본, lib/bm/fields.ts).
const BUSINESS_FIELD_CODES = Object.keys(BUSINESS_FIELD_LABELS) as BusinessFieldCode[]
const CONTENT_CATEGORY_CODES = Object.keys(CONTENT_CATEGORY_LABELS) as ContentCategoryCode[]

// 기업 관리 — 워드프레스식 "리스트 + 상세 편집". 행을 누르면 우측 시트가 열리고 신청서의 **모든 항목**을
// 구획별로 고칠 수 있다. 미신청 기업은 대리작성하며 master면 즉시 승인, sub면 검토 대기다.
//
// 시트의 본문은 행사 운영 콘솔(/organizer/members)과 함께 쓰는 패널(components/operator/application-panel)
// 이다 — 참가자 화면의 "전체 보기 + 구획별 수정"을 운영자 대상 기업에 대해 재조립한 것이라, 참가자
// 신청서에 있는 항목이 여기서 빠질 수 없다. 패널은 **열 때마다 서버에서 새로 읽고**(이 화면의 목록과
// 함께 실려 온 profiles를 편집 초깃값으로 쓰지 않는다), 저장은 서버 응답으로만 화면을 바꾼다.
// profiles는 미신청 기업의 대리작성 다이얼로그 프리필과 목업 모드의 시드로만 쓴다.
//
// 대리작성·심사·역할 전환도 **서버 응답을 기다린 뒤 확정한다**(낙관적 반영 없음) — 실패하면 화면을
// 건드리지 않고 토스트로 알린다. 목업(NEXT_PUBLIC_AUTH_CLIENT !== "http") 단계에선 dispatch가 항상
// success:true다.

export function OrganizationsConsole({
  organizations,
  profiles,
  eventId,
  event,
  settings,
  readOnly,
  canManageRoles,
  actorName,
}: {
  organizations: AdminOrganization[]
  profiles: Record<string, AdminOrgProfile>
  eventId: string
  // 대리작성 다이얼로그의 비즈니스 미팅 탭(슬롯 격자)이 쓴다. 없으면 탭이 접힌다.
  event: AdminEvent | null
  settings: AdminEventSettings | null
  // 신청서 편집/대리작성 게이트. true면 상세는 조회 전용이다(신청서 편집 패널을 canEdit=false로 그린다 —
  // 구획 '수정' 버튼이 없다). sub도 관할 기업엔 false.
  readOnly: boolean
  // 거버넌스 게이트(master 전용) — 참가 역할 전환. sub는 신청서는 고쳐도 이건 못 한다. (명단 업로드는
  // readOnly만 따른다 — master·sub 공용, sub 관할은 백엔드 검사.)
  canManageRoles: boolean
  actorName: string
}) {
  const router = useRouter()
  const [rows, setRows] = useState<AdminOrganization[]>(organizations)
  const [query, setQuery] = useState("")
  const [roles, setRoles] = useState<Set<AdminOrgRole>>(new Set())
  const [statuses, setStatuses] = useState<Set<ApplicationStatus>>(new Set())
  const [proxyOnly, setProxyOnly] = useState(false)
  const [categories, setCategories] = useState<Set<BusinessFieldCode>>(new Set())
  const [contentCategories, setContentCategories] = useState<Set<ContentCategoryCode>>(new Set())
  const [sortBy, setSortBy] = useState<AdminOrgSort>("status")
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<string | null>(null)
  // 비밀번호 설정 대상 기업 — 열려 있는 동안에만 값이 있다(평문은 다이얼로그 안에서만 산다).
  const [passwordTargetId, setPasswordTargetId] = useState<string | null>(null)
  // 승인 심사 처리 중인 기업 id — 서버 응답을 기다리는 동안 결정 버튼을 잠근다(organizer 콘솔의
  // decide()와 달리 낙관적으로 먼저 바꾸지 않는다, 아래 decideReview 주석 참고).
  const [reviewPendingId, setReviewPendingId] = useState<string | null>(null)
  // 대리작성 저장 진행 중인 기업 — 서버 응답을 기다리는 동안 다이얼로그가 열려 있으므로(낙관 반영을
  // 안 쓴다) 저장 버튼 재클릭이 요청을 두 번 내지 못하게 막는다(대리작성은 두 번째가 409가 된다).
  const [profileSavingId, setProfileSavingId] = useState<string | null>(null)
  // 역할 전환 처리 중인 기업 id — 서버가 확정할 때까지 전환 버튼을 잠근다.
  const [rolePendingId, setRolePendingId] = useState<string | null>(null)
  // 서버가 새 명단을 내려주면(저장·명단 업로드 뒤 router.refresh 등) 화면 state를 그 값으로 맞춘다 —
  // rows는 서버가 확정한 변경을 곧바로 얹는 사본이라 초기값만 props에서 받는다(React "props 변경 시
  // state 조정"). 이게 없어서 업로드가 성공해도 새로고침 전까지 목록에 새 기업이 보이지 않았다.
  const [syncedOrganizations, setSyncedOrganizations] = useState(organizations)
  if (syncedOrganizations !== organizations) {
    setSyncedOrganizations(organizations)
    setRows(organizations)
  }
  // 목업 모드의 신청서 저장소(기업별 인메모리 전송). 실연동에서는 쓰지 않는다 — 패널이 서버에서 읽는다.
  const [mockTransports] = useState(() => new Map<string, OperatorApplicationTransport>())

  const sorted = useMemo(() => {
    const filtered = filterOrganizations(rows, {
      ...EMPTY_ORG_FILTERS,
      query,
      roles: [...roles],
      statuses: [...statuses],
      proxyOnly,
      categories: [...categories],
      contentCategories: [...contentCategories],
    })
    return sortOrganizations(filtered, sortBy)
  }, [rows, query, roles, statuses, proxyOnly, categories, contentCategories, sortBy])

  const totalPages = pageCount(sorted.length)
  const safePage = Math.min(page, totalPages)
  const pageRows = paginate(sorted, safePage)
  const detail = detailId ? (rows.find((r) => r.id === detailId) ?? null) : null
  // 미신청(registered) 기업의 쓰기는 대리작성뿐이다 — 시트가 아니라 고객사 PPT 사양의
  // 4탭 다이얼로그(ProxyWriteDialog)로 연다. 그 밖의 상태는 시트(신청서 편집 패널)를 쓴다.
  const detailIsProxy = !!detail && !readOnly && detail.application_status === "registered"
  // 미팅 불가 시간 격자의 축 — 행사·설정을 못 읽었으면 null(패널이 "만들 수 없다"고 안내한다).
  const slotGrid = useMemo(() => buildUnavailableSlotGrid(event, settings), [event, settings])

  // 기업 하나의 신청서 전송. 실연동이면 같은 출처 BFF(→ FastAPI), 목업이면 목록 픽스처를 심은 인메모리.
  function transportFor(org: AdminOrganization): OperatorApplicationTransport {
    if (isAdminHttpMode()) return createAdminApplicationTransport(eventId, org.id, slotGrid)
    const key = `${org.id}:${org.role}`
    let transport = mockTransports.get(key)
    if (!transport) {
      transport = createAdminMockApplicationTransport(org, profiles[org.id] ?? null, slotGrid)
      mockTransports.set(key, transport)
    }
    return transport
  }

  // 패널의 key — 기업·역할이 바뀌면 패널이 다시 마운트돼 새 클라이언트로 서버에서 새로 읽는다.
  const detailKey = detail && !detailIsProxy ? `${detail.id}:${detail.role}` : null

  // 패널 저장이 서버에서 확정된 뒤 — 응답에 실린 기업명·상태·불가 시간을 행에 얹고(서버 값이다, 낙관
  // 반영이 아니다) 목록 전체를 서버에서 다시 읽는다. 목업에는 다시 읽을 서버가 없어 행만 고친다.
  function applySavedApplication(org: AdminOrganization, application: OperatorApplication) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== org.id) return r
        const names =
          application.role === "exhibitor"
            ? {
                ko: application.profile.organizationNameKo,
                en: application.profile.organizationNameEn,
              }
            : { ko: application.draft.organizationNameKo, en: application.draft.organizationNameEn }
        return {
          ...r,
          name_ko: names.ko || names.en || r.name_ko,
          name_en: names.en || null,
          application_status: application.status,
          unavailable_slots:
            application.role === "exhibitor"
              ? (application.profile.unavailableMeetingSlots ?? [])
              : r.unavailable_slots,
        }
      }),
    )
    if (isAdminHttpMode()) router.refresh()
  }
  const passwordTarget = passwordTargetId
    ? (rows.find((r) => r.id === passwordTargetId) ?? null)
    : null
  // 비밀번호 설정 가능 행: 쓰기 권한이 있어야 하고, master(canManageRoles)면 전부·sub면 바이어만.
  // 관할의 최종 권위는 백엔드(check_write_jurisdiction)지만, 눌러서 403만 보는 버튼은 감춘다.
  const canSetPassword = (org: AdminOrganization) =>
    !readOnly && (canManageRoles || org.role === "buyer")
  const activeFacets =
    roles.size + statuses.size + (proxyOnly ? 1 : 0) + categories.size + contentCategories.size

  // 대리작성 저장 — 미신청 기업의 신청서를 대신 제출한다(master 즉시 승인/sub 검토 대기).
  // 다이얼로그가 실제로 보여 주는 칸 중 **운영자가 바꾼 칸만** 담은 patch(toProxyProfilePatch)를 보낸다 —
  // initial은 다이얼로그를 열 때 **서버에서 읽은** 폼 상태다(손대지 않은 칸은 보내지 않는다).
  //
  // 보내기 직전에 서버를 한 번 더 읽는다: 운영자가 바꾼 칸이 다이얼로그를 연 뒤 서버에서도 달라졌으면
  // (참가자가 그 사이 초안을 고쳤다) 보내지 않고 충돌로 알린다 — 운영자의 값은 옛 서버 값을 보고 정한
  // 것이다. 다시 읽지 못하면 모르는 채로 보내지 않는다. (클라이언트 쪽 검사다 — 재조회와 POST 사이의
  // 수정까지 막지는 못한다. lib/operator/application-client "동시 수정 검사" 참고.)
  //
  // ⚠ 낙관적 반영을 쓰지 않는다(2026-09-28): 서버 200을 받은 뒤에만 행을 갱신한다. 실패하면 화면을
  // 아예 건드리지 않았으므로 되돌릴 것도 없고, 다이얼로그가 열린 채 입력이 그대로 남아 그 자리에서
  // 다시 저장할 수 있다(결과를 boolean으로 돌려준다 — 다이얼로그가 닫을지 말지를 이 값으로 정한다).
  // "저장한 척 보이고 DB는 안 바뀐" 은폐가 이 레포의 알려진 사고 패턴이다(write 계통 버그).
  //
  // 성공하면 시트를 닫지 않는다: 행 상태가 미신청에서 벗어나므로 같은 기업의 신청서 편집 패널이 곧바로
  // 열리고(서버에서 새로 읽는다), 대리작성 다이얼로그에 없는 항목을 이어서 채울 수 있다.
  async function saveProxy(
    org: AdminOrganization,
    form: ProfileFormState,
    initial: ProfileFormState,
  ): Promise<boolean> {
    if (profileSavingId !== null) return false
    const at = new Date().toISOString()
    const patch = toProxyProfilePatch(form, org.role, initial)

    // 대리작성 가능 여부는 순수 규칙(applyProxyWrite)이 먼저 판정한다 — 막히면 요청조차 보내지 않고,
    // 통과하면 그 결과 행을 들고 있다가 서버 성공 후에 적용한다.
    const outcome = applyProxyWrite(org, actorName, at, canManageRoles)
    if (!outcome.ok) {
      toast.error("대리작성을 저장하지 못했어요", { description: outcome.message })
      return false
    }

    // fetch는 네트워크 단절에서 throw한다 — finally로 풀지 않으면 저장 버튼이 영구히 잠긴다.
    setProfileSavingId(org.id)
    let result: Awaited<ReturnType<typeof postProxyProfile>>
    try {
      let latest: ProfileFormState
      try {
        latest = toFormState((await transportFor(org).getDetail()).detail, org.role)
      } catch (error) {
        toast.error("대리작성을 저장하지 못했어요", {
          description: `서버의 현재 값을 확인하지 못해 보내지 않았습니다. ${describeOperatorLoadError(error)} 입력은 그대로 남아 있습니다.`,
        })
        return false
      }
      if (proxyPatchConflicts(form, org.role, initial, latest).length > 0) {
        toast.error(OPERATOR_CONFLICT_TITLE, { description: OPERATOR_PROXY_CONFLICT_HINT })
        return false
      }
      result = await postProxyProfile(eventId, org.id, org.role, patch)
      // 목업에는 저장할 서버가 없다 — 이어서 열리는 패널이 방금 쓴 값을 보이도록 인메모리 전송에 싣는다.
      if (result.success && !isAdminHttpMode()) {
        await transportFor(org).patchProfile(org.role, patch as Record<string, unknown>)
      }
    } catch {
      result = { success: false, error: "network_error" }
    } finally {
      setProfileSavingId(null)
    }

    if (!result.success) {
      toast.error("서버 저장에 실패했어요", {
        description:
          result.error === "network_error"
            ? "네트워크 연결을 확인하고 다시 시도해 주세요(입력은 그대로 남아 있습니다)."
            : result.error
              ? `오류: ${result.error} — 저장되지 않았어요(입력은 그대로 남아 있습니다)`
              : "저장되지 않았어요(입력은 그대로 남아 있습니다)",
      })
      return false
    }

    setRows((prev) => prev.map((r) => (r.id === org.id ? outcome.organization : r)))
    if (isAdminHttpMode()) router.refresh()
    toast(`'${org.name_ko}' 신청서를 대리작성했어요`, {
      description: canManageRoles
        ? `상태가 '${ADMIN_STATUS_LABELS.approved}'으로 바뀌어 매칭 대상에 포함됩니다. 이어서 나머지 항목을 채울 수 있어요.`
        : `상태가 '${ADMIN_STATUS_LABELS.submitted}'으로 바뀌어 승인 대기열에 포함됩니다. 이어서 나머지 항목을 채울 수 있어요.`,
    })
    return true
  }

  // 역할 전환(바이어 ↔ 참가사) — 슈퍼어드민 전용. 미팅이 잡힌 기업은 순수 규칙이 막는다
  // (기존 미팅의 양측 배치가 어긋나므로 — lib/admin/organizations.switchOrgRole).
  //
  // **서버가 확정한 뒤에만** 행의 역할을 바꾼다. 시트의 패널은 행의 역할로 신청서를 읽는데, 화면을
  // 먼저 바꾸면 서버가 아직 옛 역할인 채로 새 역할의 신청서를 읽으러 가 어긋난다(예전엔 먼저 바꾸고
  // 실패해도 되돌리지 않았다 — 화면만 바뀌고 서버는 그대로인 상태가 남았다).
  async function changeRole(org: AdminOrganization, nextRole: AdminOrgRole) {
    if (rolePendingId !== null) return
    const outcome = switchOrgRole(org, nextRole, new Date().toISOString())
    if (!outcome.ok) {
      toast.error("역할을 전환하지 못했어요", { description: outcome.message })
      return
    }
    setRolePendingId(org.id)
    let result: Awaited<ReturnType<typeof patchOrganizationRole>>
    try {
      result = await patchOrganizationRole(eventId, org.id, nextRole)
    } catch {
      result = { success: false, error: "network_error" }
    } finally {
      setRolePendingId(null)
    }
    if (!result.success) {
      toast.error("역할을 전환하지 못했어요", {
        description:
          result.error === "network_error"
            ? "네트워크 연결을 확인하고 다시 시도해 주세요."
            : (result.error ?? "잠시 후 다시 시도해 주세요."),
      })
      return
    }
    setRows((prev) => prev.map((r) => (r.id === org.id ? outcome.organization : r)))
    if (isAdminHttpMode()) router.refresh()
    toast(`'${org.name_ko}'의 역할을 ${ADMIN_ORG_ROLE_LABELS[nextRole]}(으)로 바꿨어요`, {
      description: "역할에 따라 신청서 항목과 매칭 대상이 달라집니다",
    })
  }

  // 담당자 계정 비밀번호 설정/재설정 — 백엔드가 관할·운영자계정 보호를 판정하고, 여기선 결과만
  // 알린다. 실패하면 다이얼로그를 열어둔 채 사유를 띄운다(성공한 척 닫지 않는다).
  async function submitPassword(org: AdminOrganization, password: string): Promise<boolean> {
    const result = await setOrganizationContactPassword(eventId, org.id, password)
    if (!result.success) {
      toast.error(`'${org.name_ko}' 비밀번호 설정에 실패했어요`, {
        description: contactPasswordErrorHint(result.error),
      })
      return false
    }
    toast(`'${org.name_ko}' 담당자 비밀번호를 설정했어요`, {
      description: org.contact_email
        ? `${org.contact_email} 계정으로 바로 로그인할 수 있어요`
        : "새 비밀번호로 바로 로그인할 수 있어요",
    })
    return true
  }

  // 승인 심사 결정 — master 전용, submitted 행만(canReview). /organizer/members의 decide()와 달리
  // **서버 확정 후에만** 행 상태를 바꾼다(낙관적 아님) — 여러 행사를 오가는 슈퍼어드민 콘솔이라
  // 409(다른 운영자가 먼저 처리함)·403 같은 실패를 화면에 먼저 반영했다가 되돌리기보다, 확정된
  // 값만 보여주는 편이 상태 불일치 위험이 적다(발주자 요구사항).
  async function decideReview(org: AdminOrganization, status: ReviewDecision, note?: string) {
    setReviewPendingId(org.id)
    // fetch는 네트워크 단절에서 throw한다 — finally로 pending을 풀지 않으면 버튼이 영구히 잠긴다.
    let result: Awaited<ReturnType<typeof reviewOrganization>>
    try {
      result = await reviewOrganization(eventId, org.id, status, note)
    } catch {
      result = { success: false, error: "network_error" }
    } finally {
      setReviewPendingId(null)
    }
    if (!result.success) {
      toast.error(`'${org.name_ko}' 심사 처리에 실패했어요`, {
        description:
          result.error === "network_error"
            ? "네트워크 연결을 확인하고 다시 시도해 주세요."
            : (result.error ?? "잠시 후 다시 시도해 주세요."),
      })
      return
    }
    setRows((prev) =>
      prev.map((r) => (r.id === org.id ? { ...r, application_status: status } : r))
    )
    const verb =
      status === "approved" ? "승인" : status === "rejected" ? "반려" : "수정요청"
    toast(`'${org.name_ko}' 신청서를 ${verb}했어요`, { description: note })
    setDetailId(null)
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* 데이터 입출력 — 현재 필터 결과 기준으로 내보낸다. */}
      {!readOnly && (
        <div className="flex flex-wrap justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download data-icon="inline-start" />
                엑셀 내보내기
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  download(`sales-ai-${eventId}-기업.csv`, organizationsToCsv(sorted), "text/csv;charset=utf-8")
                }
              >
                CSV로 내보내기
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  download(
                    `sales-ai-${eventId}-기업.xls`,
                    organizationsToXls(sorted),
                    "application/vnd.ms-excel",
                  )
                }
              >
                Excel로 내보내기
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* 명단 업로드 — /organizer/members와 같은 버튼·다이얼로그·API(components/roster). 이 행사의
              운영자(master·sub)가 쓰고, sub는 자기 바이어만 반영된다(백엔드 관할 검사 — 발주자 지시 2026-09-16). */}
          <RosterUploadButton eventId={eventId} />
        </div>
      )}

      <SearchField placeholder="기업명(국/영)·담당자·이메일로 검색" onChange={(v) => { setQuery(v); setPage(1) }} />

      <div className="flex flex-wrap items-center gap-2">
        <FacetFilter
          label="구분"
          options={ADMIN_ORG_ROLES}
          labels={ADMIN_ORG_ROLE_LABELS}
          selected={roles}
          onToggle={(v) => { setRoles((p) => toggleSet(p, v)); setPage(1) }}
        />
        <FacetFilter
          label="신청 상태"
          options={APPLICATION_STATUSES}
          labels={ADMIN_STATUS_LABELS}
          selected={statuses}
          onToggle={(v) => { setStatuses((p) => toggleSet(p, v)); setPage(1) }}
        />
        <Button
          type="button"
          size="sm"
          variant={proxyOnly ? "default" : "outline"}
          aria-pressed={proxyOnly}
          onClick={() => { setProxyOnly((v) => !v); setPage(1) }}
        >
          대리작성만
        </Button>
        {/* 카테고리·사업분야 — /organizer/members와 같은 필터 축(코드셋·판정 모두 공유,
            lib/category-filter.matchesAnySelected). 카테고리는 참가사 전용 필드라 데이터가 있는
            기업만 실제로 걸리지만, 드롭다운 자체는 구분 필터와 무관하게 항상 노출한다. */}
        <FacetFilter
          label="카테고리"
          options={CONTENT_CATEGORY_CODES}
          labels={CONTENT_CATEGORY_LABELS}
          selected={contentCategories}
          onToggle={(v) => { setContentCategories((p) => toggleSet(p, v)); setPage(1) }}
        />
        <FacetFilter
          label="사업분야"
          options={BUSINESS_FIELD_CODES}
          labels={BUSINESS_FIELD_LABELS}
          selected={categories}
          onToggle={(v) => { setCategories((p) => toggleSet(p, v)); setPage(1) }}
        />
        {activeFacets > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              setRoles(new Set())
              setStatuses(new Set())
              setProxyOnly(false)
              setCategories(new Set())
              setContentCategories(new Set())
              setPage(1)
            }}
          >
            초기화
          </Button>
        )}

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <ArrowDownUp data-icon="inline-start" />
                {ADMIN_ORG_SORT_LABELS[sortBy]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sortBy}
                onValueChange={(v) => { setSortBy(v as AdminOrgSort); setPage(1) }}
              >
                {ADMIN_ORG_SORTS.map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {ADMIN_ORG_SORT_LABELS[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyResult
          title="검색 결과가 없습니다"
          description="다른 검색어나 필터를 시도해보세요."
        />
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            {sorted.length}개 기업
            {totalPages > 1 && ` · ${safePage}/${totalPages} 페이지`}
          </span>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow className="bg-muted/40 text-muted-foreground hover:bg-muted/40 [&>th]:h-12 [&>th]:px-4">
                  <TableHead>기업명</TableHead>
                  <TableHead>구분</TableHead>
                  <TableHead>국가</TableHead>
                  <TableHead>담당자</TableHead>
                  <TableHead>이메일</TableHead>
                  <TableHead>카테고리</TableHead>
                  <TableHead>사업분야/관심분야</TableHead>
                  <TableHead className="text-right">미팅</TableHead>
                  <TableHead>신청 상태</TableHead>
                  <TableHead className="w-24" aria-label="작업" />
                </TableRow>
              </TableHeader>
              <TableBody className="[&>tr>td]:px-4 [&>tr>td]:py-3">
                {pageRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={`cursor-pointer ${row.application_status === "rejected" ? "opacity-60" : ""}`}
                    onClick={() => setDetailId(row.id)}
                  >
                    <TableCell>
                      <span className="font-medium text-foreground">{row.name_ko}</span>
                      {row.name_en && (
                        <span className="block text-xs text-muted-foreground">{row.name_en}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Badge variant="outline">{ADMIN_ORG_ROLE_LABELS[row.role]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.country ?? "-"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.contact_name ?? "-"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.contact_email ?? "-"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.content_category ? CONTENT_CATEGORY_LABELS[row.content_category as ContentCategoryCode] ?? row.content_category : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.category ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.meeting_count}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.application_status} proxyWritten={row.proxy_written} />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => setDetailId(row.id)}
                        >
                          {readOnly
                            ? "신청서 보기"
                            : row.application_status === "registered"
                              ? "대리작성"
                              : "신청서 편집"}
                        </Button>
                        {/* 비밀번호 설정 — 행에 두는 이유: 미신청(registered) 기업은 상세 시트가
                            아니라 대리작성 다이얼로그가 열려서, 시트 안에만 두면 정작 갓 등록한
                            기업의 비밀번호를 못 건다. master는 모든 행, sub는 자기 관할 바이어만
                            (sub 목록엔 참가사도 섞여 오므로 역할로 한 번 더 거른다). */}
                        {canSetPassword(row) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            onClick={() => setPasswordTargetId(row.id)}
                          >
                            비밀번호
                          </Button>
                        )}
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
                    className={safePage === 1 ? "pointer-events-none opacity-50" : undefined}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)) }}
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
                        onClick={(e) => { e.preventDefault(); setPage(item) }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    text="다음"
                    href="#"
                    aria-disabled={safePage === totalPages}
                    className={safePage === totalPages ? "pointer-events-none opacity-50" : undefined}
                    onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(totalPages, p + 1)) }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}

      {/* 상세 — 신청서 전체 보기 + 구획별 수정(행사 운영 콘솔과 같은 패널) */}
      <Sheet open={!!detail && !detailIsProxy} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle className="flex flex-wrap items-center gap-2">
                  {detail.name_ko}
                  <StatusBadge
                    status={detail.application_status}
                    proxyWritten={detail.proxy_written}
                  />
                </SheetTitle>
                <SheetDescription>
                  {ADMIN_ORG_ROLE_LABELS[detail.role]}
                  {detail.name_en ? ` · ${detail.name_en}` : ""}
                  {detail.registered_by ? ` · 등록주체 ${detail.registered_by}` : ""}
                  {detail.proxy_written_by
                    ? ` · 대리작성 ${detail.proxy_written_by}`
                    : ""}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 px-4 pb-4">
                {/* 역할 전환 — 슈퍼어드민(master)만. 신청서 편집과 성격이 달라(참가 자격 자체를
                    바꾼다) sub에겐 열지 않는다. 신청서 편집(readOnly)과 별개 게이트(canManageRoles). */}
                {canManageRoles && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Repeat className="size-3.5" />
                      참가 역할
                    </span>
                    <Badge variant="outline">{ADMIN_ORG_ROLE_LABELS[detail.role]}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto text-xs"
                      disabled={rolePendingId === detail.id}
                      onClick={() =>
                        void changeRole(detail, detail.role === "buyer" ? "exhibitor" : "buyer")
                      }
                    >
                      {ADMIN_ORG_ROLE_LABELS[detail.role === "buyer" ? "exhibitor" : "buyer"]}로 전환
                    </Button>
                  </div>
                )}
                {/* 승인 심사 — master + 검토 대기(submitted) 행만. 결정 UI는 organizer 콘솔
                    (참가기업 관리 › 신청서 조회 모달)과 공유(components/review-decision-actions) —
                    둘 다 PATCH .../review로 같은 결정을 보낸다. sub는 canManageRoles가 false라
                    애초에 렌더되지 않는다(읽기 전용 유지). */}
                {canManageRoles && canReview(detail.application_status) && (
                  <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
                    <span className="text-xs text-muted-foreground">승인 심사</span>
                    <ReviewDecisionActions
                      noteId={`review-note-${detail.id}`}
                      pending={reviewPendingId === detail.id}
                      onDecide={(status, note) => void decideReview(detail, status, note)}
                    />
                  </div>
                )}
                {/* 신청서 — 열 때마다 서버에서 새로 읽는다(key = 기업·역할). 조회 전용 권한이면 같은 패널이
                    읽기 전용으로 그려진다. 부스·미팅 불가 시간은 master(canManageRoles)만 고친다. */}
                {detailKey && (
                  <OperatorApplicationPanel
                    key={detailKey}
                    // 부스는 master만 쓸 수 있다: sub의 본문에는 부스 키가 들어가지 않는다(canAssignBooth).
                    createClient={() =>
                      createOperatorApplicationClient(detail.role, transportFor(detail), {
                        canAssignBooth: canManageRoles,
                      })
                    }
                    canEdit={!readOnly}
                    isMaster={canManageRoles}
                    statusLabels={ADMIN_STATUS_LABELS}
                    onSaved={(application) => applySavedApplication(detail, application)}
                  />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* 비밀번호 설정 — 대상이 있을 때만 마운트해(key=기업 id) 입력이 기업 사이에 남지 않게 한다. */}
      {passwordTarget && (
        <ContactPasswordDialog
          key={passwordTarget.id}
          open
          onOpenChange={(open) => !open && setPasswordTargetId(null)}
          orgName={passwordTarget.name_ko}
          contactEmail={passwordTarget.contact_email}
          onSubmit={(password) => submitPassword(passwordTarget, password)}
        />
      )}

      {/* 대리작성 — 고객사 PPT 슬라이드 6·7·8 사양의 4탭 다이얼로그. key로 기업별 폼 초기화. */}
      {detail && detailIsProxy && (
        <ProxyWriteDialog
          key={detail.id}
          open
          onOpenChange={(open) => !open && setDetailId(null)}
          org={detail}
          createTransport={() => transportFor(detail)}
          event={event}
          settings={settings}
          approveImmediately={canManageRoles}
          canEditSlots={canManageRoles}
          onSave={(form, initial) => saveProxy(detail, form, initial)}
        />
      )}
    </div>
  )
}

// 백엔드 detail.code → 사람이 읽는 한 줄. 어드민 콘솔의 본문 문구는 카탈로그(messages)가 아니라
// 한국어 하드코딩이다(콘솔은 한국어 전용) — 그래서 여기도 한글 문구를 그대로 둔다. 콘솔이 next-intl을
// 아예 안 쓰는 건 아니다: 명단 업로드 버튼·도움말·다이얼로그 닫기 라벨 같은 공용 조각은 카탈로그를 쓰고,
// 레이아웃의 ko 고정 provider(components/operator/console-intl-provider)가 그것들을 한국어로 묶는다.
// /organizer/members의 같은 기능과 문구를 맞춘다.
function contactPasswordErrorHint(code?: string): string {
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

// 대리작성 대상(미신청) 안내 배지 — 헤더 액션 영역에서 쓴다.
export function UnsubmittedHint({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <UserPlus className="size-3.5" />
      대리작성 대상 {count}개사
    </span>
  )
}
