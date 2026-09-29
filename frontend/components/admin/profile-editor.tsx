"use client"

import { useRef, useState } from "react"
import { Info, Plus, Trash2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Separator } from "@/components/ui/separator"
import { Field, TextField } from "./shared"
import {
  ANNUAL_SALES_BUYER_LABELS,
  ANNUAL_SALES_SELLER_LABELS,
  ANNUAL_SALES_SELLER_OPTIONS,
  BUSINESS_FIELD_LABELS,
  BUSINESS_FIELD_OPTIONS,
  EMPLOYEE_RANGE_LABELS,
  EMPLOYEE_RANGE_OPTIONS,
  ORG_TYPE_LABELS,
  ORG_TYPE_OPTIONS,
  labelFor,
  labelsFor,
  PRODUCT_PRICE_RANGE_OPTIONS,
} from "@/lib/bm/fields"
import type {
  AdminBuyerProfilePatch,
  AdminExhibitorAttendeePatch,
  AdminExhibitorProductPatch,
  AdminExhibitorProfilePatch,
  AdminOrganization,
  AdminOrgProfile,
  AdminOrgProfilePatch,
  AdminOrgRole,
} from "@/lib/admin/types"

// 신청서(프로필) 인라인 편집 폼 — 슈퍼어드민 콘솔의 핵심 요구("모든 것을 조회·수정").
//
// 한 폼이 두 가지 저장을 낸다:
//   · 정정(PATCH /organizations/{id}/profile) — 이미 제출한 기업의 신청서를 고친다. 상태 불변.
//   · 대리작성(POST /organizations/{id}/proxy-profile) — 미신청 기업의 신청서를 대신 제출한다.
//     master는 즉시 승인되고 sub는 승인 대기로 전환된다(lib/admin/proxy-profile 규칙).
// 어느 쪽인지는 기업의 현재 상태가 정하고, 폼은 저장 버튼 문구·안내만 바꾼다.
//
// ⚠ backend 두 role 스키마(BuyerProfilePatch/ExhibitorProfilePatch)는 extra="forbid"라 role에
// 안 맞는 필드를 보내면 422다. enum 코드 필드(참가자구분·연매출·직원수·분야·예산·도입시기)도
// backend Literal 밖 값이면 422 — 그래서 이 폼은 자유텍스트 대신 코드 고정 <select>를 쓰고,
// toProfilePatch가 role별로 정확한 필드만·유효 코드만 골라 보낸다(enum-guard).

// ── enum 옵션 — 버튼/셀렉트 소스 ─────────────────────────────────────────────
// seller·공통 4종(참가자구분·셀러연매출·직원수·사업분야)은 lib/bm/fields.ts(실 등록폼과 동일
// 소스, backend Literal과 assert로 맞물려 있다)를 그대로 쓴다.
//
// 바이어 전용 3종(바이어연매출·예산구간·도입시기)은 lib/apply/options.ts에도 있지만 그 모듈은
// 폐기 흐름이라 드리프트 위험이 있다 — backend app/bm/schemas.py Literal과 대조해 여기 로컬로
// 미러한다(코드가 바뀌면 여기도 같이 고칠 것).
type Opt = { code: string; label: string }

export const ANNUAL_SALES_BUYER_OPTIONS: Opt[] = [
  { code: "usd_lt_500k", label: "USD 500,000 미만" },
  { code: "usd_500k_1m", label: "USD 500,000 ~ 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000" },
  { code: "usd_gt_5m", label: "USD 5,000,000 초과" },
]

const BUDGET_RANGE_OPTIONS: Opt[] = [
  { code: "usd_lt_100k", label: "USD 100,000 미만" },
  { code: "usd_100k_500k", label: "USD 100,000 ~ 500,000" },
  { code: "usd_500k_1m", label: "USD 500,000 ~ 1,000,000" },
  { code: "usd_1m_5m", label: "USD 1,000,000 ~ 5,000,000" },
  { code: "usd_5m_10m", label: "USD 5,000,000 ~ 10,000,000" },
  { code: "usd_10m_plus", label: "USD 10,000,000 이상" },
]

