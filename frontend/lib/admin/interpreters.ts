// 통역사 관리의 순수 로직 — CRUD 입력 검증 + 배정 규칙.
//
// 배정 규칙: **참가기업당 통역사 1명.** 한 통역사가 두 기업을 동시에 맡을 수 없으므로(현장 동시
// 진행 불가), 배정은 기업 기준 단일 점유로 다룬다 — 이미 다른 통역사가 맡은 기업에 배정하면
// 기존 배정이 해제되고 새 배정이 들어온다(무성 중복 대신 명시적 이관).

import type { AdminInterpreter } from "./types"

export type InterpreterError = "name-required" | "languages-required" | "contact-required"

export const INTERPRETER_ERROR_MESSAGES: Record<InterpreterError, string> = {
  "name-required": "통역사 이름을 입력해 주세요.",
  "languages-required": "담당 언어를 1개 이상 입력해 주세요.",
  "contact-required": "연락처(전화 또는 이메일)를 최소 하나 입력해 주세요.",
}

export interface InterpreterFormInput {
  name: string
  languages: string // 쉼표 구분 입력("영어, 베트남어")
  phone: string
  email: string
}

export type InterpreterValidation =
  | { valid: true; name: string; languages: string[]; phone: string | null; email: string | null }
  | { valid: false; errors: InterpreterError[] }

// 쉼표 구분 언어 입력 → 정규화 배열(공백 제거·빈 값 제거·중복 제거).
export function parseLanguages(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))]
}

export function validateInterpreter(input: InterpreterFormInput): InterpreterValidation {
  const name = input.name.trim()
  const languages = parseLanguages(input.languages)
  const phone = input.phone.trim()
  const email = input.email.trim()
  const errors: InterpreterError[] = []

  if (!name) errors.push("name-required")
  if (languages.length === 0) errors.push("languages-required")
  // 현장에서 연락이 닿아야 하므로 전화·이메일 중 최소 하나는 필수.
  if (!phone && !email) errors.push("contact-required")

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, name, languages, phone: phone || null, email: email || null }
}

// 배정 반영 — 대상 기업을 맡고 있던 다른 통역사는 자동 해제된다(기업당 1명 불변식 유지).
// organizationId가 null이면 해당 통역사의 배정만 푼다.
export function assignInterpreter(
  interpreters: AdminInterpreter[],
  interpreterId: string,
  organizationId: string | null,
  organizationName: string | null,
): AdminInterpreter[] {
  return interpreters.map((i) => {
    if (i.id === interpreterId) {
      return { ...i, assigned_org_id: organizationId, assigned_org_name: organizationName }
    }
    // 같은 기업을 맡고 있던 다른 통역사는 해제(이관).
    if (organizationId && i.assigned_org_id === organizationId) {
      return { ...i, assigned_org_id: null, assigned_org_name: null }
    }
    return i
  })
}

// 아직 통역사가 없는 기업 id 집합 — 배정 드롭다운에서 "미배정" 기업을 먼저 보여줄 때 쓴다.
export function assignedOrgIds(interpreters: AdminInterpreter[]): Set<string> {
  const ids = new Set<string>()
  for (const i of interpreters) if (i.assigned_org_id) ids.add(i.assigned_org_id)
  return ids
}

// backend app.bm.schemas.Lang(Literal["ko","en","zh","ja","ru","vi","other"]) 미러.
// 화면은 한글 라벨을 자유텍스트로 받지만(parseLanguages), InterpreterCreate/Update.languages는
// 이 코드만 받는다(extra=forbid에 걸리진 않지만 Literal 밖 값은 422) — 네트워크로 나가기 직전에
// 이 코드로 바꾼다. 로컬 상태(rows)는 한글 라벨 그대로 유지해 화면 표시는 바뀌지 않는다.
export type LangCode = "ko" | "en" | "zh" | "ja" | "ru" | "vi" | "other"

const LANG_CODES: readonly LangCode[] = ["ko", "en", "zh", "ja", "ru", "vi", "other"]

const LANG_LABEL_TO_CODE: Record<string, LangCode> = {
  "한국어": "ko",
  "영어": "en",
  "중국어": "zh",
  "일본어": "ja",
  "러시아어": "ru",
  "베트남어": "vi",
  "기타": "other",
}

// 화면이 채우는 값은 코드(backend InterpreterOut.languages가 코드로 내려주므로)일 수도, 사람이
// 새로 입력한 한글 라벨일 수도 있다 — 둘 다 받아 코드로 왕복 안전(round-trip safe)하게 수렴시킨다.
// 이미 코드값이면 그대로 통과(과거엔 여기서 누락돼 "vi" 같은 코드가 "other"로 깨졌다 — H6),
// 한글 라벨은 매핑, 매핑에도 없는 값(오탈자 등)만 "other"로 떨어뜨린다.
export function toLangCodes(labels: string[]): LangCode[] {
  return labels.map((label) => {
    if ((LANG_CODES as readonly string[]).includes(label)) return label as LangCode
    return LANG_LABEL_TO_CODE[label] ?? "other"
  })
}

const LANG_CODE_TO_LABEL = Object.fromEntries(
  Object.entries(LANG_LABEL_TO_CODE).map(([label, code]) => [code, label]),
) as Record<LangCode, string>

// Display only. Local optimistic rows may already contain a Korean label.
export function languageLabel(value: string): string {
  return LANG_CODE_TO_LABEL[value as LangCode] ?? value
}
