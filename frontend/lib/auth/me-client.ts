// GET /api/me 서버 전용 조회 헬퍼 — "지금 로그인한 사람"의 단일 진실원천.
//
// 사이드바 신원, 프로필 허브의 org_event_role_id 해석, 인박스 등 여러 서버 컴포넌트가
// 같은 요청 안에서 중복 호출해도 React cache()로 1회만 나간다. 실세션 쿠키가 없거나
// 백엔드가 죽어 있으면 조용히 null — 호출부는 mock 신원으로 폴백한다(mock 모드 보존).
//
// 백엔드 확장 필드(member_* 등)는 롤아웃 순서와 무관하게 안전하도록 전부 optional로 받는다.

import "server-only"

import { cache } from "react"
import { cookies } from "next/headers"

import { SESSION_COOKIE } from "@/lib/auth/session-cookie"

export interface MeRole {
  event_id: string
  org_event_role_id: string
  is_exhibitor: boolean
  is_buyer: boolean
  buyer_subtype: string | null
  application_status: string
  // 전시(미팅 진행) 기간 YYYY-MM-DD — 미팅 타임라인 날짜 탭의 원천(lib/meeting/event-dates.ts).
  // 백엔드 롤아웃 중이거나 행사에 기간이 안 잡혔으면 없을 수 있어 옵셔널이다.
  exhibition_start?: string | null
  exhibition_end?: string | null
  // 격자 모양(칸 길이·칸 사이 텀, 분) — 미팅 타임라인이 행을 이 값으로 끊는다(mt003gap0001).
  // 없으면 timeline.ts 가 30분/텀0 으로 폴백하는데, 그건 40분/텀5분 행사에서 10:45 미팅을
  // 10:30 행에 그리는 조용한 오류다. 위 필드들과 같은 이유로 옵셔널(백엔드 롤아웃 순서 무관).
  slot_minutes?: number | null
  slot_gap_minutes?: number | null
}

export interface MeResponse {
  organization_id: string
  organization_name: string
  organization_name_en?: string | null
  member_name?: string | null
  member_email?: string | null
  member_phone?: string | null
  member_title?: string | null
  roles: MeRole[]
}

export const fetchMe = cache(async (): Promise<MeResponse | null> => {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const base = process.env.NABI_BACKEND_URL
  if (!token || !base) return null
  try {
    const res = await fetch(`${base}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as MeResponse
  } catch {
    return null
  }
})
