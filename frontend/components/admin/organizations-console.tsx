"use client"

import { useMemo, useState } from "react"
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
import { ADMIN_STATUS_LABELS, applyProfileEdit, applyProxyWrite } from "@/lib/admin/proxy-profile"
import { organizationsToCsv, organizationsToXls } from "@/lib/admin/export"
import {
  patchOrganizationRole,
  patchOrgProfile,
  postProxyProfile,
  reviewOrganization,
  setOrganizationContactPassword,
} from "@/lib/admin/admin-actions"
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
  formToDisplayProfile,
  ProfileEditor,
  ProfileSummary,
  toProfilePatch,
  type ProfileFormState,
} from "./profile-editor"
import type { AdminEvent, AdminEventSettings } from "@/lib/admin/types"
import { RosterUploadButton } from "@/components/roster/roster-upload"
import { ProxyWriteDialog } from "./proxy-write-dialog"
import type { BusinessFieldCode, ContentCategoryCode } from "@/lib/bm/types"

// 카테고리·사업분야 드롭다운 옵션 — FacetFilter는 코드 배열을 받는다(라벨은 BUSINESS_FIELD_LABELS/
// CONTENT_CATEGORY_LABELS가 단일 정본, lib/bm/fields.ts).
const BUSINESS_FIELD_CODES = Object.keys(BUSINESS_FIELD_LABELS) as BusinessFieldCode[]
const CONTENT_CATEGORY_CODES = Object.keys(CONTENT_CATEGORY_LABELS) as ContentCategoryCode[]

