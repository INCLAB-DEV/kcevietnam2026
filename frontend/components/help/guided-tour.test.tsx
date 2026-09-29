import { render, act } from "@/lib/test/render-with-intl"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// driver.js 를 스파이로 대체 — jsdom 엔 실제 레이아웃이 없어 구동 자체보다 "언제 몇 번 부르는지"를 검증한다.
type MockDriverConfig = {
  steps: unknown[]
  nextBtnText?: string
  doneBtnText?: string
}
const { driverMock, driveMock } = vi.hoisted(() => {
  const driveMock = vi.fn()
  const destroyMock = vi.fn() // driver 인스턴스가 노출해야 하는 메서드(정리용) — 팩토리 내부에서만 참조.
  const driverMock = vi.fn((config: MockDriverConfig) => {
    void config // 타입만 필요(calls[0][0] 추론용) — 값은 assert 에서 mock.calls 로 읽는다.
    return { drive: driveMock, destroy: destroyMock }
  })
  return { driverMock, driveMock }
})
vi.mock("driver.js", () => ({ driver: driverMock }))

// usePathname 을 시나리오별로 갈아끼운다.
let mockPathname = "/organizer"
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}))

import { GuidedTour } from "./guided-tour"
import { tourSeenStorageKey } from "@/lib/help/tour"

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  vi.useFakeTimers()
  mockPathname = "/organizer"
})

afterEach(() => {
  vi.useRealTimers()
})

describe("GuidedTour — 자동시작·재생 트리거", () => {
  it("투어가 있는 화면 첫 방문 시 자동 시작하고, seen 플래그를 찍는다", () => {
    render(<GuidedTour role="organizer" />)
    // 자동시작은 앵커 마운트를 기다리는 지연 후 실행된다.
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(driverMock).toHaveBeenCalledTimes(1)
    expect(driveMock).toHaveBeenCalledTimes(1)
    // 대시보드 투어는 5스텝(지표·0건·상태·시간대·사이드바) — driver 에 그대로 전달된다.
    const config = driverMock.mock.calls[0][0]
    expect(config.steps).toHaveLength(5)
    expect(config.nextBtnText).toBeTruthy()
    expect(config.doneBtnText).toBeTruthy()
    // 최초 1회 플래그 기록.
    expect(
      window.localStorage.getItem(tourSeenStorageKey("organizerDashboard"))
    ).toBe("1")
  })

  it("이미 본 화면은 자동 시작하지 않는다", () => {
    window.localStorage.setItem(tourSeenStorageKey("organizerDashboard"), "1")
    render(<GuidedTour role="organizer" />)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(driverMock).not.toHaveBeenCalled()
    expect(driveMock).not.toHaveBeenCalled()
  })

  it("투어가 없는 화면(홈)에서는 아무 것도 하지 않는다", () => {
    mockPathname = "/"
    render(<GuidedTour role="buyer" />)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(driverMock).not.toHaveBeenCalled()
  })

  it("'가이드 다시 보기'(replayNonce 증가)는 seen 플래그를 무시하고 강제 재생한다", () => {
    window.localStorage.setItem(tourSeenStorageKey("organizerDashboard"), "1")
    const { rerender } = render(<GuidedTour role="organizer" replayNonce={0} />)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    // 이미 봤으니 자동시작은 없음.
    expect(driverMock).not.toHaveBeenCalled()

    // 재생 트리거.
    act(() => {
      rerender(<GuidedTour role="organizer" replayNonce={1} />)
    })
    expect(driverMock).toHaveBeenCalledTimes(1)
    expect(driveMock).toHaveBeenCalledTimes(1)
  })
})
