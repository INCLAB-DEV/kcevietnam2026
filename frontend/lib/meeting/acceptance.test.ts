import { describe, it, expect } from "vitest"
import { acceptanceCopy } from "./acceptance"

// 진입 상태 판정(accepted/proposed)은 백엔드 소유(ADR-0005/0008)라 FE 테스트에서 사라졌다.
// seam이 내려준 mode로 화면 카피를 만드는 표현 로직만 여기서 검증한다.
// 규칙 자체의 커버리지는 mock-availability.test.ts(seam 어댑터)로 옮겼다.
describe("acceptanceCopy (F-MT-001 수락 모델 표현)", () => {
  it("immediate면 즉시 확정 카피", () => {
    const copy = acceptanceCopy("immediate", "테스트기업")
    expect(copy.title).toContain("즉시 확정")
    expect(copy.description).toContain("테스트기업")
    expect(copy.statusLabel).toBe("확정됨")
  })

  it("pending이면 수락 대기 카피", () => {
    const copy = acceptanceCopy("pending", "테스트기업")
    expect(copy.title).toContain("신청")
    expect(copy.description).toContain("테스트기업")
    expect(copy.statusLabel).toBe("수락 대기 중")
  })
})
