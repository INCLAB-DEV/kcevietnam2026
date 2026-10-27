// 운영자 신청서 편집의 인메모리 전송 — 백엔드가 없는 목업 모드(dev 스위처·데모)와 테스트에서
// 실 전송(BFF fetch) 자리에 끼운다. 어댑터(application-client.ts)는 그대로 실 경로와 같은 코드가 돈다
// — 참가자 매핑·지움·부스 제외가 목업에서도 똑같이 적용된다.
//
// 백엔드 PATCH의 관찰 가능한 동작만 흉내 낸다: 본문에 담긴 키만 덮어쓰고(부분 저장), null은 그 칸을
// 지우고, 목록은 통째로 교체한다. 권한(관할·부스 master 전용)은 흉내 내지 않는다 — 그건 백엔드 소관이고,
// 화면 쪽 방어(부스 키 제외)는 어댑터 테스트가 본문으로 직접 확인한다.
//
// 저장소는 이 전송 인스턴스 안에만 산다(새로고침하면 초기화). 실연동에서는 쓰이지 않는다.

import type {
  ApiBuyerProfile,
  ApiExhibitorProfile,
  OperatorApplicationTransport,
  OperatorOrgDetailApi,
} from "./application-client"
import { OperatorRequestError } from "./application-client"
import type { UnavailableSlotGrid } from "./slot-grid"

function merge<T extends object>(current: T, body: Record<string, unknown>): T {
  return { ...current, ...body } as T
}

export function createMockOperatorTransport(
  seed: OperatorOrgDetailApi,
  slotGrid: UnavailableSlotGrid | null = null,
): OperatorApplicationTransport {
  let detail: OperatorOrgDetailApi = structuredClone(seed)

  return {
    async getDetail() {
      return { detail: structuredClone(detail), slotGrid }
    },

    async patchProfile(role, body) {
      if (role === "exhibitor") {
        if (!detail.exhibitor_profile) throw new OperatorRequestError(409, "role_mismatch")
        const next: ApiExhibitorProfile = merge(detail.exhibitor_profile, body)
        detail = { ...detail, exhibitor_profile: next }
        return structuredClone(next)
      }
      if (!detail.buyer_profile) throw new OperatorRequestError(409, "role_mismatch")
      const next: ApiBuyerProfile = merge(detail.buyer_profile, body)
      detail = { ...detail, buyer_profile: next }
      return structuredClone(next)
    },

    async patchUnavailableSlots(slots) {
      if (!detail.exhibitor_profile) throw new OperatorRequestError(409, "role_mismatch")
      const next: ApiExhibitorProfile = {
        ...detail.exhibitor_profile,
        unavailable_meeting_slots: [...slots],
      }
      detail = { ...detail, exhibitor_profile: next }
      return structuredClone(next)
    },
  }
}