// 기업 관리 — 워드프레스식 "리스트 + 상세 편집". 행을 누르면 우측 시트가 열리고 신청서 전체를
// 인라인으로 고칠 수 있다. 미신청 기업은 대리작성하며 master면 즉시 승인, sub면 검토 대기다.
//
// 편집·대리작성은 낙관적 인메모리 반영 + seam 호출(admin-actions)이지만, **서버 응답을 기다린 뒤
// 확정한다**(fire-and-forget 아님) — 저장은 role별 enum·전체교체 필드가 얽힌 쓰기라 실패 시
// 화면과 서버가 어긋난 채로 방치하면 안 된다. 실패하면 rows·profileMap을 저장 직전 스냅샷으로
// 롤백하고 토스트로 알린다. 목업(NEXT_PUBLIC_AUTH_CLIENT !== "http") 단계에선 dispatch가 항상
// success:true라 롤백 경로를 타지 않는다.

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
  // 신청서 편집/대리작성 게이트. false면 상세는 조회 전용(ProfileSummary). sub도 관할 기업엔 false.
  readOnly: boolean
  // 거버넌스 게이트(master 전용) — 참가 역할 전환. sub는 신청서는 고쳐도 이건 못 한다. (명단 업로드는
  // readOnly만 따른다 — master·sub 공용, sub 관할은 백엔드 검사.)
  canManageRoles: boolean
  actorName: string
}) {
  const [rows, setRows] = useState<AdminOrganization[]>(organizations)
  const [profileMap, setProfileMap] = useState<Record<string, AdminOrgProfile>>(profiles)
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
  // 서버가 새 명단을 내려주면(명단 업로드 적용 후 router.refresh 등) 화면 state를 그 값으로 맞춘다 —
  // rows/profileMap은 낙관적 편집용 사본이라 초기값만 props에서 받는다(React "props 변경 시 state 조정").
  // 이게 없어서 업로드가 성공해도 새로고침 전까지 목록에 새 기업이 보이지 않았다.
  const [syncedOrganizations, setSyncedOrganizations] = useState(organizations)
  if (syncedOrganizations !== organizations) {
    setSyncedOrganizations(organizations)
    setRows(organizations)
    setProfileMap(profiles)
  }

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
  // 미신청(registered) 기업의 쓰기는 대리작성뿐이다 — 인라인 시트가 아니라 고객사 PPT 사양의
  // 4탭 다이얼로그(ProxyWriteDialog)로 연다. 정정·조회는 기존 시트를 그대로 쓴다.
  const detailIsProxy = !!detail && !readOnly && detail.application_status === "registered"
  const passwordTarget = passwordTargetId
    ? (rows.find((r) => r.id === passwordTargetId) ?? null)
    : null
  // 비밀번호 설정 가능 행: 쓰기 권한이 있어야 하고, master(canManageRoles)면 전부·sub면 바이어만.
  // 관할의 최종 권위는 백엔드(check_write_jurisdiction)지만, 눌러서 403만 보는 버튼은 감춘다.
  const canSetPassword = (org: AdminOrganization) =>
    !readOnly && (canManageRoles || org.role === "buyer")
  const activeFacets =
    roles.size + statuses.size + (proxyOnly ? 1 : 0) + categories.size + contentCategories.size

  // 신청서 저장 — 미신청이면 대리작성(master 즉시 승인/sub 검토 대기), 그 외는 정정.
  // role별 정확한 필드·유효 코드만 담은 patch(toProfilePatch)를 보내고, 실패하면 저장 직전
  // 스냅샷(prevRows/prevProfileMap)으로 되돌린다 — 낙관적 반영을 서버가 거부한 채 방치하지 않는다.
  async function saveProfile(org: AdminOrganization, form: ProfileFormState, mode: "edit" | "proxy") {
    const at = new Date().toISOString()
    const patch = toProfilePatch(form, org.role)
    const prevRows = rows
    const prevProfileMap = profileMap

    if (mode === "proxy") {
      const outcome = applyProxyWrite(org, actorName, at, canManageRoles)
      if (!outcome.ok) {
        toast.error("대리작성을 저장하지 못했어요", { description: outcome.message })
        return
      }
      setRows((prev) => prev.map((r) => (r.id === org.id ? outcome.organization : r)))
    } else {
      setRows((prev) => prev.map((r) => (r.id === org.id ? applyProfileEdit(r, at) : r)))
    }

    // 시트 안 내용도 최신으로 — 다시 열었을 때 방금 쓴 값이 보이게 한다(낙관적 표시모델).
    setProfileMap((prev) => ({ ...prev, [org.id]: formToDisplayProfile(form, org.id, at) }))
    setDetailId(null)

    const result =
      mode === "proxy"
        ? await postProxyProfile(eventId, org.id, org.role, patch)
        : await patchOrgProfile(eventId, org.id, org.role, patch)

    if (!result.success) {
      setRows(prevRows)
      setProfileMap(prevProfileMap)
      toast.error("서버 저장에 실패했어요", {
        description: result.error ? `오류: ${result.error} — 이전 내용으로 되돌렸어요` : "이전 내용으로 되돌렸어요",
      })
      return
    }

    if (mode === "proxy") {
      toast(`'${org.name_ko}' 신청서를 대리작성했어요`, {
        description: canManageRoles
          ? `상태가 '${ADMIN_STATUS_LABELS.approved}'으로 바뀌어 매칭 대상에 포함됩니다`
          : `상태가 '${ADMIN_STATUS_LABELS.submitted}'으로 바뀌어 승인 대기열에 포함됩니다`,
      })
    } else {
      toast(`'${org.name_ko}' 신청서를 수정했어요`)
    }
  }

  // 역할 전환(바이어 ↔ 참가사) — 슈퍼어드민 전용. 미팅이 잡힌 기업은 순수 규칙이 막는다
  // (기존 미팅의 양측 배치가 어긋나므로 — lib/admin/organizations.switchOrgRole).
  function changeRole(org: AdminOrganization, nextRole: AdminOrgRole) {
    const outcome = switchOrgRole(org, nextRole, new Date().toISOString())
    if (!outcome.ok) {
      toast.error("역할을 전환하지 못했어요", { description: outcome.message })
      return
    }
    setRows((prev) => prev.map((r) => (r.id === org.id ? outcome.organization : r)))
    toast(`'${org.name_ko}'의 역할을 ${ADMIN_ORG_ROLE_LABELS[nextRole]}(으)로 바꿨어요`, {
      description: "역할에 따라 신청서 항목과 매칭 대상이 달라집니다",
    })
    void patchOrganizationRole(eventId, org.id, nextRole).then((r) => {
      if (!r.success) toast.error("서버 저장에 실패했어요")
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
                  download(`nabi-${eventId}-기업.csv`, organizationsToCsv(sorted), "text/csv;charset=utf-8")
                }
              >
                CSV로 내보내기
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  download(
                    `nabi-${eventId}-기업.xls`,
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

      {/* 상세 — 신청서 전체 인라인 편집 */}
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
                      onClick={() =>
                        changeRole(detail, detail.role === "buyer" ? "exhibitor" : "buyer")
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
                {readOnly ? (
                  <ProfileSummary profile={profileMap[detail.id] ?? null} />
                ) : (
                  <ProfileEditor
                    key={detail.id}
                    org={detail}
                    profile={profileMap[detail.id] ?? null}
                    readOnly={readOnly}
                    approveImmediately={canManageRoles}
                    onSave={(form, mode) => saveProfile(detail, form, mode)}
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
          profile={profileMap[detail.id] ?? null}
          event={event}
          settings={settings}
          approveImmediately={canManageRoles}
          onSave={(form) => saveProfile(detail, form, "proxy")}
        />
      )}
    </div>
  )
}

// 백엔드 detail.code → 사람이 읽는 한 줄. 어드민 콘솔은 next-intl을 쓰지 않아(참가자 화면 전용)
// 한글 문구를 그대로 둔다. /organizer/members의 같은 기능과 문구를 맞춘다.
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
