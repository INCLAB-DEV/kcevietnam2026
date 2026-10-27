// OP-002 미신청(registered) 행의 간이 대리작성 다이얼로그(MembersTable.proxyWriteMember) → 대리작성
// 본문(POST .../proxy-profile) 변환.
//
// ⚠ 쓰임은 **미신청 행의 대리작성 하나**다. 신청서가 있는 행(제출·보완요청·승인·반려)의 수정은 두
// 콘솔이 함께 쓰는 신청서 편집 패널(components/operator/application-panel — 참가자 신청서의 모든 항목,
// 참가자 클라이언트의 본문 변환 그대로)이 맡는다. 예전엔 이 축소 매핑이 그 수정까지 맡아, 화면에는 입력
// 칸이 있는데 저장되지 않는 필드가 여럿이었다(기업명·사업분야·HS코드·KST·부스·바이어유형·체류·담당자 전화).
//
// 그래서 여기 있는 칸 = 그 다이얼로그에 보이는 칸 전부다(1:1). 다이얼로그에 칸을 더하려면 먼저 여기에
// 대응 필드를 더한다 — 대응하는 신청서 필드가 없으면 칸을 만들지 않는다.
//   · 코드 검증이 필요한 값(사업분야·언어 등)은 자유 텍스트로 받지 않는다(backend Literal 밖 값은 422,
//     라벨 문자열을 코드 칸에 쓰면 값이 망가진다) — 그런 항목은 대리작성 뒤 패널에서 선택지로 고른다.
//   · 참가사 담당자(attendees)는 전체교체 배열이라 이 경로에서 손대지 않는다.
//
// 미신청은 참가자가 신청서를 **작성하는 중**일 수 있는 상태다. 그래서 값의 기준은 명단(목록 화면)이 아니라
// 서버의 현재 프로필이다:
//   1. 다이얼로그를 열 때 서버 프로필을 읽는다(organizerProxyServerValues). **폼 초깃값은 그 서버 값뿐이다** —
//      서버에 없는 칸은 빈 칸으로 보인다. 명단 행의 값으로 채우지 않는다: 명단 값은 같은 컬럼에서 온 것이
//      아니다(예: row.contactEmail은 백엔드 resolve_primary_contact의 "회사 이메일 or 바이어 신청자 이메일
//      or 담당자 이메일 or 회원 이메일" 파생값이라, 회사 이메일이 비어 있으면 담당자 개인 이메일이
//      company_email로 저장된다. 바이어 담당자 성명·기업명도 표시용 대체값이 섞인다).
//   2. 저장할 때는 **열 때 읽은 서버 값과 달라진 칸만** 보낸다(toOrganizerProfilePatch) — 곧 운영자가
//      입력하거나 고친 칸만이다. 아무것도 안 고치면 본문이 비고 상태만 전이한다.
//      (예전엔 폼에 값이 있으면 전부 보내, 운영자가 아무것도 안 고쳐도 참가자의 초안을 명단 값으로 덮었다.)
//   3. 저장 직전에 한 번 더 읽어, 보내려는 칸이 그 사이 서버에서 달라졌으면(비워진 것 포함) 보내지 않는다
//      (organizerProxyConflicts — 클라이언트 쪽 검사, lib/operator/application-client "동시 수정 검사").
//   · 빈 칸은 "안 건드림"이다(키를 뺀다) — 대리작성은 채워 넣는 화면이고, 값을 지우는 것은 패널의 몫이다.
//     카테고리만 예외다: 선택 칸에 "미입력" 보기가 있어, 그리로 바꾸면 지운다(null).
import type { OperatorOrgDetailApi } from "@/lib/operator/application-client"

import type { MemberTab } from "./members"

export const ORGANIZER_PROXY_KEYS = [
  "name", // 기업명(국문)
  "nameEn", // 기업명(영문)
  "businessRegNo",
  "website",
  "primaryContact", // 바이어 전용 — 신청자 성명(contact_name_ko)
  "contactEmail", // 참가사 = 회사 이메일, 바이어 = 신청자 이메일
  "mainTel", // 참가사 = 대표 전화, 바이어 = 기관 전화
  "address",
  "contentCategory", // 참가사 전용(카테고리 3종 코드 — <select>)
] as const
export type OrganizerProxyKey = (typeof ORGANIZER_PROXY_KEYS)[number]

// 폼 칸 값 — 전부 문자열("" = 비어 있음). 서버 값도 같은 모양으로 견준다.
export type OrganizerProxyValues = Record<OrganizerProxyKey, string>

