"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, TextField } from "./shared"
import {
  ANNUAL_SALES_SELLER_OPTIONS,
  BUSINESS_FIELD_OPTIONS,
  EMPLOYEE_RANGE_OPTIONS,
  PRODUCT_PRICE_RANGE_OPTIONS,
} from "@/lib/bm/fields"
import type {
  AdminBuyerProfilePatch,
  AdminExhibitorProductPatch,
  AdminExhibitorProfilePatch,
  AdminOrgProfilePatch,
  AdminOrgRole,
} from "@/lib/admin/types"
import { sameOperatorValue, type OperatorOrgDetailApi } from "@/lib/operator/application-client"

// 대리작성 다이얼로그(proxy-write-dialog.tsx)의 폼 상태·패치 조립·부품.
//
// 예전 이름은 profile-editor였고, 제출된 신청서를 고치는 인라인 폼(ProfileEditor)도 여기 있었다.
// 그 폼은 신청서의 일부 항목만 다뤄서 없앴다 — 미신청이 아닌 기업의 신청서는 이제 두 콘솔이 함께 쓰는
// 패널(components/operator/application-panel, 참가자 신청서의 모든 항목)이 맡는다. 이 파일에는
// 미신청(registered) 기업의 대리작성(POST .../proxy-profile)이 쓰는 것만 남았다.
//
// ⚠ backend 두 role 스키마(BuyerProfilePatch/AdminExhibitorProfilePatch)는 extra="forbid"라 role에
// 안 맞는 필드를 보내면 422다. enum 코드 필드(연매출·직원수·분야)도 backend Literal 밖 값이면 422 —
// 그래서 다이얼로그는 코드 고정 <select>·칩을 쓰고, toProxyProfilePatch가 role별로 정확한 필드만·유효
// 코드만 골라 보낸다(enum-guard).

type Opt = { code: string; label: string }

// 바이어 연매출 — lib/apply/options.ts에도 있지만 그 모듈은 참가자 화면용이라, backend
// app/bm/schemas.py Literal과 대조해 여기 로컬로 미러한다(코드가 바뀌면 여기도 같이 고칠 것).
export const ANNUAL_SALES_BUYER_OPTIONS: Opt[] = [
  { code: "usd_lt_500k", label: "USD 500,000 미만" },
  { code: "usd_500k_1m", label: "USD 500,000 ~ 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000" },
  { code: "usd_gt_5m", label: "USD 5,000,000 초과" },
]

// 대리작성 다이얼로그가 **실제로 보여 주는 칸**만 담는다. 여기 없는 칸(사업자등록번호·대표자·담당자·
// 주소·부스·바이어 구분·통역 필요 등)은 대리작성으로 보내지 않는다 — 화면에 없는 칸의 옛 값을 다시
// 보내면 그 사이 바뀐 서버 값을 되돌리거나, 담당자 이름처럼 다른 칸으로 옮겨 적는 사고가 난다.
// 그 항목들은 대리작성 직후 열리는 신청서 편집 패널에서 채운다.
//
// 보이는 칸도 **운영자가 이 다이얼로그에서 바꾼 것만** 보낸다(toProxyProfilePatch). 미신청(registered)은
// 참가자가 신청서를 작성하는 중일 수 있는 상태다 — 손대지 않은 칸까지 되보내면 참가자가 써 둔 값(특히
// 전체 교체인 제품 목록)을 덮는다. 초깃값도 목록 화면에 실려 온 값이 아니라 **다이얼로그를 열 때 서버에서
// 새로 읽은 상세**로 만든다(toFormState). 저장 직전에는 한 번 더 읽어, 운영자가 바꾼 칸이 그 사이 서버에서도
// 달라졌으면 보내지 않는다(proxyPatchConflicts — 클라이언트 쪽 검사, lib/operator/application-client 참고).
export interface ProfileFormState {
  website: string
  annual_sales: string
  employee_range: string
  categories: string[] // 참가사 사업분야 / 바이어 관심분야 — 코드 배열(멀티선택)
  company_intro_ko: string
  company_intro_en: string
  contact_language: string // 바이어 전용 — 상담 언어
  products: AdminExhibitorProductPatch[] // 참가사 전용 — 전시 제품 목록(행마다 숨은 칸까지 그대로 든다)
  // 참가사 전용 — 상담 가능 언어(멀티)·선호 바이어 국가·구분.
  available_languages: string[]
  preferred_buyer_countries: string[]
  preferred_buyer_types: string[]
}

