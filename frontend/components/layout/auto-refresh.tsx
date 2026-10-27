"use client"

// 페이지 단위 자동 갱신 마운트 포인트 — 화면은 아무것도 그리지 않고 useAutoRefresh만 건다.
//
// 왜 카드 안이 아니라 여기인가: 홈에는 갱신이 필요한 카드가 둘(오늘 일정·알림)이고, 각 카드가
// 훅을 직접 걸면 같은 라우트에 대한 마운트가 둘이 된다(훅의 모듈 쿨다운이 중복 요청은 막지만,
// 카드들이 라우터에 의존하게 되어 순수 표시 컴포넌트라는 성격이 흐려지고 테스트도 라우터 모킹을
// 강요받는다). 서버 컴포넌트인 페이지가 이 한 줄을 마운트하는 편이 경계가 깨끗하다.

import { useAutoRefresh } from "@/hooks/use-auto-refresh"

export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  useAutoRefresh(intervalMs)
  return null
}
