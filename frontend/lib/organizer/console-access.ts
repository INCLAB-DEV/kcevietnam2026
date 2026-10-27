import "server-only"

// 행사 운영 콘솔(/organizer/*)의 권한등급 해석 — 레이아웃(nav)·페이지(데이터·액션 노출)가 **같은 판정**을
// 공유하는 단일 진입점. 같은 요청 안에서 여러 번 불려도 React cache()로 1회만 계산한다.
//
// 왜 한 곳으로 모으나(2026-09-17 서브 운영자 오류 화면 결함):
//  ① 등급의 행사 기준이 갈라져 있었다 — 콘솔 데이터는 GET /api/admin/events의 **첫 행사**(최신 생성순,
//     backend-proxy resolveEventContext)를 쓰는데, 등급은 /api/admin/me의 **첫 배정**(가장 오래된 배정)
//     으로 읽었다. 이제 등급도 데이터와 같은 행사 id로 읽는다(ADR-0012: 등급은 계정×행사).
//  ② 조회 실패를 master로 취급했다 — 명단 화면이 /me 실패 시 master UI를 그렸다. 실세션에서 등급을
//     모르면 **최소 권한(sub)** 으로 둔다. 쓰기의 권위는 여전히 백엔드 가드지만, 화면이 master 전용
//     메뉴(배정·관리자 콘솔)로 sub를 이끌어 403 오류 화면을 만드는 일을 막는다.

import { cache } from "react"

import { operatorPermissionLevel, type OperatorMe } from "@/lib/auth/operator-identity"
import { fetchOperatorMe, hasOperatorSession } from "@/lib/auth/operator-me-client"
import { devSessionOverrideActive, resolveOrganizerRequestSession } from "@/lib/mock/session-server"
import type { MockSession, PermissionLevel } from "@/lib/mock/session"
import { resolveEventId } from "./backend-proxy"
import { resolveOrganizerToken } from "./http-members-client"

export interface OrganizerConsoleAccess {
  // 실 운영자 세션(백엔드 신원) 여부 — false면 dev 목업 세션(?as=organizer / organizer-sub).
  realSession: boolean
  permissionLevel: PermissionLevel
  // true면 permissionLevel="sub"는 "확인된 sub"가 아니라 **조회 실패로 인한 최소 권한 폴백**이다
  // (/api/admin/me 403·NABI_BACKEND_URL 미설정·GET /api/admin/events 실패 등, 2026-09-21 결함).
  // 화면은 이걸로 sub 취급은 그대로 하되(데이터·쓰기 노출은 최소 권한 유지) 배너로 알려야 한다 —
  // 예전엔 이 구분이 없어 실 슈퍼관리자가 이유도 모른 채 승인 버튼이 사라진 화면을 봤다.
  permissionUnknown: boolean
  // 목업 세션(셸 사이드바 신원·목업 sub 관할 필터용). 실세션에서도 role=organizer 고정 셸 입력으로 쓴다.
  session: MockSession
}

export interface OrganizerPermissionInput {
  realSession: boolean
  me: OperatorMe | null
  // 콘솔 데이터가 보는 행사(첫 행사). 못 구했으면 null — 등급도 모르는 것으로 본다.
  eventId: string | null
  // 목업 세션의 등급(dev 스위처). 목업 organizer 기본은 master(기존 dev 동작 보존).
  mockLevel?: PermissionLevel
}

// 순수 판정 — 실세션은 "그 행사에서의 등급", 모르면 sub(최소 권한). 목업은 스위처 값 그대로.
export function resolveOrganizerPermission(input: OrganizerPermissionInput): PermissionLevel {
  if (!input.realSession) return input.mockLevel ?? "master"
  if (!input.eventId) return "sub"
  return operatorPermissionLevel(input.me, input.eventId) ?? "sub"
}

// resolveOrganizerPermission과 같은 갈림길을 판정하되, "sub로 떨어진 이유"만 가른다 — 목업은
// 항상 확인된 값(false), 실세션은 행사를 모르거나 그 행사 배정을 못 찾았을 때만 true.
export function isOrganizerPermissionUnknown(input: OrganizerPermissionInput): boolean {
  if (!input.realSession) return false
  if (!input.eventId) return true
  return operatorPermissionLevel(input.me, input.eventId) === undefined
}

// 콘솔 행사 id — 데이터 읽기 어댑터(http-members-client·http-ops-metrics-client 등)와 같은 resolveEventId.
// 실패(백엔드 미가동·행사 없음)는 던지지 않고 null — 레이아웃에서 불리므로 여기서 무너지면 error.tsx도
// 못 잡는다(레이아웃 에러는 같은 세그먼트의 error.tsx 바깥이다).
async function resolveConsoleEventId(): Promise<string | null> {
  const token = await resolveOrganizerToken()
  if (!token) return null
  try {
    const result = await resolveEventId(token)
    return result.ok ? result.value : null
  } catch {
    return null
  }
}

export const resolveOrganizerConsoleAccess = cache(async (): Promise<OrganizerConsoleAccess> => {
  const session = await resolveOrganizerRequestSession()
  // dev 스위처가 명시적으로 켜져 있으면 목업이 이긴다(proxy.ts·admin-shell과 같은 우선순위) — prod에선 항상 실세션만.
  const realSession = !(await devSessionOverrideActive()) && (await hasOperatorSession())
  if (!realSession) {
    return {
      realSession,
      session,
      permissionLevel: resolveOrganizerPermission({
        realSession,
        me: null,
        eventId: null,
        mockLevel: session.permissionLevel,
      }),
      permissionUnknown: false,
    }
  }
  const [me, eventId] = await Promise.all([fetchOperatorMe(), resolveConsoleEventId()])
  const permissionInput = { realSession, me, eventId }
  return {
    realSession,
    session,
    permissionLevel: resolveOrganizerPermission(permissionInput),
    permissionUnknown: isOrganizerPermissionUnknown(permissionInput),
  }
})