const s = (v: string | null | undefined): string => v ?? ""

// 아직 서버에서 읽지 못했을 때의 빈 폼(읽는 동안·읽기 실패 시 — 이 상태로는 저장하지 못한다).
export const EMPTY_PROFILE_FORM: ProfileFormState = {
  website: "",
  annual_sales: "",
  employee_range: "",
  categories: [],
  company_intro_ko: "",
  company_intro_en: "",
  contact_language: "",
  products: [],
  available_languages: [],
  preferred_buyer_countries: [],
  preferred_buyer_types: [],
}

// 운영자 상세(GET .../organizations/{id} — 프로필은 참가자 API와 같은 응답 모델) → 폼 상태.
// 역할에 맞는 프로필만 읽는다(다른 역할의 값을 섞지 않는다). 프로필이 아직 없는 미신청 기업도 백엔드가
// 빈 프로필을 돌려주므로 빈 폼이 된다. 제품은 백엔드 원본 행(숨은 칸 포함)을 그대로 든다.
export function toFormState(
  detail: Pick<OperatorOrgDetailApi, "buyer_profile" | "exhibitor_profile"> | null,
  role: AdminOrgRole,
): ProfileFormState {
  if (role === "buyer") {
    const buyer = detail?.buyer_profile
    return {
      ...EMPTY_PROFILE_FORM,
      website: s(buyer?.website),
      annual_sales: s(buyer?.annual_sales_range),
      employee_range: s(buyer?.employee_range),
      categories: [...(buyer?.interest_categories ?? [])],
      company_intro_ko: s(buyer?.company_intro_ko),
      company_intro_en: s(buyer?.company_intro_en),
      contact_language: s(buyer?.contact_language),
    }
  }
  const exhibitor = detail?.exhibitor_profile
  return {
    ...EMPTY_PROFILE_FORM,
    website: s(exhibitor?.website),
    annual_sales: s(exhibitor?.annual_sales_range),
    employee_range: s(exhibitor?.employee_range),
    categories: [...(exhibitor?.exhibition_categories ?? [])],
    company_intro_ko: s(exhibitor?.intro_ko),
    company_intro_en: s(exhibitor?.intro_en),
    products: (exhibitor?.products ?? []).map((product) => ({ ...product })),
    available_languages: [...(exhibitor?.available_languages ?? [])],
    preferred_buyer_countries: [...(exhibitor?.preferred_buyer_countries ?? [])],
    preferred_buyer_types: [...(exhibitor?.preferred_buyer_types ?? [])],
  }
}

// 빈 문자열은 "값을 지운다"가 아니라 "안 건드린다" — 키 자체를 omit한다(대리작성은 빈 신청서를
// 채워 넣는 화면이다. 값을 지우는 것은 신청서 편집 패널의 몫이다).
const n = (v: string): string | undefined => {
  const t = v.trim()
  return t === "" ? undefined : t
}

// enum-guard — 옵션 목록에 없는 값(빈 문자열 포함)은 omit한다. backend Literal 밖 값은 422라
// "그냥 보내고 서버가 걸러주길" 기대할 수 없다.
function pick(value: string, options: readonly Opt[]): string | undefined {
  return options.some((o) => o.code === value) ? value : undefined
}

// ── "바꾼 칸만" 판정 ─────────────────────────────────────────────────────────
// initial = 다이얼로그를 **열었을 때**의 폼 상태(운영자가 본 초깃값). 그 뒤 손댄 칸만 본문에 싣는다.

// 문자열 칸 — 바꾼 값만. 비운 칸은 위 n()대로 "안 건드림"이다.
function changedText(current: string, initial: string): string | undefined {
  const value = n(current)
  return value !== undefined && value !== n(initial) ? value : undefined
}

// 코드 칸 — 바꾼 값만, 그리고 선택지에 있는 코드만(enum-guard).
function changedCode(
  current: string,
  initial: string,
  options: readonly Opt[],
): string | undefined {
  return current !== initial ? pick(current, options) : undefined
}

