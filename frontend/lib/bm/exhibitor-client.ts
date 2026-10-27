// 참가사 프로필 클라이언트 선택 — realSession(실 로그인 세션)이면 실 백엔드(FastAPI, BFF 경유),
// 아니면 인메모리 mock. mock 모드 보존 원칙(#P1): 호출부가 세션을 모르고 부르면(기본값) 항상
// mock — 신청 폼(apply-form.tsx·application-actions.tsx)처럼 아직 실연동 대상이 아닌 화면은
// 인자 없이 불러 기존 mock 동작을 그대로 유지한다. 실세션 판정은 서버 컴포넌트(page.tsx)가
// fetchMe()/resolveHttpSession()으로 내려 클라 컴포넌트에 prop으로 전달한다(예: exhibitor-profile-hub).
// orgEventRoleId 는 경로 파라미터(/api/bm/exhibitor/{id})로 쓰인다.
// review 의 getReviewClient 와 같은 seam 패턴(ADR-0008, 단일 교체점).

import type { ExhibitorProfileClient } from "./types"
import { mockExhibitorClient } from "./mock-exhibitor-client"
import { createHttpExhibitorClient } from "./http-exhibitor-client"

export function getExhibitorClient(realSession = false): ExhibitorProfileClient {
  return realSession ? createHttpExhibitorClient() : mockExhibitorClient
}
