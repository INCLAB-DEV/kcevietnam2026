// 실 로그인 세션(로그인 BFF가 심은 쿠키 3종)을 route-guard용 Session으로 판정하는 순수 함수(P1-4).
// proxy.ts(엣지 미들웨어)가 request.cookies에서 값만 뽑아 넘긴다 — next/headers 의존이 없어(엣지
// 런타임 밖에서도) 테스트하기 쉽다. resolveRouteAccess(route-guard.ts) 자체는 건드리지 않는다.

import type { Session } from "./route-guard"
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/application-status"

function isApplicationStatus(value: string | null | undefined): value is ApplicationStatus {
  return !!value && (APPLICATION_STATUSES as readonly string[]).includes(value)
}

export interface RealSessionCookies {
  session: string | null | undefined // nabi_session (SESSION_COOKIE) — 값 자체는 신뢰, 존재만 확인
  role: string | null | undefined // nabi_session_role (ROLE_COOKIE)
  status: string | null | undefined // nabi_session_status (STATUS_COOKIE)
}

// role이 buyer/exhibitor/organizer 중 하나가 아니거나 세션 토큰이 없으면 실 세션 아님(null) —
// 호출부가 dev 스위처나 미인증으로 폴백한다. status가 유효한 ApplicationStatus가 아니면(예:
// /api/me 부트스트랩 실패로 쿠키가 아예 없음) applicationStatus는 undefined — route-guard가
// 안전하게 미승인으로 취급한다.
//
// organizer는 applicationStatus 개념이 없다(신청 심사 대상이 아니다) — status는 그대로 흘려도
// route-guard의 /organizer·/admin 정책이 gate:"none"이라 쓰이지 않는다(route-guard.ts 118행).
// 보안 참고: organizer 프로덕션 실인증(D5)은 미구현 — 이 role은 현재 데모 로그인 경로에서만
// 나온다(session-cookie.ts의 extractRole 참고, prod 구멍 아님).
export function resolveRealSession({ session, role, status }: RealSessionCookies): Session | null {
  if (!session) return null
  if (role !== "buyer" && role !== "exhibitor" && role !== "organizer") return null
  return {
    authenticated: true,
    role,
    applicationStatus: isApplicationStatus(status) ? status : undefined,
  }
}