const ADOPTION_TIMELINE_OPTIONS: Opt[] = [
  { code: "2026_h2", label: "2026년 하반기" },
  { code: "2027_h1", label: "2027년 상반기" },
  { code: "2027_h2", label: "2027년 하반기" },
  { code: "2028_h1", label: "2028년 상반기" },
  { code: "2028_h2", label: "2028년 하반기" },
  { code: "2029_h1", label: "2029년 상반기" },
  { code: "2029_h2", label: "2029년 하반기" },
  { code: "2030_h1", label: "2030년 상반기" },
  { code: "2030_h2", label: "2030년 하반기" },
  { code: "undecided", label: "미정" },
]

// 참가사 담당자 상담언어 — backend Lang(ko,en,zh,ja,ru,vi,other) 로컬 미러. lib/apply/options.ts의
// LANGUAGES는 참가자 화면용으로 en/vi 2종만 노출해 여기 목적(운영자가 실제 담당자 언어를 정확히
// 기록)과 다르다 — lib/admin/interpreters.ts의 LangCode와 같은 코드 집합을 별도로 유지한다.
const EXHIBITOR_CONTACT_LANG_OPTIONS: Opt[] = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "영어" },
  { code: "zh", label: "중국어" },
  { code: "ja", label: "일본어" },
  { code: "ru", label: "러시아어" },
  { code: "vi", label: "베트남어" },
  { code: "other", label: "기타" },
]

export interface ProfileFormState {
  business_reg_no: string
  website: string
  representative_name: string
  company_email: string
  main_tel: string
  address: string
  country: string
  org_type: string
  annual_sales: string
  employee_range: string
  categories: string[] // 코드 배열(멀티선택) — 이전엔 쉼표구분 문자열이었다
  company_intro_ko: string
  company_intro_en: string
  contact_name: string
  contact_title: string
  contact_email: string
  contact_phone: string
  contact_language: string
  interpreter_need: boolean
  budget_range: string
  adoption_timeline: string
  booth_label: string
  products: AdminExhibitorProductPatch[]
  // 참가사 전용 — 상담 가능 언어(멀티)·선호 바이어 국가·구분(대리작성 다이얼로그 탭).
  available_languages: string[]
  preferred_buyer_countries: string[]
  preferred_buyer_types: string[]
  // 참가사 전용 — 담당자·제품 "보존 리스트"(폼에 노출되지 않는다). attendees/products는
  // backend가 전체교체라 index0(폼이 편집하는 유일한 담당자)만 고치고 나머지·다른 필드는 이걸로
  // 함께 실어 보낸다. AdminOrgProfile.exhibitor_attendees/exhibitor_products를 그대로 들고 온다.
  exhibitorAttendees?: AdminExhibitorAttendeePatch[]
  exhibitorProducts?: AdminExhibitorProductPatch[]
}

const s = (v: string | null | undefined): string => v ?? ""

export function toFormState(profile: AdminOrgProfile | null): ProfileFormState {
  const products =
    profile?.exhibitor_products && profile.exhibitor_products.length > 0
      ? profile.exhibitor_products
      : profile?.products ?? []
  return {
    business_reg_no: s(profile?.business_reg_no),
    website: s(profile?.website),
    representative_name: s(profile?.representative_name),
    company_email: s(profile?.company_email),
    main_tel: s(profile?.main_tel),
    address: s(profile?.address),
    country: s(profile?.country),
    org_type: s(profile?.org_type),
    annual_sales: s(profile?.annual_sales),
    employee_range: s(profile?.employee_range),
    categories: profile?.categories ?? [],
    company_intro_ko: s(profile?.company_intro_ko),
    company_intro_en: s(profile?.company_intro_en),
    contact_name: s(profile?.contact_name),
    contact_title: s(profile?.contact_title),
    contact_email: s(profile?.contact_email),
    contact_phone: s(profile?.contact_phone),
    contact_language: s(profile?.contact_language),
    interpreter_need: profile?.interpreter_need ?? false,
    budget_range: s(profile?.budget_range),
    adoption_timeline: s(profile?.adoption_timeline),
    booth_label: s(profile?.booth_label),
    products,
    available_languages: profile?.available_languages ?? [],
    preferred_buyer_countries: profile?.preferred_buyer_countries ?? [],
    preferred_buyer_types: profile?.preferred_buyer_types ?? [],
    exhibitorAttendees: profile?.exhibitor_attendees,
    exhibitorProducts: profile?.exhibitor_products,
  }
}