// 코드 목록(전체 교체) — 고른 집합이 달라졌을 때만 보낸다(껐다 켜서 순서만 바뀐 것은 변경이 아니다).
// 다 빼면 빈 배열이 나가 서버 값을 비운다. 손대지 않았으면 보내지 않는다: 그 사이 다른 경로(참가자
// 작성·다른 운영자)로 채워진 값을 지우거나 옛 목록으로 되돌리지 않는다.
function changedCodes(current: string[], initial: string[]): string[] | undefined {
  const a = [...current].sort()
  const b = [...initial].sort()
  return a.length === b.length && a.every((code, i) => code === b[i]) ? undefined : current
}

// 제품 목록 본문 — 이름 없는 행은 뺀다. 행마다 자기 숨은 칸(구 카테고리·HS 설명·영문 사양)을 그대로
// 들고 있다 — 다른 행의 값과 섞지 않는다(예전엔 "같은 순번의 옛 행"과 합쳐, 행을 지우고 새로 넣으면
// 옛 행의 숨은 칸이 묻어 갔다).
function productRows(products: AdminExhibitorProductPatch[]): AdminExhibitorProductPatch[] {
  return products
    .filter((product) => product.name_ko.trim())
    .map((product) => ({ ...product, name_ko: product.name_ko.trim() }))
}

