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
// 이 다이얼로그는 **대리작성(mode=proxy) 전용**이다. 정정(mode=edit)은 기존 인라인
// ProfileEditor가 그대로 담당한다 — 기본정보·담당자 수정 경로를 잃지 않기 위해서다.
// 슬라이드에 없는 회사소개(국문)는 기능 보존을 위해 영문 위에 둔다(등록 기업은 대리작성이 유일한
// 쓰기 경로라 여기서 빼면 국문 소개를 채울 방법이 없어진다).
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
import { patchUnavailableSlots } from "@/lib/admin/admin-actions"
import { eventDateIds, formatEventDate } from "@/lib/admin/events"
import { ADMIN_STATUS_LABELS } from "@/lib/admin/proxy-profile"
import {
  ADMIN_ORG_ROLE_LABELS,
  type AdminEvent,
  type AdminEventSettings,
  type AdminExhibitorProductPatch,
  type AdminOrganization,
  type AdminOrgProfile,
} from "@/lib/admin/types"
import {
  ANNUAL_SALES_SELLER_OPTIONS,
  BUYER_COUNTRY_OPTIONS,
  BUYER_COUNTRY_OPTIONS_EN,
  EMPLOYEE_RANGE_OPTIONS,
  businessFieldOptionsFor,
  orgTypeOptionsFor,
} from "@/lib/bm/fields"
import { slotId, slotTimes } from "@/lib/organizer/schedule"
import { cn } from "@/lib/utils"
import {
  ANNUAL_SALES_BUYER_OPTIONS,
  ProductDialog,
  SelectField,
  toFormState,
  type ProfileFormState,
} from "./profile-editor"
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

export function ProxyWriteDialog({
  open,
  onOpenChange,
  org,
  profile,
  event,
  settings,
  approveImmediately,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: AdminOrganization
  profile: AdminOrgProfile | null
  // 행사·설정이 없으면(조회 실패) 비즈니스 미팅 탭을 접는다 — 나머지는 그대로 동작해야 한다.
  event: AdminEvent | null
  settings: AdminEventSettings | null
  // master면 저장과 동시에 승인, sub면 승인 대기(proxy-profile.ts 규칙) — 버튼 문구만 갈린다.
  approveImmediately: boolean
  // 폼 상태를 그대로 올린다 — 패치 조립(toProfilePatch)·낙관 반영은 콘솔이 단일 소유한다.
  onSave: (form: ProfileFormState) => void
}) {
  const isExhibitor = org.role === "exhibitor"
  const [form, setForm] = useState<ProfileFormState>(() => toFormState(profile))
  const [editingProduct, setEditingProduct] = useState<{
    index: number | null
    product: AdminExhibitorProductPatch | null
  } | null>(null)
  // ProductDialog는 자체 DialogTrigger가 없어(이 버튼으로 연다) 닫힐 때 포커스를 여기로 명시
  // 복원한다(ProductDialog의 onCloseAutoFocus/returnFocusRef).
  const addProductButtonRef = useRef<HTMLButtonElement>(null)
  const [countryQuery, setCountryQuery] = useState("")
  const [unavailable, setUnavailable] = useState<string[]>(org.unavailable_slots)

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

  const dateIds = useMemo(() => (event ? eventDateIds(event) : []), [event])
  const times = useMemo(
    () =>
      settings
        ? slotTimes({
            startTime: settings.operating_start,
            endTime: settings.operating_end,
            lunchStart: settings.lunch_start ?? "00:00",
            lunchEnd: settings.lunch_end ?? "00:00",
            slotMinutes: settings.slot_minutes,
            slotGapMinutes: settings.slot_gap_minutes,
            minSlots: settings.min_guaranteed_slots,
            maxMeetingMinutes: settings.max_meeting_minutes,
          })
        : [],
    [settings],
  )
  const blocked = new Set(unavailable)

  function toggleSlot(id: string) {
    if (!event) return
    const next = unavailable.includes(id)
      ? unavailable.filter((s) => s !== id)
      : [...unavailable, id].sort()
    setUnavailable(next)
    // 불가 슬롯은 프로필 패치가 아니라 운영자 전용 엔드포인트로 나간다(ExhibitorStep4 docstring).
    void patchUnavailableSlots(event.id, org.id, next).then((r) => {
      if (!r.success) toast.error("미팅 불가 시간 저장에 실패했어요")
    })
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>신청서 대리작성</DialogTitle>
          <DialogDescription>
            {org.name_ko} · {ADMIN_ORG_ROLE_LABELS[org.role]} · 현재 상태:{" "}
            {ADMIN_STATUS_LABELS[org.application_status]}
          </DialogDescription>
        </DialogHeader>

        {/* 헤더·푸터는 dialog.tsx 기본 px-5를 쓰는데 탭 영역만 여백이 없어 화면 끝에 붙어
            보였다(고객 피드백) — 헤더·푸터와 맞춰 좌우 여백을 준다. */}
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
                    칸을 눌러 배정 불가 시간을 지정합니다. 표시된 칸은 배정 엔진이 비워 둡니다.
                  </p>
                </div>
                <Badge variant="outline">불가 {blocked.size}칸</Badge>
              </div>
              {dateIds.length === 0 || times.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  슬롯 격자를 만들 수 없습니다. 행사 기간과 미팅 시간 단위를 먼저 확인해 주세요.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-muted/40">
                        <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground">
                          날짜
                        </th>
                        {times.map((t) => (
                          <th
                            key={t}
                            className="px-1 py-2 text-center font-medium tabular-nums text-muted-foreground"
                          >
                            {t}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dateIds.map((dateId) => (
                        <tr key={dateId} className="border-t">
                          <td className="sticky left-0 z-10 whitespace-nowrap bg-background px-3 py-1.5 font-medium">
                            {formatEventDate(dateId)}
                          </td>
                          {times.map((t) => {
                            const id = slotId(dateId, t)
                            const on = blocked.has(id)
                            return (
                              <td key={id} className="p-0.5 text-center">
                                <button
                                  type="button"
                                  aria-pressed={on}
                                  aria-label={`${formatEventDate(dateId)} ${t} ${on ? "불가" : "가능"}`}
                                  onClick={() => toggleSlot(id)}
                                  className={cn(
                                    "h-6 w-full min-w-8 rounded border text-[10px] transition-colors",
                                    on
                                      ? "border-destructive/50 bg-destructive/15 text-destructive"
                                      : "border-transparent hover:bg-muted/60",
                                  )}
                                >
                                  {on ? "불가" : ""}
                                </button>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>
          )}
        </Tabs>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(form)
              onOpenChange(false)
            }}
          >
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
