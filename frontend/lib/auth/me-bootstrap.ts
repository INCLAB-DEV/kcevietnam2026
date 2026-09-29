// 로그인 성공 직후 FastAPI GET /api/me를 호출해 org·신청상태 쿠키를 마저 심는 공용 헬퍼(P1-1).
// 로그인은 2단계 트랜잭션(ADR-0011)이라 "성공"이 **두 라우트 모두**에서 날 수 있다 —
// app/api/auth/login/start/route.ts(재방문자: succeeded 직결) ·
// app/api/auth/login/complete/route.ts(최초 진입자: 약관 동의 후 succeeded). 두 곳 다 이 헬퍼를
// 불러써야 org/status 쿠키가 실제로 심긴다(한쪽만 부르면 그 경로로 들어온 로그인은 원본 세션과
// 목·상태 쿠키가 없다).
//
// /api/me가 실패해도(엔드포인트 미가동·네트워크 장애) 로그인 자체는 그대로 성공시키고, 신청상태는
// 로그인 응답 자체의 gate.application_status로 폴백한다(부트스트랩 실패가 로그인을 막으면 안 된다).

import type { NextResponse } from "next/server"
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"
import { ORG_COOKIE, STATUS_COOKIE, sessionCookieOptions } from "@/lib/auth/session-cookie"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && (APPLICATION_STATUSES as readonly string[]).includes(value)
}

// GET /api/me 응답(계약) — event role이 여럿이면 데모는 항상 단일 event라 첫 번째만 쓴다.
interface MeRoleSnake {
  application_status?: unknown
}
interface MeSnake {
  organization_id?: unknown
  roles?: MeRoleSnake[]
}

// /api/me로 org·신청상태 쿠키를 심는다. 실패하면 org는 비워두고(호출부가 mock orgId로 폴백)
// status만 로그인 응답의 gate로 폴백한다.
export async function bootstrapMeCookies(
  response: NextResponse,
  token: string,
  fallbackStatus: unknown,
): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (res.ok) {
      const me = (await res.json()) as MeSnake
      const status = me.roles?.[0]?.application_status
      if (typeof me.organization_id === "string") {
        response.cookies.set(ORG_COOKIE, me.organization_id, sessionCookieOptions)
      }
      if (isApplicationStatus(status)) {
        response.cookies.set(STATUS_COOKIE, status, sessionCookieOptions)
        return
      }
    }
  } catch {
    // 네트워크 실패 등 — 아래 폴백으로 진행(로그인 자체는 막지 않는다).
  }
  if (isApplicationStatus(fallbackStatus)) {
    response.cookies.set(STATUS_COOKIE, fallbackStatus, sessionCookieOptions)
  }
}
