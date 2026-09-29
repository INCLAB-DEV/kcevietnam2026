// 약관 동의 게이트(순수). 최초 진입자는 필수 약관에 모두 동의해야 진행할 수 있다(F-AU-001 D4).
// 선택 약관 미동의는 진행을 막지 않는다. 마스터/이력 기록·버전 스냅샷은 BE(consent-capture, #19) 소관.

import type { ConsentDocument } from "./auth-types"

export function requiredDocIds(docs: ConsentDocument[]): string[] {
  return docs.filter((d) => d.required).map((d) => d.id)
}

// 필수 약관이 모두 accepted에 들어있으면 제출(진행) 가능.
export function canSubmitConsent(docs: ConsentDocument[], acceptedIds: Iterable<string>): boolean {
  const accepted = new Set(acceptedIds)
  return requiredDocIds(docs).every((id) => accepted.has(id))
}