// 칸 → 대리작성 본문 키. 프로필 응답도 같은 이름의 필드를 쓴다(같은 스키마 계열)라 읽기·쓰기가 한 표다.
// 역할에 없는 칸(참가사의 담당자, 바이어의 카테고리)은 대응이 없다 — 폼에도 보이지 않는다.
const BODY_KEY: Record<MemberTab, Partial<Record<OrganizerProxyKey, string>>> = {
  exhibitor: {
    name: "organization_name_ko",
    nameEn: "organization_name_en",
    businessRegNo: "business_reg_no",
    website: "website",
    contactEmail: "company_email",
    mainTel: "main_tel",
    address: "address_ko",
    contentCategory: "content_category",
  },
  buyer: {
    name: "organization_name_ko",
    nameEn: "organization_name_en",
    businessRegNo: "business_reg_no",
    website: "website",
    primaryContact: "contact_name_ko",
    contactEmail: "contact_email",
    mainTel: "tel",
    address: "address1",
  },
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : value == null ? "" : `${value}`.trim()

function blankValues(): OrganizerProxyValues {
  return Object.fromEntries(ORGANIZER_PROXY_KEYS.map((key) => [key, ""])) as OrganizerProxyValues
}

// 이 역할의 폼에 실제로 있는 칸인가(대응하는 신청서 필드가 있는가).
export function hasOrganizerProxyField(tab: MemberTab, key: OrganizerProxyKey): boolean {
  return BODY_KEY[tab][key] !== undefined
}

// 서버의 현재 프로필(운영자 상세) → 폼 칸 값. 이 역할에 없는 칸은 ""이다.
export function organizerProxyServerValues(
  detail: Pick<OperatorOrgDetailApi, "buyer_profile" | "exhibitor_profile">,
  tab: MemberTab,
): OrganizerProxyValues {
  const profile = (tab === "exhibitor" ? detail.exhibitor_profile : detail.buyer_profile) as
    | Record<string, unknown>
    | null
    | undefined
  const values = blankValues()
  for (const key of ORGANIZER_PROXY_KEYS) {
    const body = BODY_KEY[tab][key]
    if (body) values[key] = text(profile?.[body])
  }
  return values
}

// 이 기업에 이름이 하나라도 남는가 — 서버의 기업명(국문·영문)이 둘 다 비어 있고 폼에도 입력이 없으면
// false다. 대리작성은 저장과 함께 상태가 전이하므로(master면 즉시 승인 → 매칭 대상), 이름 없는 기업이
// 승인되지 않게 저장 전에 막는 데 쓴다. 폼의 빈 칸은 "안 건드림"이라 서버 값이 그대로 남는다.
export function organizerProxyHasName(
  form: OrganizerProxyValues,
  server: OrganizerProxyValues,
): boolean {
  return [form.name, form.nameEn, server.name, server.nameEn].some((value) => text(value) !== "")
}

// 폼 값 → 대리작성 본문. **열 때 읽은 서버 값(server)과 달라진 칸만** 담는다 — 아무것도 안 달라졌으면
// 빈 본문이다(대리작성의 본체는 상태 전이라 빈 본문도 유효하다: 서버에 있던 값은 그대로 남는다).
export function toOrganizerProfilePatch(
  form: OrganizerProxyValues,
  server: OrganizerProxyValues,
  tab: MemberTab,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of ORGANIZER_PROXY_KEYS) {
    const body = BODY_KEY[tab][key]
    if (!body) continue
    const value = text(form[key])
    if (value === server[key]) continue
    if (key === "contentCategory") {
      patch[body] = value || null // "미입력"으로 바꿨다 = 지운다
    } else if (value !== "") {
      patch[body] = value // 빈 칸은 안 건드림
    }
  }
  return patch
}

// 충돌 — 보내려는 칸(patch) 가운데, 다이얼로그를 연 뒤(server) 서버에서 달라진(latest) 칸.
// 하나라도 있으면 보내지 않는다: 운영자의 값은 옛 서버 값을 보고 정한 것이다. 값의 뜻으로 견준다 —
// 서버에서 **비워진** 칸(값 → "")도 달라진 것이다(본문 조립의 "빈 칸은 안 건드림"과 별개 규칙이다.
// 그렇게 보지 않으면 참가자가 지운 값을 운영자의 저장이 되살린다).
export function organizerProxyConflicts(
  patch: Record<string, unknown>,
  server: OrganizerProxyValues,
  latest: OrganizerProxyValues,
  tab: MemberTab,
): OrganizerProxyKey[] {
  return ORGANIZER_PROXY_KEYS.filter((key) => {
    const body = BODY_KEY[tab][key]
    return body !== undefined && body in patch && latest[key] !== server[key]
  })
}
