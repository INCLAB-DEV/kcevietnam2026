"use client"

// 신청서 대리작성 다이얼로그 — 고객사 PPT(260904 PSA 시스템 수정 요청) 슬라이드 6·7·8 사양.
//
// 슬라이드에 캡처된 기존 폼 레이아웃(4탭: 회사소개·전시품목·관심 바이어·비즈니스 미팅)을 그대로
// 따르되, 빨간 표시+파란 피드백 박스로 접수된 세 건만 반영한다:
//   · 슬라이드6 '상담 가능 언어' → 영어·베트남 2종만(나머지 삭제)
//   · 슬라이드6 'KOTRA 회원 여부' → 삭제
//   · 슬라이드7 '전시품목 분야' → 방산 13종 대신 [사업분야] 8종
// 관심 바이어 탭(슬라이드8)은 피드백이 없어 구조만 유지한다. 칩 라벨은 슬라이드 스크린샷의 구
// 방산 어휘가 아니라 현재 K-콘텐츠 분류 라벨을 쓴다(2026-09-10 리브랜드 유지, 발주자 확인).
//
// 이 다이얼로그는 **대리작성(미신청 기업) 전용**이다. 이미 신청서가 있는 기업은 두 콘솔이 함께 쓰는
// 신청서 편집 패널(components/operator/application-panel — 참가자 신청서의 모든 항목)이 맡고, 대리작성이
// 성공하면 콘솔이 곧바로 그 패널을 열어 여기 없는 항목(사업자등록번호·담당자·부스 등)을 채우게 한다.
// 슬라이드에 없는 회사소개(국문)는 기능 보존을 위해 영문 위에 둔다.
//
// 저장은 서버 확인까지 기다린다(onSave가 Promise<boolean>): 실패하면 다이얼로그를 닫지 않고 입력을
// 그대로 둔다 — 예전엔 결과와 무관하게 즉시 닫혀, 실패 토스트가 "입력은 그대로 남아 있습니다"라고
// 말하는 동안 입력이 사라졌다. 미팅 불가 시간은 칸을 누르면 바로 저장하는데(전용 엔드포인트), 실패하면
// 방금 누른 칸을 되돌린다.
//
// 초깃값은 **열 때마다 서버에서 새로 읽는다**(폼 값·미팅 불가 시간 모두). 목록 화면에 실려 온 값을 쓰면
// 그 뒤 참가자가 써 둔 초안이 보이지 않고, 그 옛 값을 기준으로 저장하게 된다. 읽지 못하면 폼을 비워 둔 채
// 저장을 막고 다시 불러오게 한다 — 서버 값을 모르는 채로 보내지 않는다.
//
// 상태 초기화는 부모가 key={org.id}로 강제한다(다이얼로그가 열릴 기업마다 폼이 새로 시작돼야 한다).

import { useMemo, useRef, useState } from "react"
import { Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ChipMultiSelect } from "@/components/form/field-controls"
import { describeOperatorLoadError } from "@/components/operator/application-operator-sections"
import { UnavailableSlotGrid } from "@/components/operator/unavailable-slot-grid"
import { useServerValue } from "@/components/operator/use-server-value"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { ADMIN_STATUS_LABELS } from "@/lib/admin/proxy-profile"
import {
  ADMIN_ORG_ROLE_LABELS,
  type AdminEvent,
  type AdminEventSettings,
  type AdminExhibitorProductPatch,
  type AdminOrganization,
} from "@/lib/admin/types"
import {
  ANNUAL_SALES_SELLER_OPTIONS,
  BUYER_COUNTRY_OPTIONS,
  BUYER_COUNTRY_OPTIONS_EN,
  EMPLOYEE_RANGE_OPTIONS,
  businessFieldOptionsFor,
  orgTypeOptionsFor,
} from "@/lib/bm/fields"
import {
  isOperatorConflict,
  saveUnavailableSlotsChecked,
  type OperatorApplicationTransport,
} from "@/lib/operator/application-client"
import { buildUnavailableSlotGrid, toggleUnavailableSlot } from "@/lib/operator/slot-grid"
import { cn } from "@/lib/utils"
import {
  ANNUAL_SALES_BUYER_OPTIONS,
  EMPTY_PROFILE_FORM,
  ProductDialog,
  SelectField,
  toFormState,
  type ProfileFormState,
} from "./proxy-profile-form"
import { Field, TextField } from "./shared"