// 빈 문자열은 "값을 지운다"가 아니라 "안 건드린다" — 키 자체를 omit한다(값 지움은 별도 UI가
// 없다, 채워서 저장하는 화면이라 지움 의도를 문자열 비움과 구분할 수 없기 때문).
const n = (v: string): string | undefined => {
  const t = v.trim()
  return t === "" ? undefined : t
}

// enum-guard — 옵션 목록에 없는 값(빈 문자열 포함)은 omit한다. backend Literal 밖 값은 422라
// "그냥 보내고 서버가 걸러주길" 기대할 수 없다.
function pick(value: string, options: readonly Opt[]): string | undefined {
  return options.some((o) => o.code === value) ? value : undefined
}

// 참가사 담당자[0] 병합 — 폼은 담당자 목록 중 index0만 편집한다. attendees는 backend가
// delete-then-insert 전체교체라 index0만 보내면 나머지 담당자가 삭제된다 — 보존 리스트의
// 1번 이후는 그대로 들고, 0번만 폼 값으로 갈아끼워 전체를 다시 보낸다.
function mergeExhibitorAttendees(
  form: ProfileFormState,
): AdminExhibitorAttendeePatch[] | undefined {
  const preserved = form.exhibitorAttendees ?? []
  const base = preserved[0] ?? {}
  const rest = preserved.slice(1)
  const index0: AdminExhibitorAttendeePatch = { ...base }

  const name = n(form.contact_name)
  const title = n(form.contact_title)
  const email = n(form.contact_email)
  const tel = n(form.contact_phone)
  const lang = pick(form.contact_language, EXHIBITOR_CONTACT_LANG_OPTIONS)

  if (name !== undefined) index0.last_name_ko = name
  if (title !== undefined) index0.title_ko = title
  if (email !== undefined) index0.email = email
  if (tel !== undefined) index0.tel = tel
  if (lang !== undefined) index0.languages = [lang]

  const touchedIndex0 =
    name !== undefined || title !== undefined || email !== undefined || tel !== undefined || lang !== undefined
  // 보존분도 없고 이번에 채운 것도 없으면 — 보낼 담당자 자체가 없다(키 omit).
  if (!touchedIndex0 && Object.keys(base).length === 0 && rest.length === 0) return undefined
  return [index0, ...rest]
}

function mergeExhibitorProducts(
  form: ProfileFormState,
): AdminExhibitorProductPatch[] | undefined {
  const preserved = form.exhibitorProducts ?? []
  const products = form.products
    .filter((product) => product.name_ko.trim())
    .map((product, i) => ({ ...(preserved[i] ?? {}), ...product, name_ko: product.name_ko.trim() }))
  if (products.length === 0) {
    // 보존분이 있었는데 지금 비어 있으면 명시적으로 전량 삭제, 원래 없었으면 보낼 게 없다.
    return preserved.length > 0 ? [] : undefined
  }
  return products
}

