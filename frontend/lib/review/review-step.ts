// 리뷰 2-step 진행의 순수 로직 — 백엔드 review_capture 와 같은 외부 동작을 FE 에서 미러.
// UI 컴포넌트가 이 함수들로 단계 가시성·노쇼 분기를 결정한다(구현 세부 아닌 관찰 가능한 규칙).

import type { Step1Input, MeetingProceeded } from "./types"

export function isNoshow(proceeded: MeetingProceeded): boolean {
  return proceeded !== "proceeded"
}

// Step2(AI 보고문서 + Fit)는 '진행됨'일 때만 열린다.
export function step2Available(proceeded: MeetingProceeded): boolean {
  return proceeded === "proceeded"
}

// 노쇼 선택 시 만족도/Follow-up 을 비운다(D1: 나머지 건너뛰고 저장).
// 진행됨이면 입력값을 그대로 두되 만족도 범위를 보정한다.
export function normalizeStep1(input: Step1Input): Step1Input {
  if (isNoshow(input.proceeded)) {
    return {
      proceeded: input.proceeded,
      satisfaction: null,
      followUpIntent: null,
    }
  }
  const satisfaction =
    input.satisfaction != null && input.satisfaction >= 1 && input.satisfaction <= 5
      ? input.satisfaction
      : null
  return { ...input, satisfaction }
}

// Step1 완료 가능 여부(진행됨일 때 만족도·후속의향 입력을 권장).
export function canSubmitStep1(input: Step1Input): boolean {
  if (isNoshow(input.proceeded)) return true
  return input.satisfaction != null && input.followUpIntent != null
}

// 라벨은 messages/{ko,en}.json의 review.fit·review.followUp 네임스페이스에서 조립한다
// (호출부 components/review/review-flow.tsx가 useTranslations("review.fit"|"review.followUp")로
// t를 주입하고 t(value)를 그대로 호출한다 — 값(good/normal/bad, none/reviewing/yes)이 곧 메시지 키다).