const EMPTY_PRODUCT: AdminExhibitorProductPatch = {
  name_ko: "",
  name_en: "",
  business_field: null,
  hs_code: "",
  price_range: null,
  spec: "",
}

// 슬라이드6 피드백 — 상담 가능 언어는 영어·베트남어 2종만 남긴다("영어, 베트남 제외 삭제").
const PROXY_LANGUAGE_OPTIONS = [
  { code: "en", label: "영어" },
  { code: "vi", label: "베트남어" },
] as const

// 국가 칩 검색(한글·영문) — ko/en 옵션 배열은 code 순서가 같다고 보장되지 않으므로 code로 묶는다.
const COUNTRY_EN_LABEL = new Map(BUYER_COUNTRY_OPTIONS_EN.map((o) => [o.code, o.label]))

// 다이얼로그를 열 때 서버에서 읽은 값 — 폼의 초깃값과 미팅 불가 시간.
interface ProxyServerSnapshot {
  form: ProfileFormState
  slots: string[]
}

export function ProxyWriteDialog({
  open,
  onOpenChange,
  org,
  createTransport,
  event,
  settings,
  approveImmediately,
  canEditSlots,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: AdminOrganization
  // 이 기업의 신청서 전송을 만드는 함수(실연동 = BFF, 목업 = 인메모리). **마운트당 한 번만** 부른다 —
  // 다이얼로그가 열릴 때 이 전송으로 서버의 현재 프로필을 읽고, 미팅 불가 시간도 이 전송으로 저장한다.
  createTransport: () => OperatorApplicationTransport
  // 행사·설정이 없으면(조회 실패) 비즈니스 미팅 탭을 접는다 — 나머지는 그대로 동작해야 한다.
  event: AdminEvent | null
  settings: AdminEventSettings | null
  // master면 저장과 동시에 승인, sub면 승인 대기(proxy-profile.ts 규칙) — 버튼 문구만 갈린다.
  approveImmediately: boolean
  // 미팅 불가 시간은 master 전용 쓰기다(백엔드 require_event_master — sub는 403). false면 격자를 읽기
  // 전용으로 그린다 — 신청서 편집 패널의 editable={canEdit && isMaster}와 같은 기준. 호출부가 넘긴다.
  canEditSlots: boolean
  // 폼 상태를 그대로 올린다 — 패치 조립(toProxyProfilePatch)과 서버 호출은 콘솔이 단일 소유한다.
  // initial은 이 다이얼로그를 **열었을 때**의 폼 상태다: 콘솔이 "운영자가 바꾼 칸만" 보내려면 운영자가
  // 실제로 본 초깃값과 비교해야 한다(그 뒤 목록이 새로고침돼 profile prop이 바뀌어도 기준은 그대로다).
  // 서버가 저장을 확인하면 true. false면(실패) 이 다이얼로그는 열린 채 입력을 유지한다.
  onSave: (form: ProfileFormState, initial: ProfileFormState) => Promise<boolean>
}) {
  const isExhibitor = org.role === "exhibitor"
  const [transport] = useState(createTransport)
  const [load] = useState(() => async (): Promise<ProxyServerSnapshot> => {
    const { detail } = await transport.getDetail()
    return {
      form: toFormState(detail, org.role),
      slots: [...(detail.exhibitor_profile?.unavailable_meeting_slots ?? [])].sort(),
    }
  })
  const { state, retry } = useServerValue(load)
  const ready = state.status === "ready"
  // initial = 열 때 서버에서 읽은 폼 값(운영자가 본 초깃값). 읽기 전에는 빈 폼이고 저장할 수 없다.
  const [initial, setInitial] = useState<ProfileFormState>(EMPTY_PROFILE_FORM)
  const [form, setForm] = useState<ProfileFormState>(EMPTY_PROFILE_FORM)
  const [editingProduct, setEditingProduct] = useState<{
    index: number | null
    product: AdminExhibitorProductPatch | null
  } | null>(null)
  // ProductDialog는 자체 DialogTrigger가 없어(이 버튼으로 연다) 닫힐 때 포커스를 여기로 명시
  // 복원한다(ProductDialog의 onCloseAutoFocus/returnFocusRef).
  const addProductButtonRef = useRef<HTMLButtonElement>(null)
  const [countryQuery, setCountryQuery] = useState("")
  const [unavailable, setUnavailable] = useState<string[]>([])
  // 읽어 온 값으로 폼을 한 번 채운다(값이 도착하면 렌더 중에 state를 맞춘다 — effect로 한 박자 늦추지 않는다).
  const [seeded, setSeeded] = useState<ProxyServerSnapshot | null>(null)
  if (state.status === "ready" && seeded !== state.value) {
    setSeeded(state.value)
    setInitial(state.value.form)
    setForm(state.value.form)
    setUnavailable(state.value.slots)
  }
  // 서버 응답을 기다리는 동안 — 저장 버튼 재클릭·닫기를 막고(대리작성 두 번째 요청은 409다), 불가 시간
  // 격자는 잠가 요청이 겹치지 않게 한다.
  const [saving, setSaving] = useState(false)
  const [slotSaving, setSlotSaving] = useState(false)

  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const toggleIn = (key: "categories" | "available_languages" | "preferred_buyer_countries" | "preferred_buyer_types", code: string) =>
    setForm((prev) => {
      const current = prev[key] as string[]
      return {
        ...prev,
        [key]: current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
      }
    })

  const businessFieldOptions = useMemo(() => businessFieldOptionsFor("ko"), [])
  const orgTypeOptions = useMemo(() => orgTypeOptionsFor("ko"), [])
  const countryOptions = useMemo(() => {
    const q = countryQuery.trim().toLowerCase()
    if (!q) return BUYER_COUNTRY_OPTIONS
    return BUYER_COUNTRY_OPTIONS.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (COUNTRY_EN_LABEL.get(o.code) ?? "").toLowerCase().includes(q),
    )
  }, [countryQuery])

  const slotGrid = useMemo(() => buildUnavailableSlotGrid(event, settings), [event, settings])

  async function toggleSlot(id: string) {
    if (!ready || slotSaving || !canEditSlots) return
    const shown = unavailable
    const next = toggleUnavailableSlot(shown, id)
    // 먼저 화면에 반영하되, 서버가 거절하면 되돌린다 — 반영된 척 남으면 운영자는 저장된 줄 안다.
    setUnavailable(next)
    setSlotSaving(true)
    try {
      // 불가 슬롯은 프로필 패치가 아니라 운영자 전용 엔드포인트로 나간다(전체 치환). 보내기 직전에 서버의
      // 지금 목록을 다시 읽어, 화면이 보여 주던 목록과 다르면 보내지 않는다 — 다른 곳에서 지정한 칸이 지워진다.
      setUnavailable(await saveUnavailableSlotsChecked(transport, next, shown))
    } catch (error) {
      if (isOperatorConflict(error)) {
        setUnavailable(error.latest as string[])
        toast.error("다른 곳에서 미팅 불가 시간이 먼저 바뀌었어요", {
          description:
            "최신 내용을 불러왔습니다. 방금 누른 칸은 저장하지 않았으니 확인하고 다시 눌러 주세요.",
        })
      } else {
        setUnavailable(shown)
        toast.error("미팅 불가 시간 저장에 실패했어요", {
          description: "방금 누른 칸은 되돌렸습니다. 잠시 후 다시 시도해 주세요.",
        })
      }
    } finally {
      setSlotSaving(false)
    }
  }

  async function submit() {
    if (saving || !ready) return
    setSaving(true)
    try {
      // 성공하면 콘솔이 이 다이얼로그를 내리고 신청서 편집 패널을 연다 — 여기서 닫지 않는다.
      // 실패하면(false) 아무것도 하지 않는다: 다이얼로그와 입력이 그대로 남아 다시 저장할 수 있다.
      await onSave(form, initial)
    } finally {
      setSaving(false)
    }
  }

  function saveProduct(product: AdminExhibitorProductPatch) {
    setForm((prev) => {
      const products = [...prev.products]
      if (editingProduct?.index === null) products.push(product)
      else if (editingProduct?.index !== undefined && editingProduct.index >= 0)
        products[editingProduct.index] = product
      return { ...prev, products }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 저장 결과를 보기 전에 닫히면 입력이 사라진다 — 응답이 올 때까지 닫지 않는다.
        if (saving) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>신청서 대리작성</DialogTitle>
          <DialogDescription>
            {org.name_ko} · {ADMIN_ORG_ROLE_LABELS[org.role]} · 현재 상태:{" "}
            {ADMIN_STATUS_LABELS[org.application_status]}
          </DialogDescription>
        </DialogHeader>

        {/* 서버에서 읽는 동안·읽지 못했을 때 — 폼을 그리지 않는다(빈 폼이 "값이 없다"로 읽히면 안 된다). */}
        {state.status === "loading" && (
          <div className="flex flex-col gap-3 px-5" aria-busy="true" aria-label="신청서를 불러오는 중">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
        {state.status === "error" && (
          <div className="px-5">
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
          </div>
        )}

        {/* 헤더·푸터는 dialog.tsx 기본 px-5를 쓰는데 탭 영역만 여백이 없어 화면 끝에 붙어
            보였다(고객 피드백) — 헤더·푸터와 맞춰 좌우 여백을 준다. */}
        {ready && (
          <Tabs defaultValue="intro" className="gap-4 px-5">
            <TabsList className="flex-wrap">
              <TabsTrigger value="intro">회사소개</TabsTrigger>
              <TabsTrigger value="products">{isExhibitor ? "사업분야" : "관심 품목"}</TabsTrigger>
              {isExhibitor && <TabsTrigger value="target">관심 바이어</TabsTrigger>}
              {isExhibitor && <TabsTrigger value="meeting">비즈니스 미팅</TabsTrigger>}
            </TabsList>

            {/* ── 슬라이드6: 회사소개 ─────────────────────────────────────────── */}
            <TabsContent value="intro" className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                바이어가 미팅 전에 읽는 첫 인상입니다. 핵심 역량과 차별점을 간결하게 써주세요.
              </p>
              <Field id="pw-intro-ko" label="회사소개(국문)">
                <Textarea
                  id="pw-intro-ko"
                  rows={3}
                  value={form.company_intro_ko}
                  onChange={(e) => set("company_intro_ko", e.target.value)}
                />
              </Field>
              <Field
                id="pw-intro-en"
                label="기업소개(영문)"
                hint="해외 바이어가 읽는 소개입니다. 경쟁사 대비 강점을 적으면 귀사를 찾는 바이어가 매칭됩니다."
              >
                <Textarea
                  id="pw-intro-en"
                  rows={4}
                  required
                  value={form.company_intro_en}
                  onChange={(e) => set("company_intro_en", e.target.value)}
                />
              </Field>
              <Separator />
              <Field
                id="pw-website"
                label="홈페이지"
                hint="바이어가 미팅 전 회사를 확인하는 채널입니다."
              >
                <Input
                  id="pw-website"
                  placeholder="https://"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  id="pw-sales"
                  label="연매출"
                  value={form.annual_sales}
                  onChange={(v) => set("annual_sales", v)}
                  options={isExhibitor ? ANNUAL_SALES_SELLER_OPTIONS : ANNUAL_SALES_BUYER_OPTIONS}
                  hint="회사 규모를 보고 바이어가 협업 가능성을 가늠합니다."
                />
                <SelectField
                  id="pw-employees"
                  label="직원 수"
                  value={form.employee_range}
                  onChange={(v) => set("employee_range", v)}
                  options={EMPLOYEE_RANGE_OPTIONS}
                  hint="조직 규모로 공급 안정성을 가늠하는 정보입니다."
                />
              </div>
              {isExhibitor ? (
                <ChipMultiSelect
                  label="상담 가능 언어"
                  values={form.available_languages}
                  options={[...PROXY_LANGUAGE_OPTIONS]}
                  onToggle={(c) => toggleIn("available_languages", c)}
                  hint="상담 가능한 언어를 고르면 통역·미팅 배정이 정확해집니다."
                />
              ) : (
                <TextField
                  id="pw-contact-lang"
                  label="상담 언어"
                  value={form.contact_language}
                  onChange={(v) => set("contact_language", v)}
                  hint="상담 가능한 언어를 적으면 통역·미팅 배정이 정확해집니다."
                />
              )}
              {/* 슬라이드6 피드백: KOTRA 회원 여부 체크박스는 삭제됐다 — 되살리지 않는다. */}
            </TabsContent>

            {/* ── 슬라이드7: 전시품목(사업분야 8종) ────────────────────────────── */}
            <TabsContent value="products" className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                전시 분야를 먼저 고르고, 전시할 제품을 추가하세요.
              </p>
              <ChipMultiSelect
                label={isExhibitor ? "사업분야" : "관심 분야"}
                values={form.categories}
                options={businessFieldOptions}
                onToggle={(c) => toggleIn("categories", c)}
                required
                hint="바이어 관심 분야와 매칭되는 핵심 태그입니다. 해당하는 항목을 모두 선택하세요."
              />
              {isExhibitor && (
                <>
                  <Separator />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold">전시 제품</h4>
                        <p className="text-xs text-muted-foreground">
                          제품별로 추가하면 바이어 탐색 화면에 개별 표시됩니다.
                        </p>
                      </div>
                      <Button
                        ref={addProductButtonRef}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingProduct({ index: null, product: { ...EMPTY_PRODUCT } })}
                      >
                        <Plus className="size-4" /> 제품 추가
                      </Button>
                    </div>
                    {form.products.length === 0 ? (
                      <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                        아직 추가한 제품이 없습니다.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {form.products.map((product, index) => (
                          <div
                            key={`${product.name_ko}-${index}`}
                            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => setEditingProduct({ index, product })}
                            >
                              <span className="block truncate text-sm font-medium">
                                {product.name_ko}
                              </span>
                              {product.name_en && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {product.name_en}
                                </span>
                              )}
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`${product.name_ko} 삭제`}
                              onClick={() =>
                                set("products", form.products.filter((_, i) => i !== index))
                              }
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </TabsContent>

            {/* ── 슬라이드8: 관심 바이어(피드백 없음 — 구조 유지) ───────────────── */}
            {isExhibitor && (
              <TabsContent value="target" className="flex flex-col gap-4">
                <div>
                  <h4 className="text-sm font-semibold">타겟</h4>
                  <p className="text-sm text-muted-foreground">만나고 싶은 바이어를 입력하세요.</p>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">선호 바이어 국가</span>
                  <p className="text-xs text-muted-foreground">
                    {form.preferred_buyer_countries.length === 0
                      ? "선택한 국가가 없습니다 — 비워 두면 국가 무관으로 매칭됩니다."
                      : `${form.preferred_buyer_countries.length}개국 선택됨.`}
                  </p>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label="국가 검색"
                      className="pl-9"
                      placeholder="국가 검색 (한글·영문)"
                      value={countryQuery}
                      onChange={(e) => setCountryQuery(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {countryOptions.map((o) => {
                      const on = form.preferred_buyer_countries.includes(o.code)
                      return (
                        <button
                          key={o.code}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleIn("preferred_buyer_countries", o.code)}
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-sm transition-colors",
                            on ? "border-primary bg-primary/5 font-medium" : "hover:bg-muted/50",
                          )}
                        >
                          {o.label}
                        </button>
                      )
                    })}
                    {countryOptions.length === 0 && (
                      <p className="text-sm text-muted-foreground">검색 결과가 없습니다.</p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    만나고 싶은 바이어의 국가를 고르면 SI가 그 국가의 바이어를 우선 매칭합니다. 비워
                    두면 국가 무관으로 매칭됩니다.
                  </p>
                </div>
                <Separator />
                <ChipMultiSelect
                  label="선호 바이어 구분"
                  values={form.preferred_buyer_types}
                  options={orgTypeOptions}
                  onToggle={(c) => toggleIn("preferred_buyer_types", c)}
                  hint="만나고 싶은 바이어 기관 유형을 고르면 그 유형의 바이어와 우선 매칭됩니다."
                />
              </TabsContent>
            )}

            {/* ── 비즈니스 미팅: 미팅 불가 슬롯(운영자 전용) ────────────────────── */}
            {isExhibitor && (
              <TabsContent value="meeting" className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">미팅 불가 시간대</h4>
                    <p className="text-xs text-muted-foreground">
                      {canEditSlots
                        ? "칸을 누르면 바로 저장됩니다. 표시된 칸은 배정 엔진이 비워 둡니다."
                        : "미팅 불가 시간은 슈퍼관리자가 지정합니다 — 이 계정에서는 조회만 됩니다."}
                    </p>
                  </div>
                  <Badge variant="outline">불가 {unavailable.length}칸</Badge>
                </div>
                <UnavailableSlotGrid
                  grid={slotGrid}
                  blocked={unavailable}
                  onToggle={(id) => void toggleSlot(id)}
                  readOnly={slotSaving || !canEditSlots}
                />
              </TabsContent>
            )}
          </Tabs>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            취소
          </Button>
          <Button type="button" disabled={saving || !ready} onClick={() => void submit()}>
            {approveImmediately ? "대리작성 후 승인" : "대리작성 후 제출"}
          </Button>
        </DialogFooter>

        {/* ⚠ ProductDialog는 반드시 부모 DialogContent의 **React 자식**으로 렌더한다(DOM 위치는
            어차피 각자 Portal로 body에 붙어 상관없다 — 문제는 React 파이버 트리다).
            @radix-ui/react-dialog의 DialogContentModal은 onFocusOutside만 자체적으로
            preventDefault한다(react-dialog/dist/index.mjs DialogContentModal) — onPointerDownOutside는
            우클릭/ctrl-클릭이 아니면 preventDefault하지 않는다. 그리고 dismissable-layer의
            "React 트리 안이면 outside 아님" 판정(onPointerDownCapture)은 이벤트 target이 **그
            DismissableLayer 노드 자신의 React 자손**일 때만 통한다 — Portal은 DOM 위치만 바꿀 뿐
            React 이벤트 버블링은 원래 트리를 그대로 타므로, ProductDialog를 부모 DialogContent
            밖의 형제로 두면(예전 코드) 자식 다이얼로그 안 클릭이 부모 입장에선 진짜 "바깥"으로
            잡혀 onPointerDownOutside → onInteractOutside → onDismiss로 부모까지 닫힌다. 실제로
            Chromium(Playwright)에서 재현·console.trace로 확인했다 — jsdom은 이 pointerdown-outside
            경합을 재현하지 못했다. 형제로 두지 말고 DialogContent 자식으로 둬야 한다. */}
        <ProductDialog
          open={editingProduct !== null}
          product={editingProduct?.product ?? null}
          readOnly={false}
          onOpenChange={(isOpen) => {
            if (!isOpen) setEditingProduct(null)
          }}
          onSave={saveProduct}
          returnFocusRef={addProductButtonRef}
        />
      </DialogContent>
    </Dialog>
  )
}
