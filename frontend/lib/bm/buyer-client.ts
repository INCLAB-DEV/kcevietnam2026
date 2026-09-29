// 바이어 프로필 클라이언트 선택 — realSession(실 로그인 세션)이면 실 백엔드(FastAPI, BFF 경유),
// 아니면 인메모리 mock. lib/bm/exhibitor-client.ts와 동일 seam 패턴(ADR-0008, 단일 교체점).
// ⚠ apply-form.tsx의 mock 분기(비실세션)는 이 mock 클라이언트가 아니라 여전히
// lib/apply/buyer-profile-store.ts(localStorage, 이어쓰기 보존)를 직접 쓴다 — "mock 모드는 기존
// 인메모리 동작 100% 보존" 원칙. 이 팩토리는 실세션 경로(getBuyerClient(true))의 단일 진입점이자,
// mock 분기를 포함한 완전한 계약(getExhibitorClient 대칭)을 다른 호출부에도 제공한다.
// orgEventRoleId는 경로 파라미터(/api/bm/buyer/{id})로 쓰인다.

import type { BuyerProfileClient } from "@/lib/apply/types"
import { mockBuyerClient } from "./mock-buyer-client"
import { createHttpBuyerClient } from "./http-buyer-client"

export function getBuyerClient(realSession = false): BuyerProfileClient {
  return realSession ? createHttpBuyerClient() : mockBuyerClient
}
