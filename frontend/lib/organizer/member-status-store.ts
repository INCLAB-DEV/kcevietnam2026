// OP-003 — 참가기업 신청 상태 결정(승인/반려/수정요청)의 서버 측 목업 영속.
// React 무의존 순수 모듈. PATCH /api/organizer/members/{id}/status가 쓰고,
// serverApiClient.getMembers/getMember가 mock 픽스처 위에 덮어써 새로고침 후에도 유지된다.
// 실연동 시 FastAPI가 대체(상태 전이의 권위는 backend, ADR-0012).

import type { ApplicationStatus } from "@/lib/application-status"

// memberId → 결정된 상태. 프로세스 생존 동안 유지(dev 서버 메모리).
let overrides: Record<string, ApplicationStatus> = {}

export function getStatusOverride(memberId: string): ApplicationStatus | undefined {
  return overrides[memberId]
}

export function setStatusOverride(memberId: string, status: ApplicationStatus): void {
  overrides[memberId] = status
}

export function listStatusOverrides(): Record<string, ApplicationStatus> {
  return { ...overrides }
}

// 테스트 전용 초기화.
export function __resetStatusOverridesForTest(): void {
  overrides = {}
}