// 제품 목록 비교용 지문 — 키 순서에 흔들리지 않게 정렬해 직렬화한다(편집 다이얼로그를 열었다 그대로
// 닫으면 같은 값이 키 순서만 달라져 돌아올 수 있다).
function productsFingerprint(products: AdminExhibitorProductPatch[]): string {
  return JSON.stringify(
    products.map((product) =>
      Object.entries(product)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  )
}

// 폼 상태 → 대리작성 본문. role별로 정확한 필드만 담는다(다른 role 필드를 섞으면 backend가 422).
// 운영자가 다이얼로그에서 **바꾼 칸만** 담는다 — 아무것도 안 바꿨으면 빈 본문이다(대리작성의 본체는
// 상태 전이라 빈 본문도 유효하다: 서버에 있던 값은 그대로 남는다).
export function toProxyProfilePatch(
  form: ProfileFormState,
  role: AdminOrgRole,
  initial: ProfileFormState,
): AdminOrgProfilePatch {
  const website = changedText(form.website, initial.website)
  const introKo = changedText(form.company_intro_ko, initial.company_intro_ko)
  const introEn = changedText(form.company_intro_en, initial.company_intro_en)
  const employeeRange = changedCode(
    form.employee_range,
    initial.employee_range,
    EMPLOYEE_RANGE_OPTIONS,
  )

  if (role === "buyer") {
    const patch: AdminBuyerProfilePatch = {}
    if (website !== undefined) patch.website = website
    if (introKo !== undefined) patch.company_intro_ko = introKo
    if (introEn !== undefined) patch.company_intro_en = introEn
    // 자유텍스트 허용 — enum-guard 없음
    const contactLanguage = changedText(form.contact_language, initial.contact_language)
    if (contactLanguage !== undefined) patch.contact_language = contactLanguage
    const sales = changedCode(form.annual_sales, initial.annual_sales, ANNUAL_SALES_BUYER_OPTIONS)
    if (sales !== undefined) patch.annual_sales_range = sales
    if (employeeRange !== undefined) patch.employee_range = employeeRange
    const interests = changedCodes(form.categories, initial.categories)
    if (interests !== undefined) patch.interest_categories = interests
    return patch
  }

  // exhibitor
  const patch: AdminExhibitorProfilePatch = {}
  if (website !== undefined) patch.website = website
  if (introKo !== undefined) patch.intro_ko = introKo
  if (introEn !== undefined) patch.intro_en = introEn
  const sales = changedCode(form.annual_sales, initial.annual_sales, ANNUAL_SALES_SELLER_OPTIONS)
  if (sales !== undefined) patch.annual_sales_range = sales
  if (employeeRange !== undefined) patch.employee_range = employeeRange

  const categories = changedCodes(form.categories, initial.categories)
  if (categories !== undefined) patch.exhibition_categories = categories
  const languages = changedCodes(form.available_languages, initial.available_languages)
  if (languages !== undefined) patch.available_languages = languages
  const countries = changedCodes(form.preferred_buyer_countries, initial.preferred_buyer_countries)
  if (countries !== undefined) patch.preferred_buyer_countries = countries
  const types = changedCodes(form.preferred_buyer_types, initial.preferred_buyer_types)
  if (types !== undefined) patch.preferred_buyer_types = types

  // 제품 목록도 전체 교체다 — 행을 더하거나 고치거나 뺐을 때만 (다이얼로그에 보이는) 목록 전체를 보낸다.
  const products = productRows(form.products)
  if (productsFingerprint(products) !== productsFingerprint(productRows(initial.products))) {
    patch.products = products
  }

  return patch
}

// 본문 키 → 그 값을 든 폼 칸(toProxyProfilePatch가 만들 수 있는 키 전부 — 역할별).
// 충돌 비교가 "내 본문에 든 키"의 서버 값을 폼 상태에서 찾는 데 쓴다. 본문 조립에 키를 더하면 여기도 더한다
// (proxy-profile-form.test.tsx가 두 표의 일치를 고정한다).
export const PROXY_BODY_FIELDS: Record<AdminOrgRole, Record<string, keyof ProfileFormState>> = {
  buyer: {
    website: "website",
    company_intro_ko: "company_intro_ko",
    company_intro_en: "company_intro_en",
    contact_language: "contact_language",
    annual_sales_range: "annual_sales",
    employee_range: "employee_range",
    interest_categories: "categories",
  },
  exhibitor: {
    website: "website",
    intro_ko: "company_intro_ko",
    intro_en: "company_intro_en",
    annual_sales_range: "annual_sales",
    employee_range: "employee_range",
    exhibition_categories: "categories",
    available_languages: "available_languages",
    preferred_buyer_countries: "preferred_buyer_countries",
    preferred_buyer_types: "preferred_buyer_types",
    products: "products",
  },
}

// 비교용 값 — 문자열은 앞뒤 공백을 떼고, 제품은 본문에 나갈 모양(이름 없는 행 제외)으로 맞춘다.
function comparable(value: ProfileFormState[keyof ProfileFormState]): unknown {
  if (typeof value === "string") return value.trim()
  if (value.length > 0 && typeof value[0] === "object") {
    return productRows(value as AdminExhibitorProductPatch[])
  }
  return value
}

// 충돌 — **내 본문에 든 키** 가운데, 다이얼로그를 연 뒤(initial) 서버에서 달라진(latest) 칸의 본문 키.
// latest = 저장 직전에 다시 읽은 서버 값으로 만든 폼 상태. 하나라도 있으면 보내지 않는다: 운영자의 값은
// 옛 서버 값을 보고 정한 것이라, 보내면 그 사이의 수정을 덮는다. 운영자가 손대지 않은 칸은 애초에 보내지
// 않으므로 서버에서 바뀌었어도 충돌이 아니다.
//
// ⚠ "달라졌다"를 본문 조립 규칙(toProxyProfilePatch — 빈 값은 "안 건드림"이라 키를 뺀다)으로 가리지
// 않는다. 그 규칙으로 보면 서버에서 **비워진** 칸이 "변경 없음"이 돼, 참가자가 지운 값을 운영자의 저장이
// 되살린다. 여기서는 값의 뜻으로 견준다(lib/operator/application-client sameOperatorValue — 빈 값끼리는
// 같고, 값이 있다가 비워진 것은 다르다. 코드 목록은 집합, 제품은 순서와 내용 전체).
export function proxyPatchConflicts(
  form: ProfileFormState,
  role: AdminOrgRole,
  initial: ProfileFormState,
  latest: ProfileFormState,
): string[] {
  const mine = toProxyProfilePatch(form, role, initial)
  return Object.keys(mine).filter((bodyKey) => {
    const field = PROXY_BODY_FIELDS[role][bodyKey]
    // 표에 없는 키는 견줄 서버 값을 모른다 — 모르는 채로 보내지 않는다(충돌로 친다).
    if (!field) return true
    return !sameOperatorValue(comparable(latest[field]), comparable(initial[field]))
  })
}

// 코드 고정 필드용 네이티브 단일선택. components/ui/select.tsx가 없어(shadcn 미도입) 순수
// <select>를 Input과 같은 시각 언어로 감싼다.
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = "선택 안 함",
  disabled,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly Opt[]
  placeholder?: string
  disabled?: boolean
  hint?: string
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function ProductDialog({
  open,
  product,
  readOnly,
  onOpenChange,
  onSave,
  returnFocusRef,
}: {
  // 부모가 이 컴포넌트 자체를 조건부로 마운트/언마운트하지 않고 open으로만 제어해야 한다 —
  // {product && <ProductDialog/>} 패턴은 Radix 자체 종료 애니메이션 없이 즉시 언마운트돼
  // Trigger 없는 이 다이얼로그의 포커스 복원 타이밍이 어긋난다. (실제 부모-닫힘 버그의 근본 원인은
  // 이게 아니었다 — 호출부가 ProductDialog를 부모 DialogContent의 React 자손으로 두는지가
  // 진짜 원인이었다. 호출부 주석 참고.)
  open: boolean
  product: AdminExhibitorProductPatch | null
  readOnly: boolean
  onOpenChange: (open: boolean) => void
  onSave: (product: AdminExhibitorProductPatch) => void
  // 이 다이얼로그엔 DialogTrigger가 없어(부모가 별도 "제품 추가" 버튼으로 연다) Radix
  // DialogContentModal의 기본 onCloseAutoFocus(triggerRef.current?.focus())가 아무 데도
  // 포커스를 못 돌려준다. 호출부가 "제품 추가" 버튼 ref를 넘기면 닫힐 때 명시적으로 거기로
  // 되돌린다 — 안 넘기면 Radix 기본(FocusScope의 열기 전 active element 복원)을 그대로 쓴다.
  returnFocusRef?: React.RefObject<HTMLElement | null>
}) {
  const [draft, setDraft] = useState<AdminExhibitorProductPatch | null>(product)
  const [prevOpen, setPrevOpen] = useState(open)

  // 열릴 때만 초안을 새로 싣는다 — 닫히는 동안(종료 애니메이션 중)에는 이전 값을 유지해야
  // 컴포넌트가 계속 마운트된 채로 있을 수 있다. effect가 아니라 렌더 중에 open 전환을 감지해
  // 반영하므로 첫 오픈에 빈/이전 값이 한 프레임 보이지 않는다.
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setDraft(product)
  }

  const set = <K extends keyof AdminExhibitorProductPatch>(
    key: K,
    value: AdminExhibitorProductPatch[K],
  ) => setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(e) => {
          if (!returnFocusRef?.current) return
          e.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>전시 제품</DialogTitle>
          <DialogDescription>제품 정보를 입력해 주세요.</DialogDescription>
        </DialogHeader>
        {draft && (
          <>
            <div className="grid gap-4 px-5 pb-2 md:grid-cols-2">
              <TextField
                id="product-name-ko"
                label="제품명(국문)"
                value={draft.name_ko}
                onChange={(value) => set("name_ko", value)}
                disabled={readOnly}
              />
              <TextField
                id="product-name-en"
                label="제품명(영문)"
                value={draft.name_en ?? ""}
                onChange={(value) => set("name_en", value)}
                disabled={readOnly}
              />
              <SelectField
                id="product-business-field"
                label="사업분야"
                value={draft.business_field ?? ""}
                onChange={(value) => set("business_field", value || null)}
                options={BUSINESS_FIELD_OPTIONS}
                disabled={readOnly}
              />
              <TextField
                id="product-hs-code"
                label="HS코드"
                placeholder="예: 8517.62"
                value={draft.hs_code ?? ""}
                onChange={(value) => set("hs_code", value)}
                disabled={readOnly}
              />
              <SelectField
                id="product-price-range"
                label="가격대"
                value={draft.price_range ?? ""}
                onChange={(value) => set("price_range", value || null)}
                options={PRODUCT_PRICE_RANGE_OPTIONS}
                disabled={readOnly}
              />
              <Field id="product-spec" label="사양(국문)">
                <Textarea
                  id="product-spec"
                  rows={3}
                  value={draft.spec ?? ""}
                  disabled={readOnly}
                  onChange={(e) => set("spec", e.target.value)}
                />
              </Field>
            </div>
            {!readOnly && (
              <DialogFooter className="justify-end border-t">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  취소
                </Button>
                <Button
                  type="button"
                  disabled={!draft.name_ko.trim()}
                  onClick={() => {
                    onSave(draft)
                    onOpenChange(false)
                  }}
                >
                  저장
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
