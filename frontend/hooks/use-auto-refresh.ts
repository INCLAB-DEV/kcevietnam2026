"use client"

// 서버 컴포넌트 자동 갱신 — "상대가 수락했는데 내 캘린더엔 안 뜬다"를 없애기 위한 최소 장치.
//
// 배경: 이 앱에는 폴링도 SSE도 웹소켓도 없고, 수락/거절을 **누른 쪽 화면만** router.refresh()를
// 한다(components/meeting/meeting-detail-panel.tsx). 그래서 상대방 타임라인은 수동 새로고침 전까지
// 옛 상태 그대로다 — 발주사가 "승인은 되는데 캘린더에 반영 안 됨"으로 보고한 현상이 이것이다.
//
// 방식: 데이터 페칭 라이브러리를 들이지 않고 Next의 router.refresh()만 쓴다(서버 컴포넌트가 다시
// 그려지며 미팅·알림이 갱신된다). 트리거는 셋:
//   · 탭이 다시 보이게 될 때(visibilitychange → visible)
//   · 창 포커스 복귀(focus)
//   · 탭이 보이는 동안 가벼운 주기(기본 30초)
// 숨은 탭에서는 아무것도 하지 않는다 — 백그라운드 탭이 서버를 계속 때리지 않게.
//
// ⚠ 쿨다운(lastRefreshAt)은 **모듈 스코프**다. 한 화면에 이 훅을 쓰는 컴포넌트가 여럿 있어도
// (홈의 오늘 일정 카드 + 알림 카드) 같은 라우트를 동시에 여러 번 새로고침하지 않게 하려는 것이다.
// 인스턴스별 ref로 두면 복귀 순간 카드 수만큼 refresh가 나간다.

import { useEffect } from "react"
import { useRouter } from "next/navigation"

const DEFAULT_INTERVAL_MS = 30_000
// 연속 트리거(탭 복귀 시 visibilitychange와 focus가 연달아 발생) 합치기용 최소 간격.
const MIN_GAP_MS = 5_000

let lastRefreshAt = 0

export function useAutoRefresh(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  const router = useRouter()

  useEffect(() => {
    const refresh = () => {
      // 숨은 탭은 갱신하지 않는다(보이게 되는 순간 visibilitychange가 한 번 처리한다).
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      const now = Date.now()
      if (now - lastRefreshAt < MIN_GAP_MS) return
      lastRefreshAt = now
      router.refresh()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh()
    }

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", refresh)
    const timer = intervalMs > 0 ? window.setInterval(refresh, intervalMs) : null

    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", refresh)
      if (timer !== null) window.clearInterval(timer)
    }
  }, [router, intervalMs])
}
