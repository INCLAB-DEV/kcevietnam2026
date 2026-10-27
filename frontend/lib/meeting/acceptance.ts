// acceptance-copy (F-MT-001 D1 / ADR-0005) — 진입 상태의 **표현(카피)**만 담당하는 모듈.
//
// 진입 상태 판정(accepted/proposed)은 ADR-0005 불변식이며 백엔드(FastAPI)가 단일 소유한다
// (ADR-0008). FE는 그 규칙을 재유도하지 않고, seam이 내려준 MeetingAvailability.acceptanceMode를
// 그대로 받아 이 모듈로 화면 카피만 만든다. (규칙은 backend/app/matching/acceptance_rule.py,
// 목업 단계의 스탠드인은 lib/meeting/mock-availability.ts.)
//
// AcceptanceMode는 seam contract 타입이라 ./types에 두고, 표현 모듈인 여기서 import한다.

import type { AcceptanceMode } from "./types"
import type { Translator } from "./meeting-projection"

// 신청 완료 화면 카피(F-MT-001 수락 모델 UI 반영). 받는 쪽 이름을 넣어 문장을 만든다.
export interface AcceptanceCopy {
  title: string
  description: string
  statusLabel: string
}

// t는 "meeting.acceptance" 네임스페이스(messages/{ko,en}.json) 번역기 — 필수 인자다(한국어 폴백
// 없음, meeting-projection.labelFor 주석 참고).
export function acceptanceCopy(
  mode: AcceptanceMode,
  recipientName: string,
  t: Translator
): AcceptanceCopy {
  if (mode === "immediate") {
    return {
      title: t("immediateTitle"),
      description: t("immediateDescription", { org: recipientName }),
      statusLabel: t("immediateStatus"),
    }
  }
  return {
    title: t("pendingTitle"),
    description: t("pendingDescription", { org: recipientName }),
    statusLabel: t("pendingStatus"),
  }
}