// 폼 상태 → PATCH 본문. role별로 정확한 필드만 담는다(다른 role 필드를 섞으면 backend가 422).
export function toProfilePatch(form: ProfileFormState, role: AdminOrgRole): AdminOrgProfilePatch {
  if (role === "buyer") {
    const patch: AdminBuyerProfilePatch = {}
    const bizNo = n(form.business_reg_no)
    if (bizNo !== undefined) patch.business_reg_no = bizNo
    const website = n(form.website)
    if (website !== undefined) patch.website = website
    const tel = n(form.main_tel)
    if (tel !== undefined) patch.tel = tel
    const address1 = n(form.address)
    if (address1 !== undefined) patch.address1 = address1
    const country = n(form.country)
    if (country !== undefined) patch.country = country
    const introKo = n(form.company_intro_ko)
    if (introKo !== undefined) patch.company_intro_ko = introKo
    const introEn = n(form.company_intro_en)
    if (introEn !== undefined) patch.company_intro_en = introEn
    const contactName = n(form.contact_name)
    if (contactName !== undefined) patch.contact_name_ko = contactName
    const contactTitle = n(form.contact_title)
    if (contactTitle !== undefined) patch.contact_title_ko = contactTitle
    const contactEmail = n(form.contact_email)
    if (contactEmail !== undefined) patch.contact_email = contactEmail
    const contactLanguage = n(form.contact_language) // 자유텍스트 허용 — enum-guard 없음
    if (contactLanguage !== undefined) patch.contact_language = contactLanguage
    patch.contact_interpreter_need = form.interpreter_need

    const orgType = pick(form.org_type, ORG_TYPE_OPTIONS)
    if (orgType !== undefined) patch.org_types = [orgType]
    patch.interest_categories = form.categories // 멀티선택 — 옵션 밖 값이 애초에 나올 수 없다

    const sales = pick(form.annual_sales, ANNUAL_SALES_BUYER_OPTIONS)
    if (sales !== undefined) patch.annual_sales_range = sales
    const employeeRange = pick(form.employee_range, EMPLOYEE_RANGE_OPTIONS)
    if (employeeRange !== undefined) patch.employee_range = employeeRange
    const budget = pick(form.budget_range, BUDGET_RANGE_OPTIONS)
    if (budget !== undefined) patch.budget_range = budget
    const timeline = pick(form.adoption_timeline, ADOPTION_TIMELINE_OPTIONS)
    if (timeline !== undefined) patch.adoption_timeline = timeline

    return patch
  }

  // exhibitor
  const patch: AdminExhibitorProfilePatch = {}
  const bizNo = n(form.business_reg_no)
  if (bizNo !== undefined) patch.business_reg_no = bizNo
  const website = n(form.website)
  if (website !== undefined) patch.website = website
  const rep = n(form.representative_name)
  if (rep !== undefined) patch.representative_name_ko = rep
  const companyEmail = n(form.company_email)
  if (companyEmail !== undefined) patch.company_email = companyEmail
  const mainTel = n(form.main_tel)
  if (mainTel !== undefined) patch.main_tel = mainTel
  const addressKo = n(form.address)
  if (addressKo !== undefined) patch.address_ko = addressKo
  const introKo = n(form.company_intro_ko)
  if (introKo !== undefined) patch.intro_ko = introKo
  const introEn = n(form.company_intro_en)
  if (introEn !== undefined) patch.intro_en = introEn

  const sales = pick(form.annual_sales, ANNUAL_SALES_SELLER_OPTIONS)
  if (sales !== undefined) patch.annual_sales_range = sales
  const employeeRange = pick(form.employee_range, EMPLOYEE_RANGE_OPTIONS)
  if (employeeRange !== undefined) patch.employee_range = employeeRange
  patch.exhibition_categories = form.categories
  patch.available_languages = form.available_languages
  patch.preferred_buyer_countries = form.preferred_buyer_countries
  patch.preferred_buyer_types = form.preferred_buyer_types

  const attendees = mergeExhibitorAttendees(form)
  if (attendees !== undefined) patch.attendees = attendees
  const products = mergeExhibitorProducts(form)
  if (products !== undefined) patch.products = products

  // org_type/budget_range/adoption_timeline/contact_phone(org-level)은 exhibitor 스키마에 없다
  // (extra=forbid) — 절대 넣지 않는다. booth_label도 read-only 표시 전용이라 페이로드 밖이다.

  return patch
}

