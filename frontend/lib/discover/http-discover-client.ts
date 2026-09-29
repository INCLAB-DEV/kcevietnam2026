import "server-only"

import { redirect } from "next/navigation"

// 기업 탐색(F-DV-001)의 **실연동 구현** — FastAPI /api/discover/* 를 서버에서 직접 호출한다.
// (mock 구현은 lib/mock-orgs.ts. 스왑 조건·읽기 어댑터는 lib/api-client/server.ts의
// getOrganizations/getOrganization/getViewerOrg 참고 — admin/http-client.ts·미팅 실연동과 같은
// 패턴: 인증 헤더는 로그인 BFF가 심은 httpOnly 세션 쿠키를 서버에서 읽어 붙인다. event는 principal에서
// 백엔드가 자동 해석한다(미팅과 동일).)
//
// ⚠ 매핑 규약(admin/http-client.ts와 동일 원칙): 백엔드 응답에 없는 필드(strength·achievements·
//   founded·budgetRange·adoptionTimeline)는 undefined로 정직하게 비운다 — 화면은 optional 필드를
//   견디게 돼 있다. 백엔드가 필드를 추가하면 여기서 매핑만 늘린다(호출처 불변).

import { cookies } from "next/headers"
import { getLocale } from "next-intl/server"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { EMPLOYEE_RANGE_LABELS, labelFor } from "@/lib/bm/fields"
import type { BuyerType, Organization, OrgRole } from "@/lib/types"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// locale(ko|en)은 값 선택지다(권한 아님) — en이면 백엔드가 기업명·소개·키워드·전시품을 영문으로 내려준다
// (docs: app/discover/router.py). 현재 요청 locale(NEXT_LOCALE 쿠키, next-intl)을 그대로 실어 보낸다.
async function discoverFetch<T>(path: string): Promise<{ status: number; data: T | null }> {
  const [jar, locale] = await Promise.all([cookies(), getLocale()])
  const token = jar.get(SESSION_COOKIE)?.value
  const separator = path.includes("?") ? "&" : "?"
  const res = await fetch(`${BACKEND_URL}/api/discover${path}${separator}locale=${locale}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  })
  if (res.status === 403 || res.status === 404) return { status: res.status, data: null }
  // 401(세션 만료)은 500이 아니라 재인증으로 — meetings/organizer read 클라이언트와 동일 원칙.
  if (res.status === 401) redirect("/login")
  if (!res.ok) {
    throw new Error(`discover read failed: GET ${path} (${res.status})`)
  }
  return { status: res.status, data: (await res.json()) as T }
}

// ── 백엔드 응답 형상(snake_case) ──────────────────────────────────────────────
interface BoothOutSnake {
  hall_no: string
  hall_name: string
  code: string
}

interface DiscoverOrgOutSnake {
  org_id: string
  role: OrgRole
  name: string
  buyer_subtype: BuyerType | null
  booth: BoothOutSnake | null
  keywords: string[]
  exhibits: string[]
  description: string | null
  employee_range: string | null
  // 카테고리(content_category, 3종·셀러 전용·단일선택) — Hall 필터를 대체하는 회사 분류축.
  // 바이어 카드에서는 항상 null.
  content_category: string | null
}

interface DiscoverOrgListResponseSnake {
  items: DiscoverOrgOutSnake[]
  total: number
}

// DiscoverOrgOut(snake) → Organization(camel, frontend/lib/types.ts). "있는 것만 매핑" 원칙 —
// strength·achievements·founded·budgetRange·adoptionTimeline은 백엔드 계약에 없어 undefined.
// employee_range는 원시 코드(예: "e_51_100")로 온다 — labelFor로 표시용 라벨("51~100명")로
// 변환한다(맵에 없는 값은 원문 유지, 데이터 유실 방지).
export function toOrganization(o: DiscoverOrgOutSnake): Organization {
  return {
    id: o.org_id,
    name: o.name,
    role: o.role,
    keywords: o.keywords,
    booth: o.booth
      ? { hallNo: o.booth.hall_no, hallName: o.booth.hall_name, code: o.booth.code }
      : undefined,
    exhibits: o.exhibits,
    buyerType: o.buyer_subtype ?? undefined,
    description: o.description ?? undefined,
    employees: labelFor(EMPLOYEE_RANGE_LABELS, o.employee_range),
    contentCategory: o.content_category ?? undefined,
  }
}

// GET /api/discover/organizations — event_id는 principal에서 백엔드가 자동 해석(미팅과 동일).
// 가시성(방향별 노출)은 백엔드가 이미 적용해 내려준다 — lib/discover/visibility.ts의 FE 재적용은
// 무해한 이중 필터라 그대로 유지한다(server.ts 참고).
export async function fetchDiscoverOrganizations(): Promise<Organization[]> {
  const { data } = await discoverFetch<DiscoverOrgListResponseSnake>("/organizations?limit=200")
  return (data?.items ?? []).map(toOrganization)
}

// GET /api/discover/organizations/{org_id} — 자기 org 포함 단건 조회. 403 NOT_VISIBLE·404 부재는
// 둘 다 "찾을 수 없음"으로 뭉갠다(getOrganization 계약: 없으면 null) — 존재 여부를 굳이 구분해
// 노출하지 않는다(가시성 정책과 동일 취지).
export async function fetchDiscoverOrganization(orgId: string): Promise<Organization | null> {
  const { data } = await discoverFetch<DiscoverOrgOutSnake>(`/organizations/${encodeURIComponent(orgId)}`)
  return data ? toOrganization(data) : null
}

// 뷰어(내 org) 단건 조회 — org 쿠키(로그인 BFF가 /api/me로 심은 nabi_session_org, P1-1)로 자기
// 자신을 조회한다. 세션이 없거나 쿠키가 비어 있으면(예: /api/me 부트스트랩 실패) 호출부(seam)에
// 던져 올린다 — getViewerOrg의 계약은 Organization(non-null)이라 조용히 fallback할 안전한 기본값이
// 없다(어떤 mock org를 대신 보여줘도 거짓 정보다).
export async function fetchViewerOrganization(): Promise<Organization> {
  const session = await resolveHttpSession()
  if (!session?.orgId) {
    throw new Error("fetchViewerOrganization: no org id in session (login /api/me bootstrap missing)")
  }
  const org = await fetchDiscoverOrganization(session.orgId)
  if (!org) {
    throw new Error(`fetchViewerOrganization: viewer org not found (${session.orgId})`)
  }
  return org
}
