import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act } from "@testing-library/react"

import { useAutoRefresh } from "./use-auto-refresh"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

function Probe({ intervalMs }: { intervalMs?: number }) {
  useAutoRefresh(intervalMs)
  return null
}

// jsdom의 document.visibilityState는 읽기 전용이라 getter를 갈아끼운다.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
}

// 쿨다운(MIN_GAP_MS)은 **모듈 스코프**라 테스트 사이에도 이어진다(한 화면의 여러 카드가 같은
// 라우트를 중복 새로고침하지 않게 하려는 설계). useFakeTimers()는 매번 시계를 실제 현재시각으로
// 되돌리므로, 테스트마다 기준 시각을 1시간씩 앞으로 밀어 항상 쿨다운이 풀린 상태에서 시작한다.
let clock = new Date("2026-09-16T01:00:00Z").getTime()

describe("useAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clock += 3_600_000
    vi.setSystemTime(clock)
    refresh.mockClear()
    setVisibility("visible")
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("탭이 보이게 되면 새로고침한다", () => {
    render(<Probe intervalMs={0} />)
    refresh.mockClear()
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("복귀 시 visibilitychange + focus가 연달아 와도 한 번만 나간다(쿨다운)", () => {
    render(<Probe intervalMs={0} />)
    refresh.mockClear()
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("보이는 동안 주기적으로 새로고침한다", () => {
    render(<Probe intervalMs={30_000} />)
    refresh.mockClear()
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("숨은 탭에서는 주기 갱신도 하지 않는다", () => {
    render(<Probe intervalMs={30_000} />)
    refresh.mockClear()
    setVisibility("hidden")
    act(() => {
      vi.advanceTimersByTime(90_000)
      window.dispatchEvent(new Event("focus"))
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("언마운트하면 리스너·타이머를 정리한다", () => {
    const { unmount } = render(<Probe intervalMs={30_000} />)
    unmount()
    refresh.mockClear()
    act(() => {
      vi.advanceTimersByTime(90_000)
      window.dispatchEvent(new Event("focus"))
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})