// 저장 직후 낙관적 반영용 — patch(전송 본문)가 아니라 화면이 보여줄 flat 표시 모델을 만든다.
// profileMap을 patch로 직접 오염시키면(role별로 필드가 다르다) 다음 렌더에서 다른 role 값이
// 비어보이거나 타입이 어긋난다 — 항상 AdminOrgProfile 완전한 shape로 만들어 넣는다.
export function formToDisplayProfile(
  form: ProfileFormState,
  organizationId: string,
  updatedAt: string,
): AdminOrgProfile {
  return {
    organization_id: organizationId,
    business_reg_no: n(form.business_reg_no) ?? null,
    website: n(form.website) ?? null,
    representative_name: n(form.representative_name) ?? null,
    company_email: n(form.company_email) ?? null,
    main_tel: n(form.main_tel) ?? null,
    address: n(form.address) ?? null,
    country: n(form.country) ?? null,
    org_type: n(form.org_type) ?? null,
    annual_sales: n(form.annual_sales) ?? null,
    employee_range: n(form.employee_range) ?? null,
    categories: form.categories,
    company_intro_ko: n(form.company_intro_ko) ?? null,
    company_intro_en: n(form.company_intro_en) ?? null,
    contact_name: n(form.contact_name) ?? null,
    contact_title: n(form.contact_title) ?? null,
    contact_email: n(form.contact_email) ?? null,
    contact_phone: n(form.contact_phone) ?? null,
    contact_language: n(form.contact_language) ?? null,
    interpreter_need: form.interpreter_need,
    budget_range: n(form.budget_range) ?? null,
    adoption_timeline: n(form.adoption_timeline) ?? null,
    booth_label: n(form.booth_label) ?? null,
    products: form.products,
    available_languages: form.available_languages,
    preferred_buyer_countries: form.preferred_buyer_countries,
    preferred_buyer_types: form.preferred_buyer_types,
    updated_at: updatedAt,
    exhibitor_attendees: form.exhibitorAttendees,
    exhibitor_products: form.exhibitorProducts,
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold text-muted-foreground">{children}</h4>
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

// 멀티선택(분야) — 사업분야/관심분야는 backend가 list[code]로 받는다. ⌘/Ctrl-클릭 다중선택은
// 네이티브 <select multiple>의 표준 상호작용이라 별도 설명 없이도 통한다.
function MultiSelectField({
  id,
  label,
  values,
  onChange,
  options,
  disabled,
  hint,
}: {
  id: string
  label: string
  values: string[]
  onChange: (v: string[]) => void
  options: readonly Opt[]
  disabled?: boolean
  hint?: string
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <select
        id={id}
        multiple
        value={values}
        disabled={disabled}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
        className="min-h-24 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30"
      >
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

export function ProfileEditor({
  org,
  profile,
  readOnly,
  approveImmediately,
  onSave,
}: {
  org: AdminOrganization
  profile: AdminOrgProfile | null
  readOnly: boolean
  approveImmediately: boolean
  onSave: (form: ProfileFormState, mode: "edit" | "proxy") => void
}) {
  const [form, setForm] = useState<ProfileFormState>(() => toFormState(profile))
  const [editingProduct, setEditingProduct] = useState<{
    index: number | null
    product: AdminExhibitorProductPatch
  } | null>(null)
  // ProductDialog에 DialogTrigger가 없어 닫힐 때 포커스를 여기로 명시 복원한다.
  const addProductButtonRef = useRef<HTMLButtonElement>(null)
  const isBuyer = org.role === "buyer"
  // 미신청 기업의 저장은 "대리작성"이며 운영자 권한에 맞춰 승인/제출로 전환된다.
  const mode: "edit" | "proxy" = org.application_status === "registered" ? "proxy" : "edit"

  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const openNewProduct = () =>
    setEditingProduct({
      index: null,
      product: { name_ko: "", name_en: "", business_field: null, hs_code: "", price_range: null, spec: "" },
    })

  const saveProduct = (product: AdminExhibitorProductPatch) => {
    setForm((prev) => {
      const products = [...prev.products]
      if (editingProduct?.index === null) products.push(product)
      else if (editingProduct?.index !== undefined && editingProduct.index >= 0)
        products[editingProduct.index] = product
      return { ...prev, products }
    })
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(form, mode)
      }}
    >
      {mode === "proxy" && (
        <Alert>
          <Info />
          <AlertTitle>대리작성 모드</AlertTitle>
          <AlertDescription>
            아직 비즈매칭 신청서를 내지 않은 기업입니다.{" "}
            {approveImmediately ? (
              <>저장하면 <strong>승인</strong>되어 즉시 매칭 대상에 포함됩니다.</>
            ) : (
              <>저장하면 <strong>제출됨</strong>으로 바뀌어 슈퍼관리자 승인 대기열에 포함됩니다.</>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle>기본 정보</SectionTitle>
        <div className="flex flex-wrap gap-3">
          <TextField
            id="pf-bizno"
            label="사업자등록번호"
            value={form.business_reg_no}
            onChange={(v) => set("business_reg_no", v)}
            disabled={readOnly}
          />
          <TextField
            id="pf-website"
            label="웹사이트"
            value={form.website}
            onChange={(v) => set("website", v)}
            disabled={readOnly}
          />
        </div>
        {isBuyer ? (
          <TextField
            id="pf-country"
            label="국가"
            value={form.country}
            onChange={(v) => set("country", v)}
            disabled={readOnly}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <TextField
              id="pf-rep"
              label="대표자"
              value={form.representative_name}
              onChange={(v) => set("representative_name", v)}
              disabled={readOnly}
            />
            <TextField
              id="pf-company-email"
              label="회사 이메일"
              type="email"
              value={form.company_email}
              onChange={(v) => set("company_email", v)}
              disabled={readOnly}
            />
          </div>
        )}
        <TextField
          id="pf-maintel"
          label="대표 전화"
          value={form.main_tel}
          onChange={(v) => set("main_tel", v)}
          disabled={readOnly}
        />
        <TextField
          id="pf-address"
          label="주소"
          value={form.address}
          onChange={(v) => set("address", v)}
          disabled={readOnly}
        />
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <SectionTitle>담당자</SectionTitle>
        <div className="flex flex-wrap gap-3">
          <TextField
            id="pf-contact-name"
            label="성명"
            value={form.contact_name}
            onChange={(v) => set("contact_name", v)}
            disabled={readOnly}
          />
          <TextField
            id="pf-contact-title"
            label="직위"
            value={form.contact_title}
            onChange={(v) => set("contact_title", v)}
            disabled={readOnly}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <TextField
            id="pf-contact-email"
            label="이메일"
            type="email"
            value={form.contact_email}
            onChange={(v) => set("contact_email", v)}
            disabled={readOnly}
          />
          {!isBuyer && (
            <TextField
              id="pf-contact-phone"
              label="전화"
              value={form.contact_phone}
              onChange={(v) => set("contact_phone", v)}
              disabled={readOnly}
            />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {isBuyer ? (
            <TextField
              id="pf-contact-lang"
              label="상담 언어"
              value={form.contact_language}
              onChange={(v) => set("contact_language", v)}
              disabled={readOnly}
            />
          ) : (
            <SelectField
              id="pf-contact-lang"
              label="상담 언어"
              value={form.contact_language}
              onChange={(v) => set("contact_language", v)}
              options={EXHIBITOR_CONTACT_LANG_OPTIONS}
              disabled={readOnly}
            />
          )}
          {isBuyer && (
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.interpreter_need}
                disabled={readOnly}
                onChange={(e) => set("interpreter_need", e.target.checked)}
              />
              통역 필요
            </label>
          )}
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <SectionTitle>기관 규모·분야</SectionTitle>
        <div className="flex flex-wrap gap-3">
          {isBuyer && (
            <SelectField
              id="pf-orgtype"
              label="참가자 구분"
              value={form.org_type}
              onChange={(v) => set("org_type", v)}
              options={ORG_TYPE_OPTIONS}
              disabled={readOnly}
            />
          )}
          <SelectField
            id="pf-sales"
            label="연매출"
            value={form.annual_sales}
            onChange={(v) => set("annual_sales", v)}
            options={isBuyer ? ANNUAL_SALES_BUYER_OPTIONS : ANNUAL_SALES_SELLER_OPTIONS}
            disabled={readOnly}
          />
          <SelectField
            id="pf-employees"
            label="직원수"
            value={form.employee_range}
            onChange={(v) => set("employee_range", v)}
            options={EMPLOYEE_RANGE_OPTIONS}
            disabled={readOnly}
          />
        </div>
        <MultiSelectField
          id="pf-categories"
          label={isBuyer ? "관심 분야" : "사업분야"}
          values={form.categories}
          onChange={(v) => set("categories", v)}
          options={BUSINESS_FIELD_OPTIONS}
          hint="Ctrl(⌘)+클릭으로 여러 개 선택"
          disabled={readOnly}
        />
        <Field id="pf-intro-ko" label="회사소개(국문)">
          <Textarea
            id="pf-intro-ko"
            rows={3}
            value={form.company_intro_ko}
            disabled={readOnly}
            onChange={(e) => set("company_intro_ko", e.target.value)}
          />
        </Field>
        <Field id="pf-intro-en" label="회사소개(영문)">
          <Textarea
            id="pf-intro-en"
            rows={3}
            value={form.company_intro_en}
            disabled={readOnly}
            onChange={(e) => set("company_intro_en", e.target.value)}
          />
        </Field>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <SectionTitle>{isBuyer ? "구매 계획" : "전시 운영"}</SectionTitle>
        {isBuyer ? (
          <div className="flex flex-wrap gap-3">
            <SelectField
              id="pf-budget"
              label="지출 예산"
              value={form.budget_range}
              onChange={(v) => set("budget_range", v)}
              options={BUDGET_RANGE_OPTIONS}
              disabled={readOnly}
            />
            <SelectField
              id="pf-timeline"
              label="도입 시기"
              value={form.adoption_timeline}
              onChange={(v) => set("adoption_timeline", v)}
              options={ADOPTION_TIMELINE_OPTIONS}
              disabled={readOnly}
            />
          </div>
        ) : (
          <>
            <TextField
              id="pf-booth"
              label="부스"
              value={form.booth_label}
              onChange={() => {}}
              hint="회원가입 등록값 — 이 화면에서 수정되지 않습니다"
              disabled
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <SectionTitle>전시 제품</SectionTitle>
                {!readOnly && (
                  <Button
                    ref={addProductButtonRef}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={openNewProduct}
                  >
                    <Plus className="size-4" /> 제품 추가
                  </Button>
                )}
              </div>
              {form.products.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  등록된 전시 제품이 없습니다.
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
                        <span className="block truncate text-sm font-medium">{product.name_ko}</span>
                        {product.name_en && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {product.name_en}
                          </span>
                        )}
                      </button>
                      {!readOnly && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${product.name_ko} 삭제`}
                          onClick={() => set("products", form.products.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background py-3">
          <Button type="submit">
            {mode === "proxy"
              ? approveImmediately
                ? "대리작성 후 승인"
                : "대리작성 후 제출"
              : "신청서 저장"}
          </Button>
        </div>
      )}
      <ProductDialog
        open={editingProduct !== null}
        product={editingProduct?.product ?? null}
        readOnly={readOnly}
        onOpenChange={(open) => {
          if (!open) setEditingProduct(null)
        }}
        onSave={saveProduct}
        returnFocusRef={addProductButtonRef}
      />
    </form>
  )
}

// 연매출은 role별로 코드 집합이 다르다(buyer=USD, exhibitor=KRW, schemas.py AnnualSalesBuyer vs
// AnnualSalesSeller) — 이 요약은 role을 받지 않으므로(org 객체 없이 profile만 옴) 두 맵을 합쳐서
// 조회한다. 코드가 겹치지 않아(usd_* vs krw_*) 안전하다.
const ANNUAL_SALES_LABELS: Record<string, string> = {
  ...ANNUAL_SALES_SELLER_LABELS,
  ...ANNUAL_SALES_BUYER_LABELS,
}

// 읽기 전용 요약(서브어드민 등) — 편집 폼 대신 값만 나열한다.
export function ProfileSummary({ profile }: { profile: AdminOrgProfile | null }) {
  if (!profile) {
    return <p className="text-sm text-muted-foreground">등록된 신청서 내용이 없습니다.</p>
  }
  // 참가자구분·연매출·직원수·분야는 코드로 저장된다 — 화면은 라벨로 보여준다(labelFor/labelsFor는
  // 맵에 없는 코드를 원문 그대로 돌려주므로 데이터 유실이 없다).
  const rows: [string, string | null][] = [
    ["사업자등록번호", profile.business_reg_no],
    ["웹사이트", profile.website],
    ["국가", profile.country],
    ["참가자 구분", labelFor(ORG_TYPE_LABELS, profile.org_type) ?? null],
    ["연매출", labelFor(ANNUAL_SALES_LABELS, profile.annual_sales) ?? null],
    ["직원수", labelFor(EMPLOYEE_RANGE_LABELS, profile.employee_range) ?? null],
    ["분야", labelsFor(BUSINESS_FIELD_LABELS, profile.categories).join(", ") || null],
    ["담당자", profile.contact_name],
    ["이메일", profile.contact_email],
    ["회사소개", profile.company_intro_ko],
  ]
  return (
    <div className="flex flex-col gap-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3 text-sm">
          <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 break-words">{value || "-"}</span>
        </div>
      ))}
    </div>
  )
}
