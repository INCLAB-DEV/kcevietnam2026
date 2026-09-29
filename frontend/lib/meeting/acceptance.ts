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

// t 미주입 호출부(단위 테스트 등 i18n 범위 밖) 보존용 한국어 폴백 — messages/ko.json의
// meeting.acceptance와 동일 문구를 유지한다(값이 바뀌면 양쪽 다 갱신).
const FALLBACK_KO: Record<string, string> = {
  immediateTitle: "미팅이 즉시 확정되었습니다!",
  immediateDescription: "{org}와(과)의 미팅이 일정에 추가되었습니다.",
  immediateStatus: "확정됨",
  pendingTitle: "미팅을 신청했습니다!",
  pendingDescription: "{org}에 미팅 요청을 보냈습니다. 상대방이 수락하면 알림을 보내드릴게요.",
  pendingStatus: "수락 대기 중",
}
const defaultT: Translator = (key, values) => {
  const template = FALLBACK_KO[key] ?? key
  return values?.org !== undefined ? template.replace("{org}", String(values.org)) : template
}

// t는 "meeting.acceptance" 네임스페이스(messages/{ko,en}.json) — 미주입 시 한국어 폴백.
export function acceptanceCopy(
  mode: AcceptanceMode,
  recipientName: string,
  t: Translator = defaultT
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
